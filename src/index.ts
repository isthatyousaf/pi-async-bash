/**
 * pi-async-bash: replaces Pi's `bash` tool with one whose processes are owned by a session job
 * manager. A command returns when it finishes, or is handed off to the background after a short
 * user-configured foreground budget (default 2 s). Background completion is delivered to the model
 * once, through session boundaries or a triggered turn. `bash_job` lists, waits for, and stops jobs.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { waitForBackgroundResult } from "./headless.ts";

type ExtensionMode = ExtensionContext["mode"];
import {
	createSessionLogDir,
	type Job,
	type JobInfo,
	JobManager,
	type JobManagerOptions,
	MAX_TIMER_MS,
	pruneSessionLogDirs,
} from "./manager.ts";
import { JobBoard, type JobSource } from "./ui/board.ts";
import { type BashDetails, createBashRenderers } from "./ui/bash-row.ts";
import type { CompletedJob } from "./ui/completion.ts";
import { BACKGROUND_KEY, expandKeyText, installUi, JOBS_KEY } from "./ui/install.ts";

export type { BashDetails } from "./ui/bash-row.ts";

export const NOTIFY_CUSTOM_TYPE = "bash-job-complete";
const MODEL_TAIL_BYTES = 50 * 1024;
const MODEL_TAIL_LINES = 2000;
const NOTIFY_TAIL_BYTES = 2 * 1024;
const NOTIFY_TAIL_LINES = 20;
const NOTIFY_MAX_JOBS_DETAILED = 8;
const UPDATE_INTERVAL_MS = 250;
/** Live (partial) output sent while a foreground command runs; display only, not model-facing. */
const LIVE_TAIL_BYTES = 16 * 1024;
const LIVE_TAIL_LINES = 200;
const IDLE_FLUSH_DELAY_MS = 200;
const IDLE_RETRY_MS = 1000;
const WAIT_DEFAULT_SECONDS = 30;
const WAIT_MAX_SECONDS = 600;
const STOP_WAIT_MS = 5000;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FOREGROUND_MS = 2000;

export interface AsyncBashConfig {
	/** Automatic handoff budget in ms; null waits for completion (explicit background still works). */
	foregroundMs: number | null;
	logBase: string;
	manager: Partial<Omit<JobManagerOptions, "logDir" | "onBackgroundComplete">>;
}

function parseIntEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
	return n;
}

/** Parse a foreground budget: positive integer ms, or "0"/"off" for no automatic handoff. */
export function parseForegroundMs(raw: string | undefined): number | null | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = raw.trim().toLowerCase();
	if (value === "off" || value === "0") return null;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > MAX_TIMER_MS) {
		throw new Error(`foreground budget must be an integer number of milliseconds or "off", got "${raw}"`);
	}
	return n;
}

/**
 * Resolve user configuration. Precedence: `--bash-foreground-ms` flag, then
 * `PI_ASYNC_BASH_FOREGROUND_MS`, then the mode default (2000 ms; off in one-shot print/json mode,
 * where Pi exits after the run and would kill handed-off jobs).
 */
export function resolveConfig(flag: string | undefined, mode: ExtensionMode | undefined, env = process.env): AsyncBashConfig {
	// null ("off") is a deliberate value, so only undefined falls through to the next source.
	const fromFlag = parseForegroundMs(flag);
	const fromUser = fromFlag !== undefined ? fromFlag : parseForegroundMs(env.PI_ASYNC_BASH_FOREGROUND_MS);
	const oneShot = mode === "print" || mode === "json";
	const foregroundMs = fromUser !== undefined ? fromUser : oneShot ? null : DEFAULT_FOREGROUND_MS;
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const mb = (name: string) => {
		const v = parseIntEnv(name, env);
		return v === undefined ? undefined : v * 1024 * 1024;
	};
	const manager: AsyncBashConfig["manager"] = {};
	const maxRunning = parseIntEnv("PI_ASYNC_BASH_MAX_JOBS", env);
	if (maxRunning) manager.maxRunning = maxRunning;
	const maxLog = mb("PI_ASYNC_BASH_MAX_LOG_MB");
	if (maxLog) manager.maxLogBytes = maxLog;
	const maxTotal = mb("PI_ASYNC_BASH_SESSION_LOG_MB");
	if (maxTotal) manager.maxTotalLogBytes = maxTotal;
	return {
		foregroundMs,
		logBase: env.PI_ASYNC_BASH_LOG_DIR || join(tmpdir(), `pi-async-bash-${uid}`),
		manager,
	};
}

