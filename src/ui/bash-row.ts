/**
 * Transcript rendering for the `bash` tool: a Claude-style compact row.
 *
 *   ● Bash(npm test)                       header: state dot, tool name, compact command
 *     ⎿  … +40 lines (ctrl+o to expand)    body: indented output tail and one status line
 *        last output line
 *        Running… (12s · timeout 1m)
 *
 * The row draws its own framing (`renderShell: "self"`). Call and result renderers share one
 * `RowState` (Pi's per-row renderer state); both components compute their lines at render time from
 * that state, cached by width and an input version, so they never show a stale state dot.
 */
import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { JobInfo } from "../manager.ts";
import type { JobBoard } from "./board.ts";
import {
	COMPACT_OUTPUT_LINES,
	compactCommand,
	DOT,
	formatDuration,
	formatElapsed,
	GUTTER_FIRST,
	GUTTER_REST,
	outcomeOf,
	outputLines,
	padLines,
	prefixLines,
	sanitize,
	type Tone,
} from "./format.ts";

export interface BashArgs {
	command?: string;
	timeout?: number;
	run_in_background?: boolean;
	description?: string;
}

export interface BashDetails {
	jobId?: string;
	status?: string;
	logPath?: string;
	exitCode?: number | null;
	truncated?: boolean;
	background?: boolean;
	/** Launch time (ms since epoch), for live elapsed time. */
	startedAt?: number;
	timeoutMs?: number;
	/** How a running result reached the background. */
	handoff?: "explicit" | "auto" | "manual";
	description?: string;
}

export interface RowKeys {
	/** Key text of Pi's expand action (e.g. "ctrl+o"). */
	expand(): string;
	/** Shortcut that moves running foreground commands to the background. */
	background: string;
	/** Shortcut that opens the jobs panel. */
	jobs: string;
}

export interface RowDeps {
	board: JobBoard;
	keys: RowKeys;
	now?: () => number;
}

interface RowFlags {
	executionStarted: boolean;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	durationMs: number | undefined;
	outputPad: number;
}

interface RowModel {
	dot: { tone: Tone; visible: boolean };
	suffix: string;
	body: string[];
	/** Body lines that should wrap rather than truncate in compact mode (error text). */
	wrapBody: boolean;
}

