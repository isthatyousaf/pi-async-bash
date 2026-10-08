/**
 * Presentation: formatting, transcript rows, completion notices, jobs widget, jobs panel and the
 * job board's subscription/timer lifetimes. Real Pi themes; no Pi runtime.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { JobInfo } from "../src/manager.ts";
import { JobBoard, type JobSource } from "../src/ui/board.ts";
import { type BashDetails, renderRowForTest, type RowDeps, splitFinalText } from "../src/ui/bash-row.ts";
import { CompletionView, completionPhrase } from "../src/ui/completion.ts";
import { compactCommand, formatDuration, formatElapsed, jobLabel, sanitize } from "../src/ui/format.ts";
import { JobsPanel } from "../src/ui/jobs-panel.ts";
import { JobsWidget } from "../src/ui/jobs-widget.ts";
import { sleep, waitFor } from "./helpers.ts";
import { assertFits, piTheme, plain, WIDTHS } from "./ui-helpers.ts";

const dark = piTheme("dark");
const light = piTheme("light");
const NOW = 1_000_000;

function info(over: Partial<JobInfo> = {}): JobInfo {
	return {
		id: "job-1-abcd",
		command: "npm run build",
		cwd: "/tmp",
		status: "running",
		owner: "background",
		exitCode: null,
		signal: null,
		startedAt: NOW - 12_000,
		logPath: "/tmp/pab/job-1-abcd.log",
		logBytes: 0,
		logDeleted: false,
		delivered: false,
		pid: 4242,
		...over,
	};
}

/** In-memory job source the tests mutate. */
class MemSource implements JobSource {
	jobs = new Map<string, JobInfo>();
	logs = new Map<string, string>();
	constructor(...jobs: JobInfo[]) {
		for (const job of jobs) this.jobs.set(job.id, job);
	}
	list() {
		return [...this.jobs.values()];
	}
	get(id: string) {
		return this.jobs.get(id);
	}
	tail(id: string, _bytes: number, maxLines: number) {
		const lines = (this.logs.get(id) ?? "").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
		const shown = lines.slice(-maxLines);
		return { text: shown.join("\n"), truncated: shown.length < lines.length, totalBytes: 0 };
	}
	set(id: string, over: Partial<JobInfo>) {
		this.jobs.set(id, { ...this.jobs.get(id)!, ...over });
	}
}

function deps(board = new JobBoard()): RowDeps {
	return { board, keys: { expand: () => "ctrl+o", background: "ctrl+alt+b", jobs: "alt+j" }, now: () => NOW };
}

const result = (text: string, details?: BashDetails) => ({ content: text ? [{ type: "text" as const, text }] : [], details: details as BashDetails });

describe("format helpers", () => {
	test("durations", () => {
		assert.equal(formatDuration(420), "0.4s");
		assert.equal(formatDuration(9_870), "9.8s");
		assert.equal(formatDuration(12_400), "12s");
		assert.equal(formatDuration(185_000), "3m 05s");
		assert.equal(formatDuration(3_725_000), "1h 02m");
		assert.equal(formatElapsed(1_999), "1s");
		assert.equal(formatElapsed(-5), "0s");
	});

	test("compact command: two lines and 160 characters", () => {
		assert.deepEqual(compactCommand("ls -la"), { lines: ["ls -la"], truncated: false });
		const three = compactCommand("a\nb\nc");
		assert.deepEqual(three, { lines: ["a", "b…"], truncated: true });
		const long = compactCommand("x".repeat(400));
		assert.equal(long.truncated, true);
		assert.equal([...long.lines[0]!].length, 161);
		assert.ok(long.lines[0]!.endsWith("…"));
		const trailing = compactCommand("echo hi\n");
		assert.deepEqual(trailing, { lines: ["echo hi"], truncated: false });
	});

	test("sanitize strips escapes, shows control bytes, expands tabs", () => {
		assert.equal(sanitize("\x1b[31mred\x1b[0m"), "red");
		assert.equal(sanitize("a\x07b"), "a�b");
		assert.equal(sanitize("lone \x1b esc"), "lone ␛ esc");
		assert.equal(sanitize("a\tb"), "a   b");
		assert.equal(sanitize("one\r\ntwo\rthree"), "one\ntwo\nthree");
	});

	test("job label prefers the description", () => {
		assert.equal(jobLabel({ command: "npm run dev -- --port 3000", description: "Start the dev server" }), "Start the dev server");
		assert.equal(jobLabel({ command: "first line\nsecond" }), "first line…");
	});
});

