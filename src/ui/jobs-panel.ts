/**
 * Keyboard-operated overlay listing the session's shell jobs, with the selected job's full
 * command, timing, exit reason and a scrollable live log tail.
 *
 *   ↑/↓ or k/j  select        PgUp/PgDn, Home/End  scroll the log
 *   x x         stop (press twice)   b  move a foreground command to the background
 *   Esc / q     close (focus returns to the editor)
 *
 * Mouse (fullscreen mode): wheel scrolls the log, click selects a job. Every action has a key.
 * The panel never opens by itself. It subscribes to the job board while open and unsubscribes in
 * `dispose()`, which runs when the panel closes or the session shuts down.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { JobInfo } from "../manager.ts";
import type { JobBoard } from "./board.ts";
import { DOT, formatDuration, formatElapsed, jobLabel, outcomeOf, outputLines, sanitize } from "./format.ts";

export interface PanelActions {
	/** Stop a job at the user's request. The model is told through the normal completion path. */
	stop(jobId: string): boolean;
}

export interface PanelOptions {
	board: JobBoard;
	theme: Theme;
	keybindings?: KeybindingsManager;
	actions: PanelActions;
	/** Terminal height, read on every render. */
	rows: () => number;
	requestRender: () => void;
	close: () => void;
	now?: () => number;
	initialJobId?: string;
}

const LOG_TAIL_BYTES = 64 * 1024;
const LOG_TAIL_LINES = 1000;

export function sortJobs(jobs: JobInfo[]): JobInfo[] {
	return [...jobs].sort((a, b) => {
		const ar = a.status === "running" ? 1 : 0;
		const br = b.status === "running" ? 1 : 0;
		if (ar !== br) return br - ar;
		if (ar) return a.startedAt - b.startedAt;
		return (b.endedAt ?? 0) - (a.endedAt ?? 0);
	});
}

export class JobsPanel implements Component {
	private selectedId: string | undefined;
	private follow = true;
	private top = 0;
	private confirmStop: string | undefined;
	private message: string | undefined;
	/** A stop request in flight; its "Stopping…" message clears when the job finishes. */
	private stoppingId: string | undefined;
	private version = 0;
	/** Bumped only by job changes and clock ticks; keys the log cache. */
	private dataVersion = 0;
	private unsubscribe: (() => void) | undefined;
	private closed = false;
	private logCache: { key: string; width: number; lines: string[] } | undefined;
	private layout: { listTop: number; listIds: string[]; logTop: number; logHeight: number } | undefined;

	private readonly o: PanelOptions;
	private narrow = false;

