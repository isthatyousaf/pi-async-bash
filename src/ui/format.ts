/**
 * Pure presentation helpers shared by the transcript rows, the completion notice, the jobs widget
 * and the jobs panel. No Pi runtime state: everything here is a function of its arguments.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { JobInfo, JobStatus } from "../manager.ts";

/** Semantic tones used for the state dot and status lines. */
export type Tone = "success" | "error" | "warning" | "muted" | "dim" | "accent" | "text";

export const DOT = "●";
/** Claude-style result gutter: two spaces, the corner, two spaces (5 columns). */
export const GUTTER_FIRST = "  ⎿  ";
export const GUTTER_REST = "     ";
export const GUTTER_WIDTH = 5;

/** Compact display limits for commands (two lines / 160 characters, like Claude's compact rows). */
export const COMPACT_COMMAND_LINES = 2;
export const COMPACT_COMMAND_CHARS = 160;
/** Output lines shown in a collapsed row. */
export const COMPACT_OUTPUT_LINES = 5;

/** Human durations: 0.4s, 9.8s, 12s, 3m 05s, 1h 02m. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Whole-second elapsed time for live rows, so the text changes at most once per tick. */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	return formatDuration(total * 1000);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes other than \n and \t
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F\u0080-\u009F\uFFF9-\uFFFB]/g;

/**
 * Make untrusted text safe to place on a terminal line: strip escape sequences, show remaining
 * control bytes as visible placeholders, and expand tabs (4-column stops).
 */
export function sanitize(text: string): string {
	const cleaned = text
		.replace(/\r\n/g, "\n")
		.replace(ANSI_RE, "")
		.replace(/\r/g, "\n")
		.replace(CONTROL_RE, (c) => (c === "\x1b" ? "␛" : "�"));
	if (!cleaned.includes("\t")) return cleaned;
	return cleaned
		.split("\n")
		.map((line) => {
			let out = "";
			for (const ch of line) {
				if (ch === "\t") out += " ".repeat(4 - (visibleWidth(out) % 4));
				else out += ch;
			}
			return out;
		})
		.join("\n");
}

/** Split command text into display lines, limited to `maxLines` lines and `maxChars` characters. */
export function compactCommand(
	command: string,
	maxLines = COMPACT_COMMAND_LINES,
	maxChars = COMPACT_COMMAND_CHARS,
): { lines: string[]; truncated: boolean } {
	const all = sanitize(command).replace(/\n+$/, "").split("\n");
	const lines: string[] = [];
	let used = 0;
	let truncated = all.length > maxLines;
	for (const line of all.slice(0, maxLines)) {
		const chars = [...line];
		if (used + chars.length > maxChars) {
			lines.push(chars.slice(0, Math.max(0, maxChars - used)).join(""));
			truncated = true;
			break;
		}
		used += chars.length;
		lines.push(line);
	}
	if (truncated && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/\s+$/, "")}…`;
	return { lines, truncated };
}

/** One-line label for a job: its description when given, else the first command line. */
export function jobLabel(info: { command: string; description?: string }, maxChars = 80): string {
	const description = info.description?.trim();
	if (description) return compactCommand(description, 1, maxChars).lines[0] ?? "";
	return compactCommand(info.command, 1, maxChars).lines[0] ?? "";
}

export interface Outcome {
	label: string;
	tone: Tone;
	ok: boolean;
}

/** Final outcome of a job, phrased for people. */
export function outcomeOf(info: Pick<JobInfo, "status" | "exitCode" | "timeoutMs" | "error">): Outcome {
	switch (info.status as JobStatus) {
		case "running":
			return { label: "Running…", tone: "muted", ok: true };
		case "exited":
			return info.exitCode === 0
				? { label: "Done", tone: "success", ok: true }
				: { label: `Exit code ${info.exitCode}`, tone: "error", ok: false };
		case "timed_out":
			return { label: `Timed out after ${formatDuration(info.timeoutMs ?? 0)}`, tone: "warning", ok: false };
		case "output_limit":
			return { label: "Output exceeded the log limit", tone: "error", ok: false };
		case "stopped":
			return { label: "Stopped", tone: "warning", ok: false };
		case "aborted":
			return { label: "Interrupted", tone: "warning", ok: false };
		case "shutdown":
			return { label: "Stopped when the session ended", tone: "muted", ok: false };
		case "spawn_error":
			return { label: `Failed to start${info.error ? `: ${info.error}` : ""}`, tone: "error", ok: false };
	}
	return { label: String(info.status), tone: "muted", ok: false };
}

export function paint(theme: Theme, tone: Tone, text: string): string {
	return theme.fg(tone, text);
}

/** Split output into display lines (sanitized), dropping one trailing empty line. */
export function outputLines(text: string): string[] {
	if (!text) return [];
	const lines = sanitize(text).split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Lay out text after a fixed-width prefix: the first line gets `first`, continuation lines `rest`.
 * Compact mode truncates each logical line; expanded mode wraps it.
 */
export function prefixLines(lines: string[], width: number, first: string, rest: string, wrap: boolean): string[] {
	const prefixWidth = Math.max(visibleWidth(first), visibleWidth(rest));
	const avail = Math.max(1, width - prefixWidth);
	const out: string[] = [];
	for (const line of lines) {
		const parts = wrap ? wrapTextWithAnsi(line, avail) : [truncateToWidth(line, avail, "…")];
		for (const part of parts.length > 0 ? parts : [""]) {
			out.push((out.length === 0 ? first : rest) + part);
		}
	}
	return out.map((line) => truncateToWidth(line, width, ""));
}

/** Prefix every line with `pad` spaces and keep it within `width` columns. */
export function padLines(lines: string[], pad: number, width: number): string[] {
	const left = " ".repeat(Math.max(0, pad));
	return lines.map((line) => truncateToWidth(left + line, width, ""));
}