export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite positive number of seconds");
	}
	const ms = Math.ceil(timeout * 1000);
	if (ms > MAX_TIMER_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMER_MS / 1000} seconds`);
	return ms;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	description: Type.Optional(
		Type.String({
			description: "Optional short label (about 5-10 words) saying what the command does, shown to the user in place of long commands",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Hard deadline in seconds (optional, no default). The process is killed when it expires, also after it moved to the background.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Start the command as a background job and return right away with its job ID and log path. Use for servers, watchers, and long builds.",
		}),
	),
});

const bashOutputSchema = Type.Object({
	status: Type.String({ description: "running, exited, timed_out, output_limit, stopped" }),
	job_id: Type.Optional(Type.String()),
	output: Type.String({ description: "End of combined stdout and stderr" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String()),
	exit_code: Type.Optional(Type.Number()),
	wall_time_seconds: Type.Number(),
});

const jobSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("stop")], {
		description: "list: all jobs; status: one job; wait: block until a job finishes or the wait times out; stop: kill a job's process tree",
	}),
	job_id: Type.Optional(Type.String({ description: "Job ID from bash (required except for list)" })),
	timeout: Type.Optional(
		Type.Number({
			description: `For wait: seconds to wait before returning the current status (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}). The job keeps running.`,
		}),
	),
});

function seconds(ms: number): string {
	return `${Math.round(ms / 100) / 10}s`;
}

function oneLine(text: string, max = 200): string {
	const first = text.split("\n")[0] ?? "";
	const multi = text.includes("\n");
	return first.length > max ? `${first.slice(0, max)}…` : multi ? `${first} …` : first;
}

function statusPhrase(info: JobInfo, stoppedByUser = false): string {
	switch (info.status) {
		case "running":
			return "is still running";
		case "exited":
			return `exited with code ${info.exitCode}`;
		case "timed_out":
			return `was killed after its ${info.timeoutMs! / 1000}-second timeout`;
		case "output_limit":
			return `exceeded the output log limit${info.signal ? " and was killed" : ""} (log trimmed to its last part)`;
		case "stopped":
			return stoppedByUser ? "was stopped by the user" : "was stopped";
		case "aborted":
			return "was aborted";
		case "shutdown":
			return "was stopped because the session ended";
		case "spawn_error":
			return `failed to start: ${info.error}`;
	}
}

function errorForStatus(info: JobInfo): string | undefined {
	switch (info.status) {
		case "exited":
			return info.exitCode === 0 ? undefined : `Command exited with code ${info.exitCode}`;
		case "timed_out":
			return `Command timed out after ${info.timeoutMs! / 1000} seconds`;
		case "output_limit":
			return `Command output exceeded the log size limit${info.signal ? "; the command was killed" : ""}`;
		case "stopped":
			return "Command stopped";
		case "aborted":
			return "Command aborted";
		case "shutdown":
			return "Command stopped because the session ended";
		case "spawn_error":
			return `Command failed to start: ${info.error}`;
		case "running":
			return undefined;
	}
}

export default function asyncBash(pi: ExtensionAPI): void {
	pi.registerFlag("bash-foreground-ms", {
		description: 'pi-async-bash: ms a bash call waits before moving to the background ("off" to wait for completion)',
		type: "string",
	});

	let config: AsyncBashConfig | undefined;
	let manager: JobManager | undefined;
	let managerSessionId: string | undefined;
	let ctxRef: ExtensionContext | undefined;
	let disposed = false;
	let pending: Job[] = [];
	let flushTimer: NodeJS.Timeout | undefined;
	/** The last run was aborted by the user; until a new run starts, completions are recorded without starting a turn. */
	let lastRunAborted = false;
	/** Display-side view of the live session's jobs. Never owns processes or delivery. */
	const board = new JobBoard();
	/** Jobs the user stopped from the jobs panel (phrased as such for the model). */
	const userStopped = new Set<string>();

	const getConfig = (ctx?: ExtensionContext): AsyncBashConfig => {
		if (!config) {
			const flag = pi.getFlag("bash-foreground-ms");
			config = resolveConfig(typeof flag === "string" ? flag : undefined, ctx?.mode ?? ctxRef?.mode);
		}
		return config;
	};

	const shutdownManager = () => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = undefined;
		pending = [];
		manager?.dispose();
		manager = undefined;
		managerSessionId = undefined;
		userStopped.clear();
		board.reset();
	};

	const sessionIdOf = (ctx: ExtensionContext): string => {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return "unknown";
		}
	};

	/**
	 * Session guard for every use of the manager (launch, job controls, delivery): returns the
	 * manager only if it belongs to `ctx`'s session, retiring one from another session. Never creates.
	 */
	const managerFor = (ctx: ExtensionContext | undefined): JobManager | undefined => {
		if (disposed || !ctx) return undefined;
		if (manager && managerSessionId !== sessionIdOf(ctx)) shutdownManager();
		return manager;
	};

	const ensureManager = (ctx: ExtensionContext): JobManager => {
		if (disposed) throw new Error("pi-async-bash: this session has shut down");
		const sessionId = sessionIdOf(ctx);
		const existing = managerFor(ctx);
		if (existing) return existing;
		{
			const cfg = getConfig(ctx);
			const settings = pi.getSettings();
			const shell = getShellConfig(settings.shellPath);
			const logDir = createSessionLogDir(cfg.logBase, sessionId);
			pruneSessionLogDirs(cfg.logBase, LOG_RETENTION_MS, logDir);
			const owner = { sessionId };
			const created = new JobManager({
				...cfg.manager,
				logDir,
				shell: shell.shell,
				shellArgs: shell.args,
				commandOnStdin: shell.commandTransport === "stdin",
				unref: true,
				onBackgroundComplete: (job) => {
					// Generation guard: only the manager of the live session may deliver.
					if (disposed || managerSessionId !== owner.sessionId) return;
					pending.push(job);
					scheduleIdleFlush(IDLE_FLUSH_DELAY_MS);
				},
				onChange: (job) => {
					if (disposed || managerSessionId !== owner.sessionId) return;
					board.changed(job.id);
				},
			});
			manager = created;
			managerSessionId = sessionId;
			board.setSource(jobSource(created));
			return created;
		}
	};

	/** What the UI may see: running jobs and retained background jobs (not truncated foreground results). */
	const jobSource = (mgr: JobManager): JobSource => {
		const visible = (job: Job | undefined) => (job && (job.running || job.owner === "background") ? job : undefined);
		return {
			list: () => (mgr.isDisposed ? [] : mgr.list().filter((job) => visible(job)).map((job) => job.info())),
			get: (id) => visible(mgr.get(id))?.info(),
			tail: (id, maxBytes, maxLines) => {
				const job = visible(mgr.get(id));
				return job ? mgr.tail(job, maxBytes, maxLines) : undefined;
			},
		};
	};

	/** Take undelivered completions and mark them delivered. */
	const takePending = (): Job[] => {
		const jobs = pending.filter((job) => !job.delivered);
		pending = [];
		for (const job of jobs) job.delivered = true;
		return jobs;
	};

	const formatCompletion = (job: Job, tailBytes: number, tailLines: number): string => {
		const info = job.info();
		const elapsed = (info.endedAt ?? Date.now()) - info.startedAt;
		const lines = [
			`Background job ${info.id} ${statusPhrase(info, userStopped.has(info.id))} after ${seconds(elapsed)}.`,
			`Command: ${oneLine(info.command)}`,
		];
		if (!info.logDeleted) lines.push(`Full output log: ${info.logPath}`);
		if (manager && tailLines > 0) {
			const tail = manager.tail(job, tailBytes, tailLines);
			lines.push(tail.text ? `Last output${tail.truncated ? " (truncated, read the log for more)" : ""}:\n${tail.text}` : "No output.");
		}
		return lines.join("\n");
	};

	const buildNotice = (jobs: Job[]) => {
		const detailed = jobs.slice(0, NOTIFY_MAX_JOBS_DETAILED);
		const rest = jobs.slice(NOTIFY_MAX_JOBS_DETAILED);
		const parts = detailed.map((job) => formatCompletion(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES));
		if (rest.length > 0) {
			parts.push(
				`Also finished: ${rest.map((job) => `${job.id} (${statusPhrase(job.info())})`).join(", ")}. Use bash_job status for details.`,
			);
		}
		const header = jobs.length === 1 ? "[bash background job finished]" : `[${jobs.length} bash background jobs finished]`;
		// Display-only copy of each job's tail for the transcript renderer; the model reads `content`.
		const details: { jobs: CompletedJob[] } = {
			jobs: jobs.map((job) => {
				const tail = manager && !job.logDeleted ? manager.tail(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES).text : "";
				return { ...job.info(), outputTail: tail };
			}),
		};
		return {
			customType: NOTIFY_CUSTOM_TYPE,
			content: `${header}\n${parts.join("\n\n")}`,
			display: true,
			details,
		};
	};

	const safeSend = (message: ReturnType<typeof buildNotice>, triggerTurn: boolean) => {
		if (disposed) return;
		try {
			pi.sendMessage(message, { triggerTurn });
		} catch {
			// Stale runtime after session replacement: drop rather than leak into another session.
		}
	};

	/** Deliver completions while the agent is idle; while busy, the boundary handlers deliver them. */
	const scheduleIdleFlush = (delay: number) => {
		if (flushTimer || disposed) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			const ctx = ctxRef;
			if (!managerFor(ctx) || pending.every((job) => job.delivered)) {
				pending = [];
				return;
			}
			let idle = false;
			try {
				idle = ctx!.isIdle();
			} catch {
				return;
			}
			if (!idle) {
				scheduleIdleFlush(IDLE_RETRY_MS);
				return;
			}
			const jobs = takePending();
			if (jobs.length > 0) safeSend(buildNotice(jobs), !lastRunAborted);
		}, delay);
		flushTimer.unref();
	};

	const boundaryDelivery = (outcome: string, ctx: ExtensionContext) => {
		if (!managerFor(ctx) || outcome !== "completed") return undefined;
		const jobs = takePending();
		if (jobs.length === 0) return undefined;
		const notice = buildNotice(jobs);
		const draft: SessionBoundaryDraft = { type: "custom_message", ...notice };
		return { entries: [draft], continue: true };
	};

	const finishHeadlessTurn = async (outcome: string, ctx: ExtensionContext) => {
		const ready = boundaryDelivery(outcome, ctx);
		if (ready || outcome !== "completed" || (ctx.mode !== "print" && ctx.mode !== "json")) return ready;
		const mgr = managerFor(ctx);
		if (!mgr || ctx.signal?.aborted) return undefined;
		await waitForBackgroundResult(mgr, ctx.signal);
		if (ctx.signal?.aborted || managerFor(ctx) !== mgr) return undefined;
		return boundaryDelivery(outcome, ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		getConfig(ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		ctxRef = ctx;
		// A headless host may shut down at agent_end, before agent_before_settle. Hold only
		// the final assistant turn; tool turns and queued work must remain free to continue.
		const finalAnswer = event.message?.role === "assistant" && !event.message.content.some((block) => block.type === "toolCall");
		if (finalAnswer && !event.continue && !event.context?.pendingMessages.length) {
			return finishHeadlessTurn(event.outcome, ctx);
		}
		return boundaryDelivery(event.outcome, ctx);
	});
	pi.on("agent_before_settle", (event, ctx) => {
		ctxRef = ctx;
		if (!event.continue && !event.context?.pendingMessages.length) return finishHeadlessTurn(event.outcome, ctx);
		return boundaryDelivery(event.outcome, ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		ctxRef = ctx;
		lastRunAborted = false;
	});
	pi.on("agent_settled", (event, ctx) => {
		ctxRef = ctx;
		lastRunAborted = event.aborted;
		if (!managerFor(ctx)) return;
		const jobs = takePending();
		// After an abort, record the notice without starting a model turn on the user's behalf.
		if (jobs.length > 0) safeSend(buildNotice(jobs), !lastRunAborted);
	});
	const ui = installUi(pi, {
		board,
		notifyType: NOTIFY_CUSTOM_TYPE,
		actions: {
			owns: (ctx) => managerFor(ctx) !== undefined,
			stop: (jobId) => {
				const mgr = managerFor(ctxRef);
				const job = mgr?.get(jobId);
				if (!mgr || !job?.running) return false;
				// Not marked delivered: the model learns of the stop through the usual completion path.
				userStopped.add(job.id);
				void mgr.requestStop(job, "stopped");
				return true;
			},
		},
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		ui.shutdown();
		shutdownManager();
		board.dispose();
		ctxRef = undefined;
	});

	const buildEnv = (ctx: ExtensionContext): NodeJS.ProcessEnv => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const binDir = join(getAgentDir(), "bin");
		const entries = (env[pathKey] ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
		if (!entries.includes(binDir)) env[pathKey] = [binDir, ...entries].join(process.platform === "win32" ? ";" : ":");
		for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
		try {
			env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
			const file = ctx.sessionManager.getSessionFile();
			if (file) env.PI_SESSION_FILE = file;
		} catch {}
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
		return env;
	};

	const runningResult = (job: Job, how: "explicit" | "auto" | "manual"): AgentToolResult<BashDetails> => {
		const info = job.info();
		const tail = how !== "explicit" && manager ? manager.tail(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES) : undefined;
		const after = seconds(Date.now() - info.startedAt);
		const lines = [
			how === "auto"
				? `Command is still running after ${after}; it moved to the background as job ${info.id}. It has NOT completed.`
				: how === "manual"
					? `The user moved this command to the background after ${after}; it keeps running as job ${info.id}. It has NOT completed.`
					: `Command started in the background as job ${info.id}. It has NOT completed.`,
			`Full output log: ${info.logPath}`,
			info.timeoutMs ? `It will be killed if still running ${info.timeoutMs / 1000} seconds after launch.` : undefined,
			`You will be notified when it finishes. To check, wait, or stop it, call bash_job with job_id "${info.id}"; read the log file for output.`,
			tail?.text ? `Output so far${tail.truncated ? " (end)" : ""}:\n${tail.text}` : undefined,
		].filter((line): line is string => line !== undefined);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				jobId: info.id,
				status: "running",
				logPath: info.logPath,
				background: true,
				startedAt: info.startedAt,
				timeoutMs: info.timeoutMs,
				handoff: how,
				description: info.description,
			},
			structuredContent: {
				status: "running",
				job_id: info.id,
				output: tail?.text ?? "",
				truncated: tail?.truncated ?? false,
				full_output_path: info.logPath,
				wall_time_seconds: Math.round((Date.now() - info.startedAt) / 100) / 10,
			},
		} as AgentToolResult<BashDetails>;
	};

	const foregroundResult = (job: Job): AgentToolResult<BashDetails> => {
		const mgr = manager;
		const info = job.info();
		const tail = mgr ? mgr.tail(job, MODEL_TAIL_BYTES, MODEL_TAIL_LINES) : { text: "", truncated: false, totalBytes: 0 };
		job.delivered = true;
		// A truncated result points at the log, so the job stays registered and its log stays in the disk budget.
		if (!tail.truncated) mgr?.release(job);
		let text = tail.text;
		if (tail.truncated) text += `${text ? "\n\n" : ""}[Output truncated to the last lines. Full output: ${info.logPath}]`;
		const error = errorForStatus(info);
		if (info.status === "aborted" || info.status === "spawn_error" || info.status === "shutdown") {
			throw new Error(text ? `${text}\n\n${error}` : error);
		}
		const details: BashDetails = {
			jobId: info.id,
			status: info.status,
			exitCode: info.exitCode,
			truncated: tail.truncated,
			logPath: tail.truncated ? info.logPath : undefined,
		};
		const structuredContent = {
			status: info.status,
			output: tail.text,
			truncated: tail.truncated,
			...(tail.truncated ? { full_output_path: info.logPath } : {}),
			...(info.exitCode !== null ? { exit_code: info.exitCode } : {}),
			wall_time_seconds: Math.round(((info.endedAt ?? Date.now()) - info.startedAt) / 100) / 10,
		};
		if (error) {
			return {
				content: [{ type: "text", text: text ? `${text}\n\n${error}` : error }],
				details,
				structuredContent,
				isError: true,
			} as AgentToolResult<BashDetails>;
		}
		return { content: [{ type: "text", text: text || "(no output)" }], details, structuredContent } as AgentToolResult<BashDetails>;
	};

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr (last 2000 lines or 50KB; the full log path is given when truncated). " +
			"A command still running after a short foreground wait keeps running as a background job: the result then reports it as running, with a job ID and log path, and you are notified when it finishes. " +
			"Set run_in_background to start it in the background immediately. Optionally provide a timeout in seconds: a hard deadline that also applies in the background. Manage jobs with bash_job.",
		promptSnippet: "Execute bash commands (ls, grep, find, etc.); long commands continue as background jobs",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
			"bash waits briefly for a command (about 2 s by default); if it is still running, the result says it moved to the background as a job. That job has NOT completed: wait for the completion notice (or bash_job wait) before relying on its outcome.",
			"Use run_in_background for servers, watchers, and long builds instead of shell `&`; stop jobs you no longer need with bash_job stop.",
			"In headless runs, pending background jobs are joined before the process exits. Stop servers and watchers you no longer need before finishing your task.",
		],
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			ctxRef = ctx;
			const timeoutMs = resolveTimeoutMs(params.timeout);
			if (signal?.aborted) throw new Error("Command aborted");
			const mgr = ensureManager(ctx);
			const prefix = pi.getSettings().shellCommandPrefix;
			const job = mgr.start({
				command: prefix ? `${prefix}\n${params.command}` : params.command,
				displayCommand: params.command,
				description: typeof params.description === "string" && params.description.trim() ? params.description.trim() : undefined,
				cwd: ctx.cwd,
				env: buildEnv(ctx),
				timeoutMs,
				background: params.run_in_background === true,
			});

			if (params.run_in_background === true) {
				if (!(await job.launched)) {
					job.delivered = true;
					const info = job.info();
					mgr.release(job);
					throw new Error(errorForStatus(info));
				}
				return runningResult(job, "explicit");
			}

			const budget = getConfig(ctx).foregroundMs;
			let budgetTimer: NodeJS.Timeout | undefined;
			let updateTimer: NodeJS.Timeout | undefined;
			let releaseManual: (() => void) | undefined;
			const onAbort = () => void mgr.requestStop(job, "aborted");
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			if (onUpdate) {
				const liveDetails: BashDetails = {
					jobId: job.id,
					status: "running",
					startedAt: job.startedAt,
					timeoutMs: job.timeoutMs,
					description: job.description,
				};
				onUpdate({ content: [], details: liveDetails });
				// Send output only when the log grew; the renderer's own clock covers elapsed time.
				let lastSize = 0;
				updateTimer = setInterval(() => {
					let size = 0;
					try {
						size = statSync(job.logPath).size;
					} catch {}
					if (size === lastSize) return;
					lastSize = size;
					const tail = mgr.tail(job, LIVE_TAIL_BYTES, LIVE_TAIL_LINES);
					onUpdate({ content: [{ type: "text", text: tail.text }], details: liveDetails });
				}, UPDATE_INTERVAL_MS);
			}
			let outcome: "done" | "budget" | "manual";
			try {
				outcome = await new Promise<"done" | "budget" | "manual">((resolve) => {
					job.done.then(() => resolve("done"));
					if (budget !== null) budgetTimer = setTimeout(() => resolve("budget"), budget);
					// The user can move the command to the background (shortcut or jobs panel).
					releaseManual = board.registerForeground(job.id, () => resolve("manual"));
				});
			} finally {
				releaseManual?.();
				if (budgetTimer) clearTimeout(budgetTimer);
				if (updateTimer) clearInterval(updateTimer);
				// From here on the call's abort signal no longer owns the process.
				if (signal) signal.removeEventListener("abort", onAbort);
			}
			// handoff() fails once the job has exited; the caller then reports the completion itself.
			if (outcome !== "done" && mgr.handoff(job)) return runningResult(job, outcome === "manual" ? "manual" : "auto");
			await job.done;
			return foregroundResult(job);
		},
		...createBashRenderers({
			board,
			keys: { expand: expandKeyText, background: BACKGROUND_KEY, jobs: JOBS_KEY },
		}),
	});

	pi.registerTool({
		name: "bash_job",
		label: "bash job",
		description:
			"Manage background jobs started by bash: list them, check one (status), wait for one to finish (bounded), or stop one and its child processes. Job logs can also be read directly.",
		promptSnippet: "List, wait for, or stop background bash jobs",
		parameters: jobSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const mgr = managerFor(ctx);
			// Foreground completions kept only for their logs are not jobs the model manages.
			const listed = (job: Job | undefined) => (job?.owner === "background" ? job : undefined);
			if (params.action === "list") {
				const jobs = (mgr?.list() ?? []).filter((job) => listed(job));
				if (jobs.length === 0) return { content: [{ type: "text", text: "No background jobs in this session." }], details: undefined };
				const now = Date.now();
				const rows = jobs.map((job) => {
					const info = job.info();
					return `${info.id}  ${info.status}${info.status === "exited" ? ` (${info.exitCode})` : ""}  ${seconds((info.endedAt ?? now) - info.startedAt)}  ${oneLine(info.command, 80)}`;
				});
				return { content: [{ type: "text", text: rows.join("\n") }], details: { jobs: jobs.map((job) => job.info()) } };
			}
			if (!params.job_id) throw new Error(`job_id is required for ${params.action}`);
			const job = listed(mgr?.get(params.job_id));
			if (!mgr || !job) throw new Error(`Unknown job ${params.job_id} (jobs belong to the current session; finished jobs are kept for a limited time).`);

			if (params.action === "stop") {
				if (job.running) {
					job.delivered = true;
					void mgr.requestStop(job, "stopped");
					await mgr.wait(job, STOP_WAIT_MS, signal);
				}
				job.delivered = true;
				const text = job.running
					? `Stop requested for ${job.id}; it has not exited yet. Log: ${job.logPath}`
					: formatCompletion(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES);
				return { content: [{ type: "text", text }], details: job.info() };
			}

			if (params.action === "wait") {
				const waitSeconds = params.timeout ?? WAIT_DEFAULT_SECONDS;
				if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) throw new Error("Invalid timeout: must be a positive number of seconds");
				await mgr.wait(job, Math.min(waitSeconds, WAIT_MAX_SECONDS) * 1000, signal);
			}

			if (job.running) {
				const tail = mgr.tail(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES);
				const text = [
					`Job ${job.id} is still running (${seconds(Date.now() - job.startedAt)} elapsed). Log: ${job.logPath}`,
					tail.text ? `Output so far:\n${tail.text}` : "No output yet.",
				].join("\n");
				return { content: [{ type: "text", text }], details: job.info() };
			}
			job.delivered = true;
			const info = job.info();
			const text = formatCompletion(job, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES);
			return { content: [{ type: "text", text }], details: info };
		},
	});
}
