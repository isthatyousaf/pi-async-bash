/**
 * One quiet line below the editor while background commands run:
 *
 *   ● npm run dev · 3m 12s · alt+j to manage
 *   ● 3 background commands · npm run dev, cargo watch, … · alt+j to manage
 *
 * Renders nothing when no background command is running, so it takes no space otherwise.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { JobBoard } from "./board.ts";
import { DOT, formatElapsed, jobLabel } from "./format.ts";

export class JobsWidget implements Component {
	private cache: { width: number; version: number; lines: string[] } | undefined;
	private version = 0;
	private unsubscribe: (() => void) | undefined;

	private readonly board: JobBoard;
	private readonly theme: Theme;
	private readonly jobsKey: string;
	private readonly now: () => number;

	constructor(board: JobBoard, theme: Theme, jobsKey: string, requestRender: () => void, now: () => number = Date.now) {
		this.board = board;
		this.theme = theme;
		this.jobsKey = jobsKey;
		this.now = now;
		this.unsubscribe = board.subscribe(() => {
			this.version++;
			requestRender();
		});
	}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width && this.cache.version === this.version) return this.cache.lines;
		const lines = this.compute(width);
		this.cache = { width, version: this.version, lines };
		return lines;
	}

	private compute(width: number): string[] {
		const running = this.board.runningBackground().sort((a, b) => a.startedAt - b.startedAt);
		if (running.length === 0) return [];
		const theme = this.theme;
		const now = this.now();
		const dot = theme.fg("accent", DOT);
		const hint = theme.fg("dim", ` · ${this.jobsKey} to manage`);
		let main: string;
		if (running.length === 1) {
			const job = running[0]!;
			main = `${theme.fg("muted", jobLabel(job, 60))}${theme.fg("dim", ` · ${formatElapsed(now - job.startedAt)}`)}`;
		} else {
			const names = running.map((job) => jobLabel(job, 30)).join(", ");
			main = `${theme.fg("muted", `${running.length} background commands`)}${theme.fg("dim", ` · ${names}`)}`;
		}
		// Keep the hint visible: truncate the description part first.
		const hintWidth = 3 + this.jobsKey.length + 10;
		const room = Math.max(8, width - 3 - hintWidth);
		const line = ` ${dot} ${truncateToWidth(main, room, "…")}${hint}`;
		return [truncateToWidth(line, width, "")];
	}

	invalidate(): void {
		this.cache = undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
