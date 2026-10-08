/**
 * Session-owned shell job manager.
 *
 * Each job is one detached shell process (its own process group) whose stdout and stderr
 * share a private log file. The manager owns the process independently of any tool call:
 * a caller can wait for it in the foreground, hand it off to the background, or stop it.
 *
 * Invariants:
 * - A job finishes exactly once (`finish()` is idempotent).
 * - Ownership moves foreground -> background only while the job is still running, so the
 *   foreground caller and the background completion callback never both report a result.
 * - The execution deadline (`timeoutMs`) is armed at launch and survives handoff.
 * - Disk use is bounded per job and per manager; finished-job bookkeeping is bounded.
 *
 * No Pi imports: this module is tested directly with real subprocesses.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

export const MAX_TIMER_MS = 2_147_483_647;

export type JobStatus =
	| "running"
	| "exited"
	| "stopped"
	| "aborted"
	| "timed_out"
	| "output_limit"
	| "shutdown"
	| "spawn_error";

export type StopReason = "stopped" | "aborted" | "timed_out" | "output_limit" | "shutdown";

export type JobOwner = "foreground" | "background";

export type JobChange = "start" | "handoff" | "stop" | "finish";

export interface JobSpec {
	/** Text handed to the shell. */
	command: string;
	/** Text shown to the model and user (defaults to `command`). */
	displayCommand?: string;
	/** Optional short human-readable label, for display only. */
	description?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Hard execution deadline in milliseconds, measured from launch. */
	timeoutMs?: number;
	/** Start owned by the background (explicit `run_in_background`). */
	background?: boolean;
}

export interface JobInfo {
	id: string;
	command: string;
	description?: string;
	cwd: string;
	status: JobStatus;
	owner: JobOwner;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	startedAt: number;
	endedAt?: number;
	timeoutMs?: number;
	logPath: string;
	logBytes: number;
	logDeleted: boolean;
	delivered: boolean;
	pid?: number;
}

export interface TailResult {
	text: string;
	/** Output before the returned text was left out. */
	truncated: boolean;
	totalBytes: number;
}

export interface JobManagerOptions {
	/** Private directory for this manager's logs. Created with mode 0700 if missing. */
	logDir: string;
	shell: string;
	shellArgs: string[];
	/** Pass the command on stdin instead of argv (Pi's ShellConfig.commandTransport). */
	commandOnStdin?: boolean;
	maxRunning?: number;
	maxCompleted?: number;
	maxLogBytes?: number;
	maxTotalLogBytes?: number;
	/** Delay between SIGTERM and SIGKILL when stopping a process group. */
	killGraceMs?: number;
	monitorIntervalMs?: number;
	/** Do not keep the Node event loop alive for background jobs (the extension sets this). */
	unref?: boolean;
	/** Called once when a background-owned job finishes and its result was not yet delivered. */
	onBackgroundComplete?: (job: Job) => void;
	/** Observer for display state: launch, handoff, stop request, finish. Never affects ownership. */
	onChange?: (job: Job, change: JobChange) => void;
	now?: () => number;
}

export class Job {
	readonly id: string;
	readonly command: string;
	readonly description: string | undefined;
	readonly cwd: string;
	readonly logPath: string;
	readonly startedAt: number;
	readonly timeoutMs: number | undefined;
	status: JobStatus = "running";
	owner: JobOwner;
	exitCode: number | null = null;
	signal: NodeJS.Signals | null = null;
	error: string | undefined;
	endedAt: number | undefined;
	logBytes = 0;
	logDeleted = false;
	/** The model has received this job's completion (foreground result, wait/status, or notification). */
	delivered = false;
	pid: number | undefined;
	/** Resolves with the final info when the job finishes. Never rejects. */
	readonly done: Promise<JobInfo>;
	/** Resolves true once the process spawned, false if it failed to launch. */
	readonly launched: Promise<boolean>;

	/** First stop reason requested; authoritative for the final status once set. */
	stopReason: StopReason | undefined;
	/** The process group was signalled and may still have members to SIGKILL. Independent of `status`. */
	cleanupPending = false;
	/** @internal */ cleanupTimer: NodeJS.Timeout | undefined;
	/** @internal */ child: ChildProcess | undefined;
	/** @internal */ deadlineTimer: NodeJS.Timeout | undefined;
	/** @internal */ resolveDone!: (info: JobInfo) => void;
	/** @internal */ resolveLaunched!: (ok: boolean) => void;