describe("bash transcript row", () => {
	const cases: { name: string; args: any; res?: ReturnType<typeof result>; flags?: any; expect: RegExp[]; not?: RegExp[] }[] = [
		{ name: "waiting", args: { command: "ls" }, flags: { executionStarted: false, isPartial: true }, expect: [/● Bash\(ls\)/, /⎿ {2}Waiting…/] },
		{ name: "started, no update yet (also HTML export of the call)", args: { command: "sleep 9" }, flags: { isPartial: true }, expect: [/● Bash\(sleep 9\)/], not: [/Running…/, /Waiting/] },
		{
			name: "running with output and timeout",
			args: { command: "make" },
			res: result("l1\nl2\nl3\nl4\nl5\nl6\nl7", { jobId: "job-x", status: "running", startedAt: NOW - 3_400, timeoutMs: 60_000 }),
			flags: { isPartial: true },
			expect: [/… \+2 lines \(ctrl\+o to expand\)/, /l7/, /Running… \(3s · timeout 1m 00s\)/],
			not: [/l1\b/],
		},
		{ name: "success with output", args: { command: "echo hi" }, res: result("hi", { status: "exited", exitCode: 0 }), expect: [/● Bash\(echo hi\)/, /⎿ {2}hi/] },
		{ name: "empty success", args: { command: "true" }, res: result("(no output)", { status: "exited", exitCode: 0 }), expect: [/\(No output\)/] },
		{ name: "output without newline", args: { command: "printf x" }, res: result("partial-line", { status: "exited", exitCode: 0 }), expect: [/partial-line/] },
		{
			name: "failure",
			args: { command: "exit 3" },
			res: result("oops\n\nCommand exited with code 3", { status: "exited", exitCode: 3 }),
			flags: { isError: true },
			expect: [/oops/, /Exit code 3/],
			not: [/Command exited/],
		},
		{
			name: "timeout",
			args: { command: "sleep 5", timeout: 1 },
			res: result("before\n\nCommand timed out after 1 seconds", { status: "timed_out", exitCode: 143 }),
			flags: { isError: true, durationMs: 1000 },
			expect: [/before/, /Timed out after 1\.0s/],
		},
		{ name: "interrupted (thrown)", args: { command: "sleep 9" }, res: result("Command aborted"), flags: { isError: true }, expect: [/Interrupted/] },
		{ name: "blocked by a guard (thrown)", args: { command: "sleep 999" }, res: result("Blocked by test guard"), flags: { isError: true }, expect: [/Blocked by test guard/] },
		{
			name: "truncated output points at the log",
			args: { command: "seq 1 99999" },
			res: result("99998\n99999\n\n[Output truncated to the last lines. Full output: /tmp/x.log]", { status: "exited", exitCode: 0, truncated: true }),
			expect: [/99999/, /earlier output is in the log/],
			not: [/\[Output truncated/],
		},
		{
			name: "restored from history (execution never started in this runtime)",
			args: { command: "echo hi" },
			res: result("hi", { status: "exited", exitCode: 0 }),
			flags: { executionStarted: false },
			expect: [/⎿ {2}hi/],
			not: [/Waiting/],
		},
		{
			name: "background, job gone (resumed session)",
			args: { command: "npm run dev" },
			res: result("Command started in the background as job job-9. It has NOT completed.", { jobId: "job-9", background: true, status: "running" }),
			expect: [/Ran in the background · status not available in this session/],
		},
	];

	for (const c of cases) {
		test(`${c.name} renders within every width, dark and light`, () => {
			for (const theme of [dark, light]) {
				for (const width of WIDTHS) {
					const lines = renderRowForTest(deps(), theme, { args: c.args, result: c.res, flags: c.flags }, width);
					assertFits(lines, width, `${c.name}@${width}`);
					if (width >= 100) {
						const text = plain(lines).join("\n");
						for (const re of c.expect) assert.match(text, re, `${c.name}@${width}`);
						for (const re of c.not ?? []) assert.doesNotMatch(text, re, `${c.name}@${width}`);
					}
				}
			}
		});
	}

	test("long, multiline, ANSI and wide-glyph commands: compact two lines, expanded full", () => {
		const command = `printf '\\x1b[31m' && echo "数据 🚀 ✓"\n${"echo filler; ".repeat(30)}\nthird line`;
		const compact = renderRowForTest(deps(), dark, { args: { command }, result: result("ok", { status: "exited", exitCode: 0 }) }, 80);
		assertFits(compact, 80);
		const header = plain(compact).filter((l) => !l.includes("⎿") && l.trim() !== "ok");
		assert.equal(header.length, 2, "compact header is at most two lines");
		assert.match(header[1]!, /…/);
		const expanded = renderRowForTest(deps(), dark, { args: { command }, result: result("ok", { status: "exited", exitCode: 0 }), flags: { expanded: true } }, 80);
		assertFits(expanded, 80);
		assert.match(plain(expanded).join("\n"), /third line\)/);
		for (const width of [12, 20, 33]) assertFits(renderRowForTest(deps(), dark, { args: { command } }, width), width);
	});

	test("collapsed output shows the tail with a count; expanded shows everything", () => {
		const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const collapsed = plain(renderRowForTest(deps(), dark, { args: { command: "seq" }, result: result(out, { status: "exited", exitCode: 0 }) }, 80));
		assert.ok(collapsed.some((l) => /… \+35 lines/.test(l)));
		assert.ok(collapsed.some((l) => /line 40/.test(l)));
		assert.ok(!collapsed.some((l) => /line 1$/.test(l)));
		const expanded = plain(renderRowForTest(deps(), dark, { args: { command: "seq" }, result: result(out, { status: "exited", exitCode: 0 }), flags: { expanded: true, durationMs: 4200 } }, 80));
		assert.ok(expanded.some((l) => /line 1$/.test(l)));
		assert.ok(expanded.some((l) => /exit 0 · 4\.2s/.test(l)));
		assert.match(expanded[0]!, /· 4\.2s/, "duration on the header");
	});

	test("live background row follows the board: running, then finished, then expanded detail", () => {
		const board = new JobBoard();
		const src = new MemSource(info({ id: "job-b", description: "Build" }));
		src.logs.set("job-b", "compiling\nlinking\n");
		board.setSource(src);
		const d = deps(board);
		const details: BashDetails = { jobId: "job-b", background: true, status: "running", startedAt: NOW - 12_000, handoff: "auto" };
		const running = plain(renderRowForTest(d, dark, { args: { command: "make" }, result: result("moved", details) }, 80)).join("\n");
		assert.match(running, /Running in the background \(12s\) · alt\+j to manage/);
		src.set("job-b", { status: "exited", exitCode: 0, endedAt: NOW });
		const done = plain(renderRowForTest(d, dark, { args: { command: "make" }, result: result("moved", details) }, 80)).join("\n");
		assert.match(done, /Done · ran in the background · 12s/);
		src.set("job-b", { status: "exited", exitCode: 2, endedAt: NOW });
		const failed = plain(renderRowForTest(d, dark, { args: { command: "make" }, result: result("moved", details), flags: { expanded: true } }, 80)).join("\n");
		assert.match(failed, /Exit code 2 · ran in the background/);
		assert.match(failed, /job-b · pid 4242 · moved to the background automatically/);
		assert.match(failed, /linking/);
	});

	test("the background hint appears only while the call can still be moved", () => {
		const board = new JobBoard();
		board.setSource(new MemSource(info({ id: "job-f", owner: "foreground" })));
		const d = deps(board);
		const partial = result("", { jobId: "job-f", status: "running", startedAt: NOW - 5_000 });
		const before = plain(renderRowForTest(d, dark, { args: { command: "x" }, result: partial, flags: { isPartial: true } }, 100)).join("\n");
		assert.doesNotMatch(before, /ctrl\+alt\+b/);
		const release = board.registerForeground("job-f", () => {});
		const during = plain(renderRowForTest(d, dark, { args: { command: "x" }, result: partial, flags: { isPartial: true } }, 100)).join("\n");
		assert.match(during, /Running… \(5s\) · ctrl\+alt\+b to run in background/);
		release();
	});

	test("final text splitting keeps output and recognizes status lines", () => {
		assert.deepEqual(splitFinalText("a\n\nCommand exited with code 2"), { output: "a", error: "Command exited with code 2", logPath: undefined });
		assert.deepEqual(splitFinalText("Command aborted"), { output: "", error: "Command aborted", logPath: undefined });
		assert.equal(splitFinalText("(no output)").output, "");
		assert.equal(splitFinalText("x\n\n[Output truncated to the last lines. Full output: /a b.log]").logPath, "/a b.log");
	});
});