export interface RowState {
	args?: BashArgs;
	result?: Pick<AgentToolResult<BashDetails>, "content" | "details">;
	flags?: RowFlags;
	theme?: Theme;
	version?: number;
	model?: { version: number; value: RowModel };
	firstSeenAt?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: the tool's parameter schema type is not needed here
type Ctx = Parameters<NonNullable<ToolDefinition<any, BashDetails, RowState>["renderCall"]>>[2];

const ERROR_LINE =
	/^(Command exited with code -?\d+|Command timed out after .+ seconds|Command output exceeded the log size limit.*|Command stopped|Command aborted|Command stopped because the session ended|Command failed to start: .*)$/;
const TRUNCATION_NOTE = /\n*\[Output truncated to the last lines\. Full output: (.+)\]$/;
const OUTPUT_SO_FAR = /\nOutput so far(?: \(end\))?:\n([\s\S]*)$/;

function textOf(result: RowState["result"]): string {
	if (!result) return "";
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function flagsOf(ctx: Ctx, options?: ToolRenderResultOptions): RowFlags {
	return {
		executionStarted: ctx.executionStarted,
		isPartial: options?.isPartial ?? ctx.isPartial,
		isError: ctx.isError,
		expanded: options?.expanded ?? ctx.expanded,
		durationMs: ctx.durationMs,
		outputPad: ctx.outputPad,
	};
}

/** Separate the trailing status line (and truncation note) from the output of a final result. */
export function splitFinalText(text: string): { output: string; error?: string; logPath?: string } {
	let output = text;
	let logPath: string | undefined;
	let error: string | undefined;
	// Error results end with "\n\n<status line>"; a thrown error may be the status line alone.
	const lastBreak = output.lastIndexOf("\n\n");
	const tail = lastBreak >= 0 ? output.slice(lastBreak + 2) : output;
	if (ERROR_LINE.test(tail)) {
		error = tail;
		output = lastBreak >= 0 ? output.slice(0, lastBreak) : "";
	}
	const note = TRUNCATION_NOTE.exec(output);
	if (note) {
		logPath = note[1];
		output = output.slice(0, note.index);
	}
	if (output === "(no output)") output = "";
	return { output, error, logPath };
}

function toneForThrown(error: string): { label: string; tone: Tone } {
	if (error === "Command aborted") return { label: "Interrupted", tone: "warning" };
	if (error === "Command stopped") return { label: "Stopped", tone: "warning" };
	if (error === "Command stopped because the session ended") return { label: "Stopped when the session ended", tone: "muted" };
	const timeout = /^Command timed out after (.+) seconds$/.exec(error);
	if (timeout) return { label: `Timed out after ${formatDuration(Number(timeout[1]) * 1000)}`, tone: "warning" };
	const exit = /^Command exited with code (-?\d+)$/.exec(error);
	if (exit) return { label: `Exit code ${exit[1]}`, tone: "error" };
	return { label: error.replace(/^Command /, ""), tone: "error" };
}

function tailBlock(theme: Theme, lines: string[], expanded: boolean, expandKey: string, keep: "end" | "start" = "end"): string[] {
	if (expanded || lines.length <= COMPACT_OUTPUT_LINES) return lines.map((line) => theme.fg("toolOutput", line));
	const shown = keep === "end" ? lines.slice(-COMPACT_OUTPUT_LINES) : lines.slice(0, COMPACT_OUTPUT_LINES);
	const hint = theme.fg("dim", `… +${lines.length - shown.length} lines (${expandKey} to expand)`);
	const body = shown.map((line) => theme.fg("toolOutput", line));
	return keep === "end" ? [hint, ...body] : [...body, hint];
}

function metaLine(theme: Theme, parts: (string | undefined)[]): string {
	return theme.fg("dim", parts.filter(Boolean).join(" · "));
}

function deadlineText(info: Pick<JobInfo, "timeoutMs" | "startedAt" | "status">, now: number): string | undefined {
	if (!info.timeoutMs) return "no deadline";
	if (info.status !== "running") return `timeout ${formatDuration(info.timeoutMs)}`;
	const left = info.startedAt + info.timeoutMs - now;
	return `killed in ${formatElapsed(Math.max(0, left))} (timeout ${formatDuration(info.timeoutMs)})`;
}

function handoffText(handoff: BashDetails["handoff"]): string | undefined {
	switch (handoff) {
		case "explicit":
			return "started in the background";
		case "auto":
			return "moved to the background automatically";
		case "manual":
			return "moved to the background by you";
	}
	return undefined;
}

function buildModel(state: RowState, deps: RowDeps): RowModel {
	const theme = state.theme!;
	const flags = state.flags!;
	const now = (deps.now ?? Date.now)();
	const board = deps.board;
	const expandKey = safeKey(deps.keys.expand);
	const result = state.result;
	const details = result?.details as BashDetails | undefined;
	const text = textOf(result);
	const blink = board.tick % 2 === 0;

	// Rows restored from history have a result but never saw execution start.
	if (!result) {
		if (!flags.executionStarted) return { dot: { tone: "dim", visible: true }, suffix: "", body: [theme.fg("dim", "Waiting…")], wrapBody: false };
		// Started, first update not yet arrived (or HTML export of the call alone): header only.
		return { dot: { tone: "muted", visible: blink }, suffix: "", body: [], wrapBody: false };
	}

	if (details?.background && !flags.isError) {
		const info = board.get(details.jobId);
		const startedAt = details.startedAt ?? info?.startedAt;
		const body: string[] = [];
		let tone: Tone;
		if (info && info.status === "running") {
			tone = "accent";
			const elapsed = startedAt !== undefined ? ` (${formatElapsed(now - startedAt)})` : "";
			body.push(theme.fg("muted", `Running in the background${elapsed}`) + theme.fg("dim", ` · ${deps.keys.jobs} to manage`));
		} else if (info) {
			const outcome = outcomeOf(info);
			tone = outcome.tone;
			const took = info.endedAt !== undefined ? ` · ${formatDuration(info.endedAt - info.startedAt)}` : "";
			body.push(theme.fg(outcome.tone, outcome.label) + theme.fg("dim", ` · ran in the background${took}`));
		} else {
			tone = "dim";
			body.push(theme.fg("dim", "Ran in the background · status not available in this session"));
		}
		if (flags.expanded) {
			const meta = metaLine(theme, [
				details.jobId,
				info?.pid ? `pid ${info.pid}` : undefined,
				handoffText(details.handoff),
				info ? deadlineText(info, now) : details.timeoutMs ? `timeout ${formatDuration(details.timeoutMs)}` : undefined,
			]);
			body.push(meta);
			const log = info?.logDeleted ? undefined : (info?.logPath ?? details.logPath);
			if (log) body.push(theme.fg("dim", `log ${log}`));
			let lines: string[] = [];
			if (info) lines = outputLines(board.tail(info.id, 4096, 12)?.text ?? "");
			else lines = outputLines(OUTPUT_SO_FAR.exec(text)?.[1] ?? "");
			if (lines.length > 0) body.push(...lines.map((line) => theme.fg("toolOutput", line)));
		}
		return { dot: { tone, visible: true }, suffix: "", body, wrapBody: false };
	}

	if (flags.isPartial) {
		const jobId = details?.jobId;
		if (!state.firstSeenAt) state.firstSeenAt = now;
		const startedAt = details?.startedAt ?? board.get(jobId)?.startedAt ?? state.firstSeenAt;
		const elapsed = now - startedAt;
		const lines = outputLines(text);
		const body = tailBlock(theme, lines, flags.expanded, expandKey);
		const timeout = details?.timeoutMs ? ` · timeout ${formatDuration(details.timeoutMs)}` : "";
		let status = theme.fg("dim", `Running… (${formatElapsed(elapsed)}${timeout})`);
		if (jobId && board.canBackground(jobId) && elapsed >= 1000) {
			status += theme.fg("dim", ` · ${deps.keys.background} to run in background`);
		}
		body.push(status);
		return { dot: { tone: "muted", visible: blink }, suffix: "", body, wrapBody: false };
	}

	// Final foreground result.
	const split = splitFinalText(text);
	const lines = outputLines(split.output);
	const took = flags.durationMs !== undefined && flags.durationMs >= 1000 ? theme.fg("dim", ` · ${formatDuration(flags.durationMs)}`) : "";
	if (!flags.isError) {
		const body = lines.length === 0 ? [theme.fg("dim", "(No output)")] : tailBlock(theme, lines, flags.expanded, expandKey);
		if (flags.expanded) {
			const meta = metaLine(theme, [details?.exitCode !== undefined && details.exitCode !== null ? `exit ${details.exitCode}` : undefined, flags.durationMs !== undefined ? formatDuration(flags.durationMs) : undefined]);
			if (meta) body.push(meta);
			if (split.logPath) body.push(theme.fg("dim", `full output ${split.logPath}`));
		} else if (split.logPath) {
			body.push(theme.fg("dim", "earlier output is in the log"));
		}
		return { dot: { tone: "success", visible: true }, suffix: took, body, wrapBody: false };
	}

	let outcome: { label: string; tone: Tone };
	let outputForError = lines;
	let wrapBody = false;
	if (details?.status && details.status !== "running") {
		outcome = outcomeOf({ status: details.status as JobInfo["status"], exitCode: details.exitCode ?? null, timeoutMs: details.timeoutMs, error: undefined });
		if (details.status === "timed_out" && split.error) outcome = toneForThrown(split.error);
	} else if (split.error) {
		outcome = toneForThrown(split.error);
	} else {
		// A failure before or outside execution (validation, a blocking guard, launch limits).
		outcome = { label: "Error", tone: "error" };
		outputForError = [];
		wrapBody = true;
		const errLines = outputLines(text);
		const shown = flags.expanded ? errLines : errLines.slice(0, COMPACT_OUTPUT_LINES);
		const body = shown.map((line) => theme.fg("error", line));
		if (!flags.expanded && errLines.length > shown.length) body.push(theme.fg("dim", `… +${errLines.length - shown.length} lines (${expandKey} to expand)`));
		return { dot: { tone: "error", visible: true }, suffix: took, body, wrapBody };
	}
	const body = tailBlock(theme, outputForError, flags.expanded, expandKey);
	body.push(theme.fg(outcome.tone, outcome.label));
	if (flags.expanded && split.logPath) body.push(theme.fg("dim", `full output ${split.logPath}`));
	// A timeout label already states the duration.
	const suffix = details?.status === "timed_out" || split.error?.startsWith("Command timed out") ? "" : took;
	return { dot: { tone: outcome.tone, visible: true }, suffix, body, wrapBody };
}

function safeKey(fn: () => string): string {
	try {
		return fn() || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}

function modelOf(state: RowState, deps: RowDeps): RowModel {
	const version = state.version ?? 0;
	if (state.model?.version === version) return state.model.value;
	const value = buildModel(state, deps);
	state.model = { version, value };
	return value;
}

abstract class RowView implements Component {
	protected cache: { width: number; version: number; lines: string[] } | undefined;
	protected state: RowState;
	protected deps: RowDeps;
	constructor(state: RowState, deps: RowDeps) {
		this.state = state;
		this.deps = deps;
	}

	render(width: number): string[] {
		const version = this.state.version ?? 0;
		if (this.cache && this.cache.width === width && this.cache.version === version) return this.cache.lines;
		const pad = this.state.flags?.outputPad ?? 1;
		const inner = Math.max(10, width - pad * 2);
		const lines = padLines(this.renderInner(inner), pad, width);
		this.cache = { width, version, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.state.model = undefined;
	}

	protected abstract renderInner(width: number): string[];
}

class BashCallView extends RowView {
	protected renderInner(width: number): string[] {
		const theme = this.state.theme!;
		const flags = this.state.flags!;
		const model = modelOf(this.state, this.deps);
		const command = this.state.args?.command;
		const dot = model.dot.visible ? theme.fg(model.dot.tone, DOT) : " ";
		const name = theme.bold("Bash");
		if (command === undefined || command === "") {
			const head = [truncateLine(`${dot} ${name}${theme.fg("dim", "(…)")}${model.suffix}`, width)];
			if (!this.state.result) head.push(...prefixLines(model.body, width, theme.fg("dim", GUTTER_FIRST), GUTTER_REST, false));
			return head;
		}
		const display = flags.expanded
			? { lines: sanitize(command).replace(/\n+$/, "").split("\n") }
			: compactCommand(command);
		const cmdLines = display.lines.length > 0 ? display.lines : [""];
		const last = cmdLines.length - 1;
		const styled = cmdLines.map((line, i) => `${i === 0 ? "(" : ""}${line}${i === last ? ")" : ""}`);
		const out = prefixLines(styled, width, `${dot} ${name}`, "       ", flags.expanded);
		// Suffix (duration) on the last header line when it fits.
		if (model.suffix) {
			const lastLine = out[out.length - 1]!;
			out[out.length - 1] = truncateLine(lastLine + model.suffix, width);
		}
		if (flags.expanded && this.state.args?.description) {
			out.push(theme.fg("dim", `  ${sanitize(this.state.args.description).split("\n")[0]}`));
		}
		// Until a result exists, the call view carries the Waiting…/Running… line itself.
		if (!this.state.result) out.push(...prefixLines(model.body, width, theme.fg("dim", GUTTER_FIRST), GUTTER_REST, false));
		return out;
	}
}

function truncateLine(line: string, width: number): string {
	return prefixLines([line], width, "", "", false)[0] ?? "";
}

class BashResultView extends RowView implements RowRefresh {
	rowInvalidate: (() => void) | undefined;

	refresh(): void {
		this.rowInvalidate?.();
	}

	protected renderInner(width: number): string[] {
		const flags = this.state.flags!;
		const model = modelOf(this.state, this.deps);
		if (model.body.length === 0) return [];
		return prefixLines(model.body, width, this.state.theme!.fg("dim", GUTTER_FIRST), GUTTER_REST, flags.expanded || model.wrapBody);
	}
}

interface RowRefresh {
	refresh(): void;
}

function bump(state: RowState): void {
	state.version = (state.version ?? 0) + 1;
	state.model = undefined;
}

/** Renderers for the extension's `bash` tool. */
export function createBashRenderers(deps: RowDeps) {
	return {
		renderShell: "self" as const,
		renderCall(args: BashArgs, theme: Theme, context: Ctx): Component {
			const state = context.state;
			state.args = args;
			state.theme = theme;
			state.flags = flagsOf(context);
			bump(state);
			// While no result exists yet, the call view also shows Waiting…/Running…
			return context.lastComponent instanceof BashCallView ? context.lastComponent : new BashCallView(state, deps);
		},
		renderResult(result: AgentToolResult<BashDetails>, options: ToolRenderResultOptions, theme: Theme, context: Ctx): Component {
			const state = context.state;
			state.result = result;
			state.theme = theme;
			state.args = context.args ?? state.args;
			state.flags = flagsOf(context, options);
			bump(state);
			const view = context.lastComponent instanceof BashResultView ? context.lastComponent : new BashResultView(state, deps);
			view.rowInvalidate = context.invalidate;
			const details = result.details as BashDetails | undefined;
			const live = options.isPartial || (details?.background && !context.isError);
			if (live && details?.jobId) deps.board.watchRow(details.jobId, view);
			return view;
		},
	};
}

/** Exposed for tests: render a row's lines for given inputs without Pi's ToolExecutionComponent. */
export function renderRowForTest(
	deps: RowDeps,
	theme: Theme,
	input: {
		args: BashArgs;
		result?: Pick<AgentToolResult<BashDetails>, "content" | "details">;
		flags?: Partial<RowFlags>;
		state?: RowState;
	},
	width: number,
): string[] {
	const renderers = createBashRenderers(deps);
	const state: RowState = input.state ?? {};
	const flags: RowFlags = {
		executionStarted: true,
		isPartial: false,
		isError: false,
		expanded: false,
		durationMs: undefined,
		outputPad: 1,
		...input.flags,
	};
	const ctx = {
		args: input.args,
		toolCallId: "test",
		invalidate: () => {},
		lastComponent: undefined,
		state,
		cwd: process.cwd(),
		executionStarted: flags.executionStarted,
		argsComplete: true,
		isPartial: flags.isPartial,
		expanded: flags.expanded,
		showImages: false,
		isError: flags.isError,
		durationMs: flags.durationMs,
		outputPad: flags.outputPad,
	} satisfies Ctx;
	// Like Pi: both renderers run first, then the components render.
	const call = renderers.renderCall(input.args, theme, ctx);
	const res = input.result
		? renderers.renderResult(input.result as AgentToolResult<BashDetails>, { expanded: flags.expanded, isPartial: flags.isPartial }, theme, ctx)
		: undefined;
	return [...call.render(width), ...(res?.render(width) ?? [])];
}
