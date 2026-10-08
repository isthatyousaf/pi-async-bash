/**
 * Human rendering of the `bash-job-complete` custom message. The model-facing `content` is
 * unchanged; this only draws the transcript entry from `details`.
 *
 *   ● Background command "npm run build" completed · 1m 12s
 *     ⎿  last output line
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { JobInfo } from "../manager.ts";
import {
	DOT,
	formatDuration,
	GUTTER_FIRST,
	GUTTER_REST,
	jobLabel,
	outcomeOf,
	outputLines,
	padLines,
	prefixLines,
	sanitize,
	type Tone,
} from "./format.ts";

export interface CompletedJob extends JobInfo {
	/** End of the job's output (the same tail the model received), for display. */
	outputTail?: string;
}

export interface CompletionDetails {
	jobs: CompletedJob[];
}

const COMPACT_TAIL_LINES = 3;
const MAX_LISTED = 8;

/** Sentence fragment for a finished job: "completed", "failed with exit code 2", … */
export function completionPhrase(info: Pick<JobInfo, "status" | "exitCode" | "timeoutMs" | "error">): string {
	switch (info.status) {
		case "exited":
			return info.exitCode === 0 ? "completed" : `failed with exit code ${info.exitCode}`;
		case "timed_out":
			return `timed out after ${formatDuration(info.timeoutMs ?? 0)}`;
		case "output_limit":
			return "exceeded the output log limit";
		case "stopped":
			return "was stopped";
		case "aborted":
			return "was interrupted";
		case "shutdown":
			return "stopped when the session ended";
		case "spawn_error":
			return `failed to start${info.error ? `: ${info.error}` : ""}`;
		case "running":
			return "is still running";
	}
	return String(info.status);
}

function worstTone(tones: Tone[]): Tone {
	if (tones.includes("error")) return "error";
	if (tones.includes("warning")) return "warning";
	if (tones.every((t) => t === "success")) return "success";
	return "muted";
}

function took(info: JobInfo): string {
	return info.endedAt !== undefined && info.status !== "timed_out" ? ` · ${formatDuration(info.endedAt - info.startedAt)}` : "";
}

export class CompletionView implements Component {
	private cache: { width: number; lines: string[] } | undefined;
	private readonly details: CompletionDetails;
	private readonly fallbackText: string;
	private readonly expanded: boolean;
	private readonly outputPad: number;
	private readonly theme: Theme;
	private readonly expandKey: string;
	constructor(details: CompletionDetails, fallbackText: string, expanded: boolean, outputPad: number, theme: Theme, expandKey: string) {
		this.details = details;
		this.fallbackText = fallbackText;
		this.expanded = expanded;
		this.outputPad = outputPad;
		this.theme = theme;
		this.expandKey = expandKey;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const inner = Math.max(10, width - this.outputPad * 2);
		const lines = padLines(this.renderInner(inner), this.outputPad, width);
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private renderInner(width: number): string[] {
		const theme = this.theme;
		const jobs = Array.isArray(this.details?.jobs) ? this.details.jobs : [];
		if (jobs.length === 0) {
			const lines = outputLines(this.fallbackText);
			return prefixLines(
				[theme.fg("muted", lines[0] ?? "Background command finished"), ...lines.slice(1, this.expanded ? undefined : 4).map((l) => theme.fg("dim", l))],
				width,
				`${theme.fg("muted", DOT)} `,
				"  ",
				true,
			);
		}
		const tones = jobs.map((job) => outcomeOf(job).tone);
		const dot = theme.fg(worstTone(tones), DOT);
		if (jobs.length === 1) {
			const job = jobs[0]!;
			const outcome = outcomeOf(job);
			const header =
				theme.fg("text", "Background command ") +
				theme.fg(outcome.tone === "success" ? "text" : outcome.tone, completionPhrase(job)) +
				theme.fg("dim", took(job));
			const out = prefixLines([header], width, `${dot} `, "  ", true);
			const body = [...(this.expanded && !job.description ? [] : [this.labelLine(job)]), ...this.jobBody(job, this.expanded ? Infinity : COMPACT_TAIL_LINES)];
			out.push(...prefixLines(body, width, theme.fg("dim", GUTTER_FIRST), GUTTER_REST, this.expanded));
			return out;
		}
		const out = prefixLines([theme.fg("text", `${jobs.length} background commands finished`)], width, `${dot} `, "  ", true);
		const body: string[] = [];
		for (const job of jobs.slice(0, this.expanded ? jobs.length : MAX_LISTED)) {
			const outcome = outcomeOf(job);
			body.push(
				`${theme.fg(outcome.tone, DOT)} ${theme.fg("text", jobLabel(job, 60))}${theme.fg("dim", " · ")}${theme.fg(outcome.tone === "success" ? "muted" : outcome.tone, completionPhrase(job))}${theme.fg("dim", took(job))}`,
			);
			if (this.expanded) body.push(...this.jobBody(job, Infinity).map((line) => `  ${line}`));
		}
		if (!this.expanded && jobs.length > MAX_LISTED) body.push(theme.fg("dim", `… and ${jobs.length - MAX_LISTED} more`));
		if (!this.expanded) body.push(theme.fg("dim", `${this.expandKey} to expand`));
		out.push(...prefixLines(body, width, theme.fg("dim", GUTTER_FIRST), GUTTER_REST, this.expanded));
		return out;
	}

	/** Description (when given) or the command, on one line; the full command is in the expanded view. */
	private labelLine(job: CompletedJob): string {
		const theme = this.theme;
		if (job.description?.trim()) return theme.fg("muted", jobLabel(job, 120));
		return theme.fg("dim", `$ ${jobLabel(job, 160)}`);
	}

	private jobBody(job: CompletedJob, maxLines: number): string[] {
		const theme = this.theme;
		const lines = outputLines(job.outputTail ?? "");
		const body: string[] = [];
		if (this.expanded) {
			body.push(theme.fg("dim", `$ ${sanitize(job.command)}`));
			body.push(theme.fg("dim", [job.id, job.logDeleted ? "log deleted" : `log ${job.logPath}`].join(" · ")));
		}
		if (lines.length === 0) {
			if (!this.expanded) body.push(theme.fg("dim", "(No output)"));
			return body;
		}
		const shown = lines.slice(-maxLines);
		if (shown.length < lines.length) body.push(theme.fg("dim", `… +${lines.length - shown.length} lines (${this.expandKey} to expand)`));
		body.push(...shown.map((line) => theme.fg("toolOutput", line)));
		return body;
	}
}

export function createCompletionRenderer(expandKey: () => string) {
	return (
		message: { content: string | { type: string; text?: string }[]; details?: unknown },
		options: { expanded: boolean; outputPad: number },
		theme: Theme,
	): Component => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("\n");
		let key = "ctrl+o";
		try {
			key = expandKey() || key;
		} catch {}
		return new CompletionView((message.details ?? { jobs: [] }) as CompletionDetails, text, options.expanded, options.outputPad ?? 1, theme, key);
	};
}