describe("completion notice", () => {
	const job = (over: Partial<JobInfo & { outputTail: string }>) => ({ ...info({ status: "exited", exitCode: 0, endedAt: NOW }), outputTail: "a\nb\nc\nd", ...over });

	test("single job: outcome phrase, label line, short tail; expanded shows command, id and log", () => {
		for (const width of WIDTHS) {
			const view = new CompletionView({ jobs: [job({})] }, "", false, 1, dark, "ctrl+o");
			const lines = view.render(width);
			assertFits(lines, width);
			if (width >= 100) {
				const text = plain(lines).join("\n");
				assert.match(text, /● Background command completed · 12s/);
				assert.match(text, /\$ npm run build/);
				assert.match(text, /… \+1 lines/);
				assert.match(text, /\bd\b/);
			}
		}
		const expanded = plain(new CompletionView({ jobs: [job({ description: "Build it" })] }, "", true, 1, dark, "ctrl+o").render(100)).join("\n");
		assert.match(expanded, /Build it/);
		assert.match(expanded, /\$ npm run build/);
		assert.match(expanded, /job-1-abcd · log \/tmp\/pab\/job-1-abcd\.log/);
		assert.match(expanded, /\ba\b/);
	});

	test("outcome phrases", () => {
		assert.equal(completionPhrase(info({ status: "exited", exitCode: 2 })), "failed with exit code 2");
		assert.equal(completionPhrase(info({ status: "timed_out", timeoutMs: 60_000 })), "timed out after 1m 00s");
		assert.equal(completionPhrase(info({ status: "stopped" })), "was stopped");
		assert.equal(completionPhrase(info({ status: "output_limit" })), "exceeded the output log limit");
	});

	test("many jobs: one line each, capped at eight, all fit", () => {
		const jobs = Array.from({ length: 11 }, (_, i) => job({ id: `job-${i}`, command: `task ${i} 数据`, status: i % 3 ? "exited" : "timed_out", exitCode: i % 2, timeoutMs: 5000 }));
		for (const width of WIDTHS) assertFits(new CompletionView({ jobs }, "", false, 1, light, "ctrl+o").render(width), width);
		const text = plain(new CompletionView({ jobs }, "", false, 1, dark, "ctrl+o").render(100)).join("\n");
		assert.match(text, /11 background commands finished/);
		assert.match(text, /… and 3 more/);
		assert.match(text, /task 1 数据 · failed with exit code 1/);
	});

	test("legacy and malformed details fall back to the message text", () => {
		const legacy = plain(new CompletionView({ jobs: [info({ status: "exited", exitCode: 0, endedAt: NOW })] }, "", false, 1, dark, "ctrl+o").render(80)).join("\n");
		assert.match(legacy, /\(No output\)/);
		const none = plain(new CompletionView(undefined as never, "[bash background job finished]\nBackground job job-1 exited", false, 1, dark, "ctrl+o").render(80));
		assert.match(none.join("\n"), /bash background job finished/);
	});
});