	constructor(id: string, spec: JobSpec, logPath: string, startedAt: number) {
		this.id = id;
		this.command = spec.displayCommand ?? spec.command;
		this.description = spec.description;
		this.cwd = spec.cwd;
		this.logPath = logPath;
		this.startedAt = startedAt;
		this.timeoutMs = spec.timeoutMs;
		this.owner = spec.background ? "background" : "foreground";
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
		this.launched = new Promise((resolve) => {
			this.resolveLaunched = resolve;
		});
	}

	get running(): boolean {
		return this.status === "running";
	}

	info(): JobInfo {
		return {
			id: this.id,
			command: this.command,
			description: this.description,
			cwd: this.cwd,
			status: this.status,
			owner: this.owner,
			exitCode: this.exitCode,
			signal: this.signal,
			error: this.error,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			timeoutMs: this.timeoutMs,
			logPath: this.logPath,
			logBytes: this.logBytes,
			logDeleted: this.logDeleted,
			delivered: this.delivered,
			pid: this.pid,
		};
	}
}

export function validateTimeoutMs(timeoutMs: number | undefined): void {
	if (timeoutMs === undefined) return;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid timeout: must be a finite positive number");
	if (timeoutMs > MAX_TIMER_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMER_MS / 1000} seconds`);
}

function signalExitCode(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	return 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0);
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			process.kill(pid, signal);
		} catch {}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Whether any process is still in the group (zombies included). */
function groupAlive(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const TRIM_HEADER = (dropped: number) => `[pi-async-bash: ${dropped} earlier bytes removed; output exceeded the log limit]\n`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: same set Pi's sanitizeBinaryOutput removes
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g;

/** Make raw terminal output readable: drop escapes, apply carriage-return overwrites, drop control bytes. */
export function cleanOutput(raw: string): string {
	return raw
		.replace(ANSI_RE, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const cr = line.lastIndexOf("\r", line.length - 2);
			return (cr >= 0 ? line.slice(cr + 1) : line).replace(/\r$/, "");
		})
		.join("\n")
		.replace(CONTROL_RE, "");
}

/** Read the end of a log file: at most `maxBytes` bytes and `maxLines` lines. */
export function readLogTail(path: string, maxBytes: number, maxLines: number): TailResult {
	let fd: number;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch {
		return { text: "", truncated: false, totalBytes: 0 };
	}
	try {
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		const start = size - length;
		const buf = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = fs.readSync(fd, buf, read, length - read, start + read);
			if (n <= 0) break;
			read += n;
		}
		let text = buf.subarray(0, read).toString("utf8");
		let truncated = start > 0;
		if (truncated) {
			const nl = text.indexOf("\n");
			// Drop the partial first line, unless the window holds a single enormous line.
			if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
			else text = text.replace(/^\uFFFD+/, "");
		}
		text = cleanOutput(text);
		const lines = text.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		if (lines.length > maxLines) {
			lines.splice(0, lines.length - maxLines);
			truncated = true;
		}
		return { text: lines.join("\n"), truncated, totalBytes: size };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Create a private per-session log directory under `base`.
 * The base must be a real directory owned by the current user; it is tightened to 0700.
 */
export function createSessionLogDir(base: string, sessionId: string): string {
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const st = fs.lstatSync(base);
	if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Log directory is not a directory: ${base}`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
		throw new Error(`Log directory is owned by another user: ${base}`);
	}
	if ((st.mode & 0o077) !== 0) fs.chmodSync(base, 0o700);
	const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "session";
	return fs.mkdtempSync(join(base, `${safe}-`));
}

