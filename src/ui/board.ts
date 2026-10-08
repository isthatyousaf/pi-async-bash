/**
 * Display-side view of the session's jobs. The extension feeds it job changes and a read-only job
 * source; transcript rows, the jobs widget and the jobs panel read from it and subscribe to it.
 *
 * It never owns processes and never decides delivery. The only control it carries is the manual
 * handoff trigger registered by a foreground `bash` call, which wakes that call's own wait; the call
 * then performs the usual `handoff()` ownership transition (which fails once the job has exited).
 *
 * Lifetimes are bounded: row watchers are dropped when their job finishes, the 1 s ticker runs only
 * while a watched or subscribed job is running, and `reset()` / `dispose()` clear everything.
 * No Pi imports, so it is tested directly.
 */
import type { JobInfo, TailResult } from "../manager.ts";

export interface JobSource {
	/** Jobs the UI may show: running jobs of either owner and retained background jobs. */
	list(): JobInfo[];
	get(id: string): JobInfo | undefined;
	tail(id: string, maxBytes: number, maxLines: number): TailResult | undefined;
}

/** A rendered row that redraws itself when its job changes or the clock ticks. */
export interface RowWatcher {
	refresh(): void;
}

const MAX_WATCHERS_PER_JOB = 4;

export class JobBoard {
	private source: JobSource | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly rows = new Map<string, Set<RowWatcher>>();
	private readonly foreground = new Map<string, () => void>();
	private ticker: NodeJS.Timeout | undefined;
	private disposed = false;
	/** Increments once per tick; rows use it for the running indicator. */
	tick = 0;
	readonly tickMs: number;

	constructor(options: { tickMs?: number } = {}) {
		this.tickMs = options.tickMs ?? 1000;
	}

	setSource(source: JobSource | undefined): void {
		this.source = source;
		if (!source) {
			this.rows.clear();
			this.foreground.clear();
		}
		this.emit();
	}

	get hasSource(): boolean {
		return this.source !== undefined;
	}

	list(): JobInfo[] {
		try {
			return this.source?.list() ?? [];
		} catch {
			return [];
		}
	}

	get(id: string | undefined): JobInfo | undefined {
		if (!id) return undefined;
		try {
			return this.source?.get(id);
		} catch {
			return undefined;
		}
	}

	tail(id: string, maxBytes: number, maxLines: number): TailResult | undefined {
		try {
			return this.source?.tail(id, maxBytes, maxLines);
		} catch {
			return undefined;
		}
	}

	runningBackground(): JobInfo[] {
		return this.list().filter((info) => info.status === "running" && info.owner === "background");
	}

	/** Subscribe to any change (job lifecycle or clock tick while jobs run). */
	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		this.ensureTicker();
		return () => {
			this.listeners.delete(listener);
			this.stopTickerIfIdle();
		};
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	/** Keep `row` refreshed while job `jobId` runs. Finished or unknown jobs are not watched. */
	watchRow(jobId: string | undefined, row: RowWatcher): void {
		if (this.disposed || !jobId) return;
		const info = this.get(jobId);
		if (!info || info.status !== "running") return;
		let set = this.rows.get(jobId);
		if (!set) {
			set = new Set();
			this.rows.set(jobId, set);
		}
		if (!set.has(row)) {
			set.add(row);
			// Bounded: rebuilt transcripts create new rows; the oldest ones stop being refreshed.
			while (set.size > MAX_WATCHERS_PER_JOB) set.delete(set.values().next().value!);
		}
		this.ensureTicker();
	}

	get watchedRowCount(): number {
		let n = 0;
		for (const set of this.rows.values()) n += set.size;
		return n;
	}

	get tickerActive(): boolean {
		return this.ticker !== undefined;
	}

	/** A job changed (start, handoff, stop request, finish). */
	changed(jobId: string): void {
		if (this.disposed) return;
		const info = this.get(jobId);
		const set = this.rows.get(jobId);
		if (set) {
			for (const row of [...set]) this.refreshRow(row);
			if (!info || info.status !== "running") this.rows.delete(jobId);
		}
		this.emit();
		this.ensureTicker();
		this.stopTickerIfIdle();
	}

	/** A foreground call waiting on `jobId` registers how to wake it for a manual handoff. */
	registerForeground(jobId: string, trigger: () => void): () => void {
		if (this.disposed) return () => {};
		this.foreground.set(jobId, trigger);
		this.emit();
		return () => {
			if (this.foreground.get(jobId) === trigger) {
				this.foreground.delete(jobId);
				this.emit();
			}
		};
	}

	canBackground(jobId: string): boolean {
		return this.foreground.has(jobId);
	}

	foregroundIds(): string[] {
		return [...this.foreground.keys()];
	}

	/** Wake the foreground wait of one job, or of all, so each call hands its job off. Returns how many. */
	requestBackground(jobId?: string): number {
		const targets = jobId ? [jobId] : [...this.foreground.keys()];
		let n = 0;
		for (const id of targets) {
			const trigger = this.foreground.get(id);
			if (!trigger) continue;
			this.foreground.delete(id);
			n++;
			try {
				trigger();
			} catch {}
		}
		if (n > 0) this.emit();
		return n;
	}

	/** Forget the session's jobs (manager shut down or replaced); keeps subscribers. */
	reset(): void {
		this.rows.clear();
		this.foreground.clear();
		this.source = undefined;
		this.stopTicker();
		this.emit();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rows.clear();
		this.foreground.clear();
		this.listeners.clear();
		this.source = undefined;
		this.stopTicker();
	}

	private refreshRow(row: RowWatcher): void {
		try {
			row.refresh();
		} catch {}
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {}
		}
	}

	private anyRunning(): boolean {
		return this.list().some((info) => info.status === "running");
	}

	private ensureTicker(): void {
		if (this.ticker || this.disposed) return;
		if (this.listeners.size === 0 && this.rows.size === 0) return;
		if (!this.anyRunning()) return;
		this.ticker = setInterval(() => this.onTick(), this.tickMs);
		this.ticker.unref();
	}

	private stopTickerIfIdle(): void {
		if (!this.ticker) return;
		if ((this.listeners.size === 0 && this.rows.size === 0) || !this.anyRunning()) this.stopTicker();
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private onTick(): void {
		this.tick++;
		for (const [jobId, set] of [...this.rows]) {
			const info = this.get(jobId);
			for (const row of [...set]) this.refreshRow(row);
			if (!info || info.status !== "running") this.rows.delete(jobId);
		}
		this.emit();
		this.stopTickerIfIdle();
	}
}