describe("job board lifetimes", () => {
	test("rows refresh on ticks while their job runs, then are dropped; the ticker stops", async () => {
		const board = new JobBoard({ tickMs: 20 });
		const src = new MemSource(info({ id: "j1" }));
		board.setSource(src);
		let refreshed = 0;
		board.watchRow("j1", { refresh: () => refreshed++ });
		board.watchRow("missing", { refresh: () => assert.fail("unknown jobs are not watched") });
		assert.equal(board.tickerActive, true);
		await waitFor(() => refreshed >= 2, 2000, "ticks");
		src.set("j1", { status: "exited", exitCode: 0, endedAt: Date.now() });
		const before = refreshed;
		board.changed("j1");
		assert.equal(refreshed, before + 1, "a finish refreshes the row once more");
		assert.equal(board.watchedRowCount, 0);
		assert.equal(board.tickerActive, false);
		await sleep(60);
		assert.equal(refreshed, before + 1);
		board.dispose();
	});

	test("watchers per job are bounded, subscriptions unsubscribe, dispose clears everything", () => {
		const board = new JobBoard({ tickMs: 10_000 });
		board.setSource(new MemSource(info({ id: "j1" })));
		for (let i = 0; i < 10; i++) board.watchRow("j1", { refresh() {} });
		assert.equal(board.watchedRowCount, 4);
		const off = board.subscribe(() => {});
		assert.equal(board.listenerCount, 1);
		off();
		assert.equal(board.listenerCount, 0);
		board.subscribe(() => {});
		board.dispose();
		assert.equal(board.listenerCount, 0);
		assert.equal(board.watchedRowCount, 0);
		assert.equal(board.tickerActive, false);
		assert.equal(board.subscribe(() => {}) instanceof Function, true);
		assert.equal(board.listenerCount, 0, "no subscriptions after dispose");
	});

	test("manual background triggers fire once and unregister", () => {
		const board = new JobBoard();
		let fired = 0;
		const release = board.registerForeground("j1", () => fired++);
		assert.equal(board.canBackground("j1"), true);
		assert.equal(board.requestBackground(), 1);
		assert.equal(board.requestBackground(), 0);
		assert.equal(fired, 1);
		release();
		board.registerForeground("j2", () => fired++);
		board.reset();
		assert.equal(board.requestBackground("j2"), 0);
	});
});

