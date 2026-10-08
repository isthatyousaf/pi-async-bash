/**
 * The presentation layer wired into the extension (fake Pi runtime, real subprocesses): manual
 * handoff, the jobs panel's stop, widget and panel lifetimes, notice details, and that headless
 * modes never touch UI APIs.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { NOTIFY_CUSTOM_TYPE } from "../src/index.ts";
import { BACKGROUND_KEY, JOBS_KEY, WIDGET_KEY } from "../src/ui/install.ts";
import type { JobsPanel } from "../src/ui/jobs-panel.ts";
import { FakeRuntime, text } from "./fake-pi.ts";
import { alive, sleep, tempDir, waitFor } from "./helpers.ts";
import { piTheme, plain } from "./ui-helpers.ts";

process.env.PI_ASYNC_BASH_LOG_DIR = tempDir("pab-uiext-logs-");
delete process.env.PI_ASYNC_BASH_FOREGROUND_MS;

const dark = piTheme("dark");
const runtimes: FakeRuntime[] = [];
function runtime(sessionId: string, budget = "300", ui = true): FakeRuntime {
	const rt = new FakeRuntime(sessionId, { "bash-foreground-ms": budget });
	if (ui) rt.withUI(dark);
	runtimes.push(rt);
	return rt;
}
after(async () => {
	for (const rt of runtimes) await rt.emit("session_shutdown", { reason: "quit" });
});

const noticeOf = (rt: FakeRuntime) => rt.sent.filter((s) => s.message.customType === NOTIFY_CUSTOM_TYPE);

async function openPanel(rt: FakeRuntime): Promise<{ panel: JobsPanel; closed: Promise<void> }> {
	const closed = rt.commands.get("bash-jobs")!.handler("", rt.ctx());
	const entry = rt.ui!.customs.at(-1)!;
	assert.equal(entry.options.overlay, true);
	return { panel: entry.component as JobsPanel, closed };
}

describe("registration and modes", () => {
	test("registers renderer, command and two non-conflicting shortcuts", () => {
		const rt = runtime("reg", "300", false);
		assert.ok(rt.messageRenderers.has(NOTIFY_CUSTOM_TYPE));
		assert.ok(rt.commands.has("bash-jobs"));
		assert.deepEqual([...rt.shortcuts.keys()].sort(), [BACKGROUND_KEY, JOBS_KEY].sort());
		for (const key of rt.shortcuts.keys()) assert.ok(!["ctrl+b", "down", "ctrl+c", "escape", "ctrl+o"].includes(key));
	});

	test("headless (rpc): no UI calls, same execution and delivery", async () => {
		const rt = runtime("rpc-mode", "300", false);
		await rt.emit("session_start", { reason: "startup" });
		const result = await rt.bash({ command: "sleep 0.5; echo rpc-done" });
		assert.equal(result.details.background, true);
		await waitFor(() => noticeOf(rt).length === 1, 3000, "notice");
		assert.match(noticeOf(rt)[0]!.message.content, /rpc-done/);
		// /bash-jobs without a UI does nothing (and does not throw).
		await rt.commands.get("bash-jobs")!.handler("", rt.ctx());
	});

	test("tui: the jobs widget appears with a background job and goes away when it ends", async () => {
		const rt = runtime("widget");
		await rt.emit("session_start", { reason: "startup" });
		const widget = rt.ui!.widgets.get(WIDGET_KEY);
		assert.ok(widget, "widget installed below the editor");
		assert.deepEqual(widget.render(80), []);
		await rt.bash({ command: "sleep 0.6", run_in_background: true, description: "Warm the cache" });
		assert.match(stripTerminalSequences(widget.render(80)[0] ?? ""), /Warm the cache · \d+s · alt\+j to manage/);
		await waitFor(() => widget.render(80).length === 0, 3000, "widget to clear");
		await rt.emit("session_shutdown", { reason: "quit" });
		const renders = rt.ui!.renders;
		await sleep(1200);
		assert.equal(rt.ui!.renders, renders, "no render requests after shutdown");
	});
});

describe("manual background handoff", () => {
	test("returns control with the budget off, then the completion arrives exactly once", async () => {
		const rt = runtime("manual-off", "off");
		await rt.emit("session_start", { reason: "startup" });
		const updates: any[] = [];
		const started = Date.now();
		const pending = rt.bash({ command: "echo early; sleep 0.8; echo manual-done" }, undefined, (u: any) => updates.push(u));
		await waitFor(() => updates.length > 0, 2000, "first update");
		await sleep(150);
		await rt.shortcuts.get(BACKGROUND_KEY)!.handler(rt.ctx());
		const result = await pending;
		assert.ok(Date.now() - started < 700, "the call returned before the command finished");
		assert.equal(result.details.background, true);
		assert.equal(result.details.handoff, "manual");
		assert.match(text(result), /The user moved this command to the background/);
		assert.match(text(result), /NOT completed/);
		assert.match(text(result), /early/);
		assert.equal(updates[0].details.startedAt > 0, true);
		await waitFor(() => noticeOf(rt).length === 1, 3000, "completion notice");
		await sleep(300);
		assert.equal(noticeOf(rt).length, 1);
		assert.match(noticeOf(rt)[0]!.message.content, /manual-done/);
	});

	test("with nothing in the foreground the shortcut only informs", async () => {
		const rt = runtime("manual-none");
		await rt.shortcuts.get(BACKGROUND_KEY)!.handler(rt.ctx());
		assert.match(rt.ui!.notifications.at(-1)!.message, /No foreground bash command/);
	});

	test("manual handoff/exit race: exactly one report per command", async () => {
		const rt = runtime("manual-race", "off");
		for (let i = 0; i < 10; i++) {
			const before = noticeOf(rt).length;
			const pending = rt.bash({ command: `sleep 0.0${i}; echo r${i}` });
			await sleep(i * 9);
			await rt.shortcuts.get(BACKGROUND_KEY)!.handler(rt.ctx());
			const result = await pending;
			await sleep(250);
			if (result.details.background) assert.equal(noticeOf(rt).length, before + 1, `iteration ${i} notified`);
			else {
				assert.equal(text(result), `r${i}`);
				assert.equal(noticeOf(rt).length, before, `iteration ${i} reported in the foreground only`);
			}
		}
	});

	test("silent commands send one update; output updates only when the log grows", async () => {
		const rt = runtime("updates", "off");
		const silent: any[] = [];
		await rt.bash({ command: "sleep 0.8" }, undefined, (u: any) => silent.push(u));
		assert.equal(silent.length, 1);
		const noisy: any[] = [];
		await rt.bash({ command: "for i in 1 2 3; do echo $i; sleep 0.3; done" }, undefined, (u: any) => noisy.push(u));
		assert.ok(noisy.length >= 3 && noisy.length <= 6, `updates: ${noisy.length}`);
		assert.match(noisy.at(-1).content[0].text, /3/);
	});
});

describe("jobs panel through the extension", () => {
	test("stop from the panel: the model is told once that the user stopped it", async () => {
		const rt = runtime("panel-stop");
		const started = await rt.bash({ command: "sleep 30", run_in_background: true });
		const pid = (await rt.job({ action: "status", job_id: started.details.jobId })).details.pid as number;
		const { panel, closed } = await openPanel(rt);
		assert.match(plain(panel.render(100)).join("\n"), /sleep 30/);
		panel.handleInput("x");
		panel.handleInput("x");
		await waitFor(() => !alive(pid), 4000, "job to stop");
		await waitFor(() => noticeOf(rt).length === 1, 3000, "stop notice");
		assert.match(noticeOf(rt)[0]!.message.content, /was stopped by the user/);
		assert.match(plain(panel.render(100)).join("\n"), /Stopped/);
		panel.handleInput("\x1b");
		await closed;
		await sleep(300);
		assert.equal(noticeOf(rt).length, 1);
	});

	test("b in the panel moves a foreground command; second open while open is ignored", async () => {
		const rt = runtime("panel-bg", "off");
		const pending = rt.bash({ command: "sleep 0.5; echo from-panel" });
		await sleep(100);
		const { panel, closed } = await openPanel(rt);
		void rt.commands.get("bash-jobs")!.handler("", rt.ctx());
		assert.equal(rt.ui!.customs.length, 1, "only one panel");
		panel.render(100);
		panel.handleInput("b");
		const result = await pending;
		assert.equal(result.details.handoff, "manual");
		panel.handleInput("q");
		await closed;
		await waitFor(() => noticeOf(rt).length === 1, 3000, "notice");
	});

	test("session shutdown closes an open panel and stops its updates", async () => {
		const rt = runtime("panel-shutdown");
		await rt.bash({ command: "sleep 30", run_in_background: true });
		const { closed } = await openPanel(rt);
		await rt.emit("session_shutdown", { reason: "new" });
		await closed;
		assert.equal(rt.ui!.customs[0]!.closed, true);
	});
});

describe("completion notice", () => {
	test("details carry a display tail; the model content is unchanged and rendered compactly", async () => {
		const rt = runtime("notice-details");
		await rt.bash({ command: "printf 'a\\nb\\n'; echo 'last line'", run_in_background: true, description: "Print lines" });
		await waitFor(() => noticeOf(rt).length === 1, 3000, "notice");
		const message = noticeOf(rt)[0]!.message as any;
		assert.match(message.content, /^\[bash background job finished\]\nBackground job job-\d+-[0-9a-f]+ exited with code 0 after/);
		assert.equal(message.details.jobs[0].outputTail, "a\nb\nlast line");
		assert.equal(message.details.jobs[0].description, "Print lines");
		const view = rt.messageRenderers.get(NOTIFY_CUSTOM_TYPE)!(message, { expanded: false, outputPad: 1 }, dark);
		const lines = plain(view.render(80)).join("\n");
		assert.match(lines, /● Background command completed/);
		assert.match(lines, /Print lines/);
		assert.match(lines, /last line/);
		assert.doesNotMatch(lines, /\[bash background job finished\]/);
	});

	test("model switch keeps jobs visible in the UI and controllable", async () => {
		const rt = runtime("model-switch");
		await rt.emit("session_start", { reason: "startup" });
		const widget = rt.ui!.widgets.get(WIDGET_KEY);
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		rt.model = { provider: "p2", id: "m2" };
		await rt.emit("model_select", { model: rt.model, source: "set" });
		assert.match(stripTerminalSequences(widget.render(80)[0] ?? ""), /sleep 30/);
		assert.match(text(await rt.job({ action: "stop", job_id: result.details.jobId })), /was stopped/);
	});
});