/** Delete session log directories under `base` not modified for `maxAgeMs`. Best effort. */
export function pruneSessionLogDirs(base: string, maxAgeMs: number, keep: string | undefined, now = Date.now()): void {
	let names: string[];
	try {
		names = fs.readdirSync(base);
	} catch {
		return;
	}
	for (const name of names) {
		const dir = join(base, name);
		if (dir === keep) continue;
		try {
			const st = fs.lstatSync(dir);
			if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

export class JobManager {
	readonly logDir: string;
	private readonly opts: Required<Omit<JobManagerOptions, "onBackgroundComplete" | "commandOnStdin" | "onChange">> &
		Pick<JobManagerOptions, "onBackgroundComplete" | "commandOnStdin" | "onChange">;
	private readonly jobs = new Map<string, Job>();
	/** Cleanup must outlive result release and completed-job retention eviction. */
	private readonly pendingGroupCleanup = new Set<Job>();
	private counter = 0;
	private disposed = false;
	private monitor: NodeJS.Timeout | undefined;
	private readonly exitHook = () => this.killAllSync();
	private exitHookInstalled = false;

	constructor(options: JobManagerOptions) {
		this.opts = {
			maxRunning: 8,
			maxCompleted: 50,
			maxLogBytes: 64 * 1024 * 1024,
			maxTotalLogBytes: 256 * 1024 * 1024,
			killGraceMs: 2000,
			monitorIntervalMs: 500,
			unref: false,
			now: Date.now,
			...options,
		};
		this.opts.maxLogBytes = Math.min(this.opts.maxLogBytes, this.opts.maxTotalLogBytes);
		this.logDir = options.logDir;
		fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	runningCount(): number {
		let n = 0;
		for (const job of this.jobs.values()) if (job.running) n++;
		return n;
	}

	start(spec: JobSpec): Job {
		if (this.disposed) throw new Error("The shell job manager for this session has shut down.");
		validateTimeoutMs(spec.timeoutMs);
		if (this.runningCount() >= this.opts.maxRunning) {
			throw new Error(
				`Too many running shell jobs (limit ${this.opts.maxRunning}). Stop or wait for one with bash_job first.`,
			);
		}
		let cwdStat: fs.Stats | undefined;
		try {
			cwdStat = fs.statSync(spec.cwd);
		} catch {}
		if (!cwdStat?.isDirectory()) throw new Error(`Working directory does not exist: ${spec.cwd}`);

		const id = `job-${++this.counter}-${randomBytes(2).toString("hex")}`;
		const logPath = join(this.logDir, `${id}.log`);
		const fd = fs.openSync(
			logPath,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				fs.constants.O_APPEND |
				(fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		const job = new Job(id, spec, logPath, this.opts.now());
		this.jobs.set(id, job);
		this.installExitHook();

		let child: ChildProcess;
		try {
			child = spawn(this.opts.shell, this.opts.commandOnStdin ? this.opts.shellArgs : [...this.opts.shellArgs, spec.command], {
				cwd: spec.cwd,
				env: spec.env ?? process.env,
				detached: process.platform !== "win32",
				stdio: [this.opts.commandOnStdin ? "pipe" : "ignore", fd, fd],
				windowsHide: true,
			});
		} catch (err) {
			fs.closeSync(fd);
			this.finish(job, "spawn_error", null, null, err instanceof Error ? err.message : String(err));
			return job;
		}
		// The child holds its own copy of the descriptor.
		fs.closeSync(fd);
		job.child = child;
		job.pid = child.pid;
		if (this.opts.commandOnStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(spec.command);
		}
		child.once("spawn", () => job.resolveLaunched(true));
		child.once("error", (err) => {
			// "error" without a pid means the shell never started; later errors (failed kill) are ignored.
			if (!child.pid) this.finish(job, "spawn_error", null, null, err.message);
		});
		child.once("exit", (code, signal) => this.onExit(job, code, signal));
		// A foreground caller is awaiting the job, so keep the event loop alive until handoff.
		if (this.opts.unref && job.owner === "background") child.unref();

		if (spec.timeoutMs !== undefined) {
			job.deadlineTimer = setTimeout(() => this.requestStop(job, "timed_out"), spec.timeoutMs);
			if (this.opts.unref) job.deadlineTimer.unref();
		}
		this.ensureMonitor();
		this.notifyChange(job, "start");
		return job;
	}

	private notifyChange(job: Job, change: JobChange): void {
		if (!this.opts.onChange) return;
		try {
			this.opts.onChange(job, change);
		} catch {}
	}

	/**
	 * Move a running foreground job to the background. Returns false when the job already
	 * finished; the caller then reports the completion itself.
	 */
	handoff(job: Job): boolean {
		if (!job.running) return false;
		job.owner = "background";
		if (this.opts.unref) job.child?.unref();
		this.notifyChange(job, "handoff");
		return true;
	}

	/**
	 * Stop a job's process group. The first reason wins and becomes the final status, even if the
	 * shell then exits 0. SIGTERM first, SIGKILL to the group after the grace period unless the group
	 * is already empty; an `output_limit` stop uses SIGKILL at once to limit overshoot. Repeated
	 * calls do not send more signals or arm more timers.
	 */
	requestStop(job: Job, reason: StopReason): Promise<JobInfo> {
		if (!job.running || job.stopReason) return job.done;
		job.stopReason = reason;
		const pid = job.pid;
		if (!pid) return job.done;
		job.cleanupPending = true;
		this.pendingGroupCleanup.add(job);
		this.installExitHook();
		if (reason === "output_limit") {
			killGroup(pid, "SIGKILL");
			// Still verify the group is empty once the shell exits (see onExit).
		} else {
			killGroup(pid, "SIGTERM");
		}
		job.cleanupTimer = setTimeout(() => this.finishGroupCleanup(job, true), reason === "output_limit" ? 0 : this.opts.killGraceMs);
		job.cleanupTimer.unref();
		this.notifyChange(job, "stop");
		return job.done;
	}

	/**
	 * End a pending group cleanup. With `force`, SIGKILL whatever is still in the group.
	 * Signals go only to a group we signalled within the grace period; the PGID cannot be reused
	 * while any member exists, and the cleanup is dropped as soon as the group is seen empty.
	 */
	private finishGroupCleanup(job: Job, force: boolean): void {
		if (!job.cleanupPending) return;
		if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
		job.cleanupTimer = undefined;
		if (force && job.pid && groupAlive(job.pid)) killGroup(job.pid, "SIGKILL");
		job.cleanupPending = false;
		this.pendingGroupCleanup.delete(job);
		this.removeExitHookIfIdle();
	}

	/** Wait up to `ms` for a job to finish. Resolves true if it finished. */
	async wait(job: Job, ms: number, signal?: AbortSignal): Promise<boolean> {
		if (!job.running) return true;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<boolean>((resolve) => {
				job.done.then(() => resolve(true));
				timer = setTimeout(() => resolve(!job.running), Math.min(Math.max(0, ms), MAX_TIMER_MS));
				if (signal) {
					onAbort = () => resolve(!job.running);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		} finally {
			if (timer) clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Jobs whose process or process group still needs this manager (running or group cleanup pending). */
	activeCount(): number {
		const active = new Set(this.pendingGroupCleanup);
		for (const job of this.jobs.values()) if (job.running) active.add(job);
		return active.size;
	}

	tail(job: Job, maxBytes: number, maxLines: number): TailResult {
		if (job.logDeleted) return { text: "", truncated: false, totalBytes: job.logBytes };
		return readLogTail(job.logPath, maxBytes, maxLines);
	}

	/**
	 * Delete a finished job's log and forget it (a foreground completion whose output fit).
	 * Jobs whose log is still referenced must stay registered so their logs remain in the disk accounting.
	 */
	release(job: Job): void {
		if (job.running) return;
		this.deleteLog(job);
		this.jobs.delete(job.id);
	}

	/**
	 * Stop every running job and refuse new ones. Idempotent. Logs stay on disk.
	 * The process exit hook remains until every signalled process group is confirmed empty or
	 * SIGKILLed. Descendants left behind by jobs that already exited normally are not touched.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const job of this.jobs.values()) {
			if (job.running) void this.requestStop(job, "shutdown");
		}
		this.stopMonitorIfIdle();
		this.removeExitHookIfIdle();
	}

	/** Synchronous last resort on process exit: SIGKILL running jobs and groups still being cleaned up. */
	killAllSync(): void {
		const active = new Set(this.pendingGroupCleanup);
		for (const job of this.jobs.values()) if (job.running) active.add(job);
		for (const job of active) killGroup(job.pid, "SIGKILL");
	}

	private onExit(job: Job, code: number | null, signal: NodeJS.Signals | null): void {
		this.finish(job, job.stopReason ?? "exited", code ?? signalExitCode(signal), signal);
		// The shell is gone; if nothing else is in its group, no delayed SIGKILL is needed.
		if (job.cleanupPending && job.pid && !groupAlive(job.pid)) this.finishGroupCleanup(job, false);
	}

	private finish(job: Job, status: JobStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void {
		if (!job.running) return;
		job.endedAt = this.opts.now();
		job.exitCode = exitCode;
		job.signal = signal;
		job.error = error;
		if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
		job.deadlineTimer = undefined;
		job.child = undefined;
		try {
			job.logBytes = fs.statSync(job.logPath).size;
		} catch {}
		// Output written between monitor ticks (or by a command that exited before the first tick).
		if (job.logBytes > this.opts.maxLogBytes) {
			if (status === "exited") status = "output_limit";
			this.trimLog(job);
		}
		job.status = status;
		job.resolveLaunched(status !== "spawn_error");
		// Disk accounting and retention run before anyone observes the result.
		this.enforceRetention();
		this.checkOutputLimits();
		const info = job.info();
		job.resolveDone(info);
		if (job.owner === "background" && !job.delivered && !this.disposed) {
			try {
				this.opts.onBackgroundComplete?.(job);
			} catch {}
		}
		this.notifyChange(job, "finish");
		this.stopMonitorIfIdle();
		this.removeExitHookIfIdle();
	}

	/** Keep only the last `maxLogBytes` of a finished job's log, behind a one-line marker. */
	private trimLog(job: Job): void {
		try {
			const size = fs.statSync(job.logPath).size;
			if (size <= this.opts.maxLogBytes) return;
			const header = Buffer.from(TRIM_HEADER(size));
			const keep = Math.max(0, this.opts.maxLogBytes - header.length);
			const dropped = size - keep;
			const marker = Buffer.from(TRIM_HEADER(dropped));
			const buf = Buffer.alloc(keep);
			const fd = fs.openSync(job.logPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				fs.readSync(fd, buf, 0, keep, size - keep);
			} finally {
				fs.closeSync(fd);
			}
			const tmp = `${job.logPath}.trim`;
			fs.writeFileSync(tmp, Buffer.concat([marker, buf]), { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, job.logPath);
			job.logBytes = marker.length + keep;
		} catch {
			// If trimming fails, the total budget still deletes the log.
		}
	}

	private deleteLog(job: Job): void {
		if (job.logDeleted) return;
		try {
			fs.unlinkSync(job.logPath);
		} catch {}
		job.logDeleted = true;
	}

	private enforceRetention(): void {
		const finished = this.list()
			.filter((job) => !job.running)
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (finished.length > this.opts.maxCompleted) {
			const job = finished.shift()!;
			this.deleteLog(job);
			this.jobs.delete(job.id);
		}
	}

	/** Enforce per-job and total log size limits. Exposed for tests. */
	checkOutputLimits(): void {
		let total = 0;
		const running: { job: Job; size: number }[] = [];
		for (const job of this.jobs.values()) {
			if (job.logDeleted) continue;
			let size = job.logBytes;
			if (job.running) {
				try {
					size = fs.statSync(job.logPath).size;
				} catch {
					size = 0;
				}
				job.logBytes = size;
				if (size > this.opts.maxLogBytes) void this.requestStop(job, "output_limit");
				else running.push({ job, size });
			}
			total += size;
		}
		if (total <= this.opts.maxTotalLogBytes) return;
		// Oldest first, logs the model already saw before logs it has not.
		const finished = this.list()
			.filter((job) => !job.running && !job.logDeleted)
			.sort((a, b) => Number(b.delivered) - Number(a.delivered) || (a.endedAt ?? 0) - (b.endedAt ?? 0));
		for (const job of finished) {
			if (total <= this.opts.maxTotalLogBytes) return;
			total -= job.logBytes;
			this.deleteLog(job);
		}
		if (total <= this.opts.maxTotalLogBytes) return;
		running.sort((a, b) => b.size - a.size);
		const largest = running.find(({ job }) => !job.stopReason);
		if (largest) void this.requestStop(largest.job, "output_limit");
	}

	private ensureMonitor(): void {
		if (this.monitor) return;
		this.monitor = setInterval(() => this.checkOutputLimits(), this.opts.monitorIntervalMs);
		this.monitor.unref();
	}

	private stopMonitorIfIdle(): void {
		if (this.monitor && this.runningCount() === 0) {
			clearInterval(this.monitor);
			this.monitor = undefined;
		}
	}

	private installExitHook(): void {
		if (this.exitHookInstalled) return;
		process.on("exit", this.exitHook);
		this.exitHookInstalled = true;
	}

	private removeExitHookIfIdle(): void {
		if (this.exitHookInstalled && this.activeCount() === 0) {
			process.off("exit", this.exitHook);
			this.exitHookInstalled = false;
		}
	}
}