describe("jobs widget", () => {
	test("hidden without running background jobs; one line otherwise; dispose unsubscribes", () => {
		const board = new JobBoard({ tickMs: 10_000 });
		const src = new MemSource(info({ id: "f", owner: "foreground" }), info({ id: "done", status: "exited", exitCode: 0, endedAt: NOW }));
		board.setSource(src);
		let renders = 0;
		const widget = new JobsWidget(board, dark, "alt+j", () => renders++, () => NOW);
		assert.deepEqual(widget.render(80), []);
		src.jobs.set("b1", info({ id: "b1", description: "Start the dev server" }));
		board.changed("b1");
		assert.ok(renders > 0);
		const one = plain(widget.render(80));
		assert.equal(one.length, 1);
		assert.match(one[0]!, /● Start the dev server · 12s · alt\+j to manage/);
		src.jobs.set("b2", info({ id: "b2", command: "cargo watch -x test 数据🚀" }));
		board.changed("b2");
		for (const width of WIDTHS) assertFits(widget.render(width), width);
		assert.match(plain(widget.render(120))[0]!, /2 background commands · Start the dev server, cargo watch/);
		assert.match(plain(widget.render(40))[0]!, /alt\+j to manage/, "hint survives narrow widths");
		widget.dispose();
		assert.equal(board.listenerCount, 0);
		board.dispose();
	});
});