	constructor(o: PanelOptions) {
		this.o = o;
		this.selectedId = o.initialJobId;
		this.unsubscribe = o.board.subscribe(() => {
			this.version++;
			this.dataVersion++;
			o.requestRender();
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get selected(): string | undefined {
		return this.currentJob()?.id;
	}

	private jobs(): JobInfo[] {
		return sortJobs(this.o.board.list());
	}

	private currentJob(jobs = this.jobs()): JobInfo | undefined {
		if (jobs.length === 0) return undefined;
		const found = jobs.find((job) => job.id === this.selectedId);
		if (found) return found;
		this.selectedId = jobs[0]!.id;
		return jobs[0];
	}

	// --- input ---------------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.o.keybindings;
		const pendingStop = this.confirmStop;
		this.confirmStop = undefined;
		const jobs = this.jobs();
		const current = this.currentJob(jobs);
		const index = current ? jobs.indexOf(current) : -1;

		if (matchesKey(data, Key.escape) || data === "q" || (kb ? kb.matches(data, "tui.select.cancel") : matchesKey(data, "ctrl+c"))) {
			this.close();
			return;
		}
		this.message = undefined;
		if (matchesKey(data, Key.up) || data === "k") {
			this.select(jobs, index - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.select(jobs, index + 1);
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, "shift+up")) {
			this.scroll(-(this.layout?.logHeight ?? 10) + 1);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, "shift+down")) {
			this.scroll((this.layout?.logHeight ?? 10) - 1);
		} else if (matchesKey(data, Key.home) || data === "g") {
			this.follow = false;
			this.top = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.follow = true;
		} else if (data === "x") {
			if (!current || current.status !== "running") {
				this.message = current ? "This command has already finished." : undefined;
			} else if (pendingStop === current.id) {
				const ok = this.o.actions.stop(current.id);
				this.message = ok ? `Stopping "${jobLabel(current, 40)}"…` : "Could not stop this command.";
				this.stoppingId = ok ? current.id : undefined;
			} else {
				this.confirmStop = current.id;
			}
		} else if (data === "b") {
			if (current && this.o.board.canBackground(current.id)) {
				this.o.board.requestBackground(current.id);
				this.message = "Moved to the background; the agent continues.";
			} else {
				this.message = current?.status === "running" ? "Already running in the background." : undefined;
			}
		}
		this.version++;
		this.o.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const layout = this.layout;
		if (!layout || this.closed) return undefined;
		if (event.wheelDelta) {
			this.scroll(event.wheelDelta);
			this.version++;
			this.o.requestRender();
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left") {
			const row = event.y - layout.listTop;
			const id = layout.listIds[row];
			if (id) {
				this.selectedId = id;
				this.follow = true;
				this.version++;
				this.o.requestRender();
			}
			return { handled: true };
		}
		return undefined;
	}

	private select(jobs: JobInfo[], index: number): void {
		if (jobs.length === 0) return;
		const next = jobs[Math.max(0, Math.min(jobs.length - 1, index))]!;
		if (next.id !== this.selectedId) {
			this.selectedId = next.id;
			this.follow = true;
			this.top = 0;
		}
	}

	private scroll(lines: number): void {
		const total = this.logCache?.lines.length ?? 0;
		const view = this.layout?.logHeight ?? 10;
		const maxTop = Math.max(0, total - view);
		const from = this.follow ? maxTop : this.top;
		const to = Math.max(0, Math.min(maxTop, from + lines));
		this.top = to;
		this.follow = to >= maxTop;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.o.close();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	invalidate(): void {
		this.logCache = undefined;
	}

	// --- rendering -----------------------------------------------------------------------------

	render(width: number): string[] {
		const t = this.o.theme;
		const now = (this.o.now ?? Date.now)();
		const rows = Math.max(8, this.o.rows());
		const height = Math.max(8, Math.min(rows - 2, 36, Math.max(14, Math.floor(rows * 0.7))));
		const w = Math.max(20, width);
		const inner = w - 4;
		this.narrow = inner < 64;
		const jobs = this.jobs();
		const current = this.currentJob(jobs);
		const border = (s: string) => t.fg("borderMuted", s);
		const row = (content: string) => `${border("│")} ${truncateToWidth(content, inner, "…", true)} ${border("│")}`;
		const rule = () => border(`├${"─".repeat(w - 2)}┤`);

		const runningCount = jobs.filter((j) => j.status === "running").length;
		const title = truncateToWidth(` ${t.bold("Shell jobs")} `, w - 4, "");
		let count = runningCount > 0 ? ` ${t.fg("accent", `${runningCount} running`)} ` : ` ${t.fg("dim", jobs.length ? `${jobs.length} finished` : "none")} `;
		if (visibleWidth(title) + visibleWidth(count) > w - 4) count = "";
		const fill = Math.max(0, w - 4 - visibleWidth(title) - visibleWidth(count));
		const lines: string[] = [border("╭─") + title + border("─".repeat(fill)) + count + border("─╮")];

		const footerHints = this.footer(current);
		const bottom = (() => {
			const text = ` ${footerHints} `;
			const room = w - 4;
			const shown = truncateToWidth(text, room, "…");
			return border("╰─") + shown + border("─".repeat(Math.max(0, room - visibleWidth(shown)))) + border("─╯");
		})();

		if (jobs.length === 0) {
			const body = [
				"",
				t.fg("muted", "No shell jobs in this session."),
				t.fg("dim", "Commands that run past the foreground wait, or start with run_in_background,"),
				t.fg("dim", "appear here while they run and after they finish."),
			];
			for (const line of body) lines.push(row(line));
			while (lines.length < height - 1) lines.push(row(""));
			lines.push(bottom);
			this.layout = { listTop: 1, listIds: [], logTop: 0, logHeight: 0 };
			return lines.slice(0, height);
		}

		// Job list: a window around the selection.
		const listMax = Math.max(2, Math.min(jobs.length, Math.floor(height * 0.3)));
		const selIndex = current ? jobs.indexOf(current) : 0;
		const start = Math.max(0, Math.min(jobs.length - listMax, selIndex - Math.floor(listMax / 2)));
		const visible = jobs.slice(start, start + listMax);
		const listTop = lines.length;
		for (const job of visible) lines.push(row(this.listRow(job, job.id === current?.id, inner, now)));

		// Detail: command and metadata.
		lines.push(rule());
		if (current) {
			const cmd = wrapTextWithAnsi(t.fg("text", `$ ${sanitize(current.command).replace(/\n+$/, "")}`), inner).slice(0, 3);
			for (const line of cmd) lines.push(row(line));
			if (current.description) lines.push(row(t.fg("muted", sanitize(current.description).split("\n")[0]!)));
			lines.push(row(this.metaLine(current, now)));
			lines.push(row(t.fg("dim", current.logDeleted ? "log deleted" : `log ${current.logPath}`)));
		}
		lines.push(rule());

		// Log viewport fills the rest.
		const logTop = lines.length;
		const logHeight = Math.max(1, height - lines.length - 1);
		const logLines = current ? this.logLines(current, inner) : [];
		const total = logLines.length;
		const maxTop = Math.max(0, total - logHeight);
		if (this.follow) this.top = maxTop;
		this.top = Math.max(0, Math.min(maxTop, this.top));
		const slice = logLines.slice(this.top, this.top + logHeight);
		if (total === 0) slice.push(t.fg("dim", current?.status === "running" ? "(no output yet)" : "(no output)"));
		for (let i = 0; i < logHeight; i++) {
			let line = slice[i] ?? "";
			// Scroll position hint on the first/last line when content is hidden.
			if (i === 0 && this.top > 0) line = t.fg("dim", `↑ ${this.top} more`);
			if (i === logHeight - 1 && this.top + logHeight < total) line = t.fg("dim", `↓ ${total - this.top - logHeight} more · End to follow`);
			lines.push(row(line));
		}
		lines.push(bottom);
		this.layout = { listTop, listIds: visible.map((j) => j.id), logTop, logHeight };
		return lines.slice(0, height);
	}

	private listRow(job: JobInfo, selected: boolean, inner: number, now: number): string {
		const t = this.o.theme;
		const outcome = outcomeOf(job);
		const running = job.status === "running";
		const dot = t.fg(running ? (job.owner === "background" ? "accent" : "muted") : outcome.tone, DOT);
		const right = running
			? `${job.owner === "foreground" ? "foreground · " : ""}${formatElapsed(now - job.startedAt)}`
			: `${outcome.label}${job.endedAt !== undefined && job.status !== "timed_out" ? ` · ${formatDuration(job.endedAt - job.startedAt)}` : ""}`;
		const rightStyled = t.fg(running ? "dim" : outcome.tone === "success" ? "dim" : outcome.tone, right);
		const marker = selected ? t.fg("accent", "›") : " ";
		const labelRoom = Math.max(4, inner - 4 - visibleWidth(right) - 2);
		let label = truncateToWidth(jobLabel(job, 200), labelRoom, "…");
		label = selected ? t.bold(label) : t.fg(running ? "text" : "muted", label);
		const gap = Math.max(1, inner - 4 - visibleWidth(label) - visibleWidth(right));
		return `${marker} ${dot} ${label}${" ".repeat(gap)}${rightStyled}`;
	}

	private metaLine(job: JobInfo, now: number): string {
		const t = this.o.theme;
		const parts: string[] = [];
		if (job.status === "running") {
			parts.push(`running ${formatElapsed(now - job.startedAt)}`);
			if (job.timeoutMs) parts.push(`killed in ${formatElapsed(Math.max(0, job.startedAt + job.timeoutMs - now))}`);
			else parts.push("no deadline");
		} else {
			const outcome = outcomeOf(job);
			parts.push(t.fg(outcome.tone, outcome.label));
			if (job.endedAt !== undefined) parts.push(`ran ${formatDuration(job.endedAt - job.startedAt)}`);
		}
		parts.push(job.owner === "background" ? "background" : "foreground");
		parts.push(job.id);
		if (job.pid) parts.push(`pid ${job.pid}`);
		return parts.map((p, i) => (i === 0 && job.status !== "running" ? p : t.fg("dim", p))).join(t.fg("dim", " · "));
	}

	private logLines(job: JobInfo, width: number): string[] {
		const key = `${job.id}:${job.status}:${this.dataVersion}`;
		if (this.logCache && this.logCache.key === key && this.logCache.width === width) return this.logCache.lines;
		const t = this.o.theme;
		const tail = this.o.board.tail(job.id, LOG_TAIL_BYTES, LOG_TAIL_LINES);
		const raw = outputLines(tail?.text ?? "");
		const lines: string[] = [];
		if (tail?.truncated) lines.push(t.fg("dim", "… earlier output is in the log file"));
		for (const line of raw) {
			const wrapped = wrapTextWithAnsi(line, width);
			lines.push(...(wrapped.length ? wrapped : [""]).map((part) => t.fg("toolOutput", part)));
		}
		this.logCache = { key, width, lines };
		return lines;
	}

	private footer(current: JobInfo | undefined): string {
		const t = this.o.theme;
		if (this.confirmStop && current?.id === this.confirmStop) {
			return t.fg("warning", `Stop "${jobLabel(current, 40)}"? x to confirm · any other key cancels`);
		}
		if (this.stoppingId && this.o.board.get(this.stoppingId)?.status !== "running") {
			this.stoppingId = undefined;
			this.message = undefined;
		}
		if (this.message) return t.fg("muted", this.message);
		const short = this.narrow;
		const hints = short ? ["↑↓", "PgUp/Dn"] : ["↑↓ select", "PgUp/PgDn scroll"];
		if (current?.status === "running") hints.push("x stop");
		if (current && this.o.board.canBackground(current.id)) hints.push(short ? "b bg" : "b background");
		hints.push(short ? "esc" : "esc close");
		return t.fg("dim", hints.join(" · "));
	}
}