describe("jobs panel", () => {
	function setup(...jobs: JobInfo[]) {
		const board = new JobBoard({ tickMs: 10_000 });
		const src = new MemSource(...jobs);
		board.setSource(src);
		const stops: string[] = [];
		let closed = 0;
		let renders = 0;
		const panel = new JobsPanel({
			board,
			theme: dark,
			actions: {
				stop: (id) => {
					stops.push(id);
					return true;
				},
			},
			rows: () => 30,
			requestRender: () => renders++,
			close: () => closed++,
			now: () => NOW,
		});
		return { board, src, panel, stops, closed: () => closed, renders: () => renders };
	}

	test("empty state, then lists running before finished; all widths fit", () => {
		const empty = setup();
		assert.match(plain(empty.panel.render(80)).join("\n"), /No shell jobs in this session/);
		const { panel, src } = setup(
			info({ id: "old", status: "exited", exitCode: 0, startedAt: NOW - 50_000, endedAt: NOW - 40_000 }),
			info({ id: "run", command: "npm run dev", description: "Dev server", startedAt: NOW - 65_000, timeoutMs: 600_000 }),
		);
		src.logs.set("run", Array.from({ length: 80 }, (_, i) => `tick ${i + 1}`).join("\n"));
		for (const width of WIDTHS) {
			const lines = panel.render(width);
			assertFits(lines, width, `panel@${width}`);
			assert.ok(lines.length <= 30);
		}
		const text = plain(panel.render(100)).join("\n");
		assert.ok(text.indexOf("Dev server") < text.indexOf("npm run build"), "running first");
		assert.match(text, /\$ npm run dev/);
		assert.match(text, /running 1m 05s · killed in 8m 55s · background · run · pid 4242/);
		assert.match(text, /tick 80/);
		assert.match(text, /x stop/);
	});

	test("selection, log scrolling, follow", () => {
		const { panel, src } = setup(info({ id: "a", startedAt: NOW - 2000 }), info({ id: "b", command: "second", startedAt: NOW - 1000 }));
		src.logs.set("a", Array.from({ length: 100 }, (_, i) => `a${i + 1}`).join("\n"));
		panel.render(100);
		assert.equal(panel.selected, "a");
		panel.handleInput("\x1b[5~"); // PageUp
		let text = plain(panel.render(100)).join("\n");
		assert.doesNotMatch(text, /a100\b/);
		assert.match(text, /End to follow/);
		panel.handleInput("\x1b[F"); // End
		text = plain(panel.render(100)).join("\n");
		assert.match(text, /a100\b/);
		panel.handleInput("g");
		assert.match(plain(panel.render(100)).join("\n"), /\ba1\b/);
		panel.handleInput("\x1b[B"); // Down
		assert.equal(panel.selected, "b");
		panel.handleInput("j");
		assert.equal(panel.selected, "b", "selection clamps at the end");
		panel.handleInput("k");
		assert.equal(panel.selected, "a");
		panel.handleMouse({ type: "scroll", button: "none", x: 2, y: 20, screenX: 2, screenY: 20, width: 100, height: 30, shift: false, alt: false, ctrl: false, wheelDelta: -5 } as never);
		assert.match(plain(panel.render(100)).join("\n"), /End to follow/);
	});

	test("stop needs a second x; any other key cancels; finished jobs cannot be stopped", () => {
		const { panel, stops, src, board } = setup(info({ id: "a" }));
		panel.render(100);
		panel.handleInput("x");
		assert.match(plain(panel.render(100)).join("\n"), /Stop "npm run build"\? x to confirm/);
		panel.handleInput("k");
		panel.handleInput("x");
		panel.handleInput("x");
		assert.deepEqual(stops, ["a"]);
		assert.match(plain(panel.render(100)).join("\n"), /Stopping "npm run build"…/);
		src.set("a", { status: "stopped", exitCode: 143, endedAt: NOW });
		board.changed("a");
		const text = plain(panel.render(100)).join("\n");
		assert.doesNotMatch(text, /Stopping/);
		assert.match(text, /Stopped · 12s/);
		panel.handleInput("x");
		panel.handleInput("x");
		assert.deepEqual(stops, ["a"]);
	});

	test("b moves a foreground command to the background", () => {
		const { panel, board } = setup(info({ id: "fg", owner: "foreground" }));
		let woke = 0;
		board.registerForeground("fg", () => woke++);
		panel.render(100);
		assert.match(plain(panel.render(100)).join("\n"), /b background/);
		panel.handleInput("b");
		assert.equal(woke, 1);
		assert.match(plain(panel.render(100)).join("\n"), /Moved to the background/);
	});

	test("a job finishing while the panel is open updates it; Escape closes and unsubscribes", () => {
		const { panel, src, board, closed, renders } = setup(info({ id: "a" }));
		panel.render(100);
		assert.equal(board.listenerCount, 1);
		src.set("a", { status: "exited", exitCode: 1, endedAt: NOW });
		const before = renders();
		board.changed("a");
		assert.ok(renders() > before, "re-render requested");
		assert.match(plain(panel.render(100)).join("\n"), /Exit code 1/);
		panel.handleInput("\x1b");
		assert.equal(closed(), 1);
		assert.equal(board.listenerCount, 0);
		panel.handleInput("\x1b");
		panel.close();
		assert.equal(closed(), 1, "close is idempotent");
	});

	test("rows never exceed the width with wide glyphs and tiny terminals", () => {
		const { panel, src } = setup(info({ id: "w", command: "echo 数据数据数据 🚀🚀🚀 ✓✓✓ ".repeat(8) }));
		src.logs.set("w", "数据数据数据数据数据数据数据数据数据数据数据数据数据数据数据数据数据数据\n\x1b[31mred\x1b[0m");
		for (const width of [20, 24, 41, 77]) {
			const lines = panel.render(width);
			assertFits(lines, width, `panel@${width}`);
			for (const line of lines) assert.equal(visibleWidth(line), Math.max(20, width), "full-width rows keep the frame aligned");
		}
	});
});
