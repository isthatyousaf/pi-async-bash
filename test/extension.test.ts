import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { NOTIFY_CUSTOM_TYPE, parseForegroundMs, resolveConfig, resolveTimeoutMs } from "../src/index.ts";
import { FakeRuntime, text } from "./fake-pi.ts";
import { alive, sleep, tempDir, waitFor } from "./helpers.ts";

process.env.PI_ASYNC_BASH_LOG_DIR = tempDir("pab-ext-logs-");
delete process.env.PI_ASYNC_BASH_FOREGROUND_MS;

const runtimes: FakeRuntime[] = [];
function runtime(sessionId = "session-a", budget = "300"): FakeRuntime {
	const rt = new FakeRuntime(sessionId, { "bash-foreground-ms": budget });
	runtimes.push(rt);
	return rt;
}
after(async () => {
	for (const rt of runtimes) await rt.emit("session_shutdown", { reason: "quit" });
});

const noticeOf = (rt: FakeRuntime) => rt.sent.filter((s) => s.message.customType === NOTIFY_CUSTOM_TYPE);

describe("registration and config", () => {
	test("registers only bash and bash_job (no Codex tools)", () => {
		const rt = runtime();
		assert.deepEqual([...rt.tools.keys()].sort(), ["bash", "bash_job"]);
		for (const name of ["exec", "wait", "exec_command", "write_stdin", "apply_patch"]) assert.equal(rt.tools.has(name), false);
		const params = (rt.tools.get("bash") as any).parameters;
		assert.deepEqual(Object.keys(params.properties).sort(), ["command", "description", "run_in_background", "timeout"]);
		assert.deepEqual(params.required, ["command"]);
	});

	test("timeout validation in seconds", () => {
		assert.equal(resolveTimeoutMs(undefined), undefined);
		assert.equal(resolveTimeoutMs(1.5), 1500);
		for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484]) assert.throws(() => resolveTimeoutMs(bad), /Invalid timeout/);
	});

	test("foreground budget is user configuration, off in one-shot modes", () => {
		assert.equal(parseForegroundMs("off"), null);
		assert.equal(parseForegroundMs("0"), null);
		assert.equal(parseForegroundMs("1500"), 1500);
		assert.throws(() => parseForegroundMs("2s"));
		assert.equal(resolveConfig(undefined, "tui", {}).foregroundMs, 2000);
		assert.equal(resolveConfig(undefined, "rpc", {}).foregroundMs, 2000);
		assert.equal(resolveConfig(undefined, "print", {}).foregroundMs, null);
		assert.equal(resolveConfig(undefined, "json", { PI_ASYNC_BASH_FOREGROUND_MS: "700" }).foregroundMs, 700);
		assert.equal(resolveConfig("900", "tui", { PI_ASYNC_BASH_FOREGROUND_MS: "700" }).foregroundMs, 900);
	});

	test("an explicit off keeps precedence over defaults and env", () => {
		assert.equal(resolveConfig("off", "tui", {}).foregroundMs, null);
		assert.equal(resolveConfig("0", "rpc", {}).foregroundMs, null);
		assert.equal(resolveConfig("off", "tui", { PI_ASYNC_BASH_FOREGROUND_MS: "700" }).foregroundMs, null);
		assert.equal(resolveConfig(undefined, "tui", { PI_ASYNC_BASH_FOREGROUND_MS: "off" }).foregroundMs, null);
		assert.equal(resolveConfig(undefined, "tui", { PI_ASYNC_BASH_FOREGROUND_MS: "0" }).foregroundMs, null);
		assert.equal(resolveConfig("900", "print", { PI_ASYNC_BASH_FOREGROUND_MS: "off" }).foregroundMs, 900);
		assert.equal(resolveConfig("", "tui", { PI_ASYNC_BASH_FOREGROUND_MS: "off" }).foregroundMs, null);
	});

	test("the off flag makes bash wait for completion", async () => {
		const rt = runtime("off-flag", "off");
		const result = await rt.bash({ command: "sleep 0.6; echo waited-fully" });
		assert.equal(result.details.background, undefined);
		assert.equal(text(result), "waited-fully");
	});
});

describe("bash tool", () => {
	test("quick foreground exit returns output; log of a short run is removed", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "echo hi; echo there >&2" });
		assert.equal(text(result), "hi\nthere");
		assert.equal(result.isError, undefined);
		assert.equal(result.structuredContent.exit_code, 0);
		assert.equal(result.structuredContent.status, "exited");
		assert.equal((await rt.job({ action: "list" })).content[0].text, "No background jobs in this session.");
	});

	test("nonzero exit is a tool error", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "echo nope; exit 4" });
		assert.equal(result.isError, true);
		assert.match(text(result), /nope\n\nCommand exited with code 4/);
	});

	test("session env and shellCommandPrefix match the builtin", async () => {
		const rt = runtime();
		rt.settings = { shellCommandPrefix: "export PAB_PREFIX=yes" };
		const result = await rt.bash({ command: 'echo "$PAB_PREFIX $PI_SESSION_ID $PI_MODEL"' });
		assert.equal(text(result), "yes session-a m1");
	});

	test("large output is truncated with a retained full log", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "seq 1 3000" });
		const out = text(result);
		assert.match(out, /^1001\n/);
		assert.match(out, /3000\n\n\[Output truncated/);
		assert.ok(fs.existsSync(result.details.logPath));
		assert.equal(result.structuredContent.full_output_path, result.details.logPath);
	});

	test("automatic handoff after the budget, then one idle notification", async () => {
		const rt = runtime();
		const started = Date.now();
		const result = await rt.bash({ command: "echo early; sleep 0.7; echo late-done" });
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 280 && elapsed < 900, `handoff after ${elapsed} ms`);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.background, true);
		assert.equal(result.structuredContent.status, "running");
		assert.match(text(result), /NOT completed/);
		assert.match(text(result), /early/);
		const jobId = result.details.jobId;
		await waitFor(() => noticeOf(rt).length === 1, 3000, "notification");
		await sleep(300);
		const notices = noticeOf(rt);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.options?.triggerTurn, true);
		const body = notices[0]!.message.content;
		assert.match(body, new RegExp(`${jobId} exited with code 0`));
		assert.match(body, /late-done/);
		assert.match(body, new RegExp(result.details.logPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	test("output activity does not extend the foreground budget", async () => {
		const rt = runtime();
		const started = Date.now();
		const updates: unknown[] = [];
		const result = await rt.bash({ command: "for i in $(seq 1 100); do echo $i; sleep 0.02; done" }, undefined, (u: unknown) =>
			updates.push(u),
		);
		const elapsed = Date.now() - started;
		assert.equal(result.details.background, true);
		assert.ok(elapsed < 900, `returned after ${elapsed} ms`);
		await rt.job({ action: "stop", job_id: result.details.jobId });
	});

	test("explicit background returns after launch", async () => {
		const rt = runtime();
		const started = Date.now();
		const result = await rt.bash({ command: "sleep 0.3; echo bg-done", run_in_background: true });
		assert.ok(Date.now() - started < 250);
		assert.equal(result.details.background, true);
		assert.match(text(result), /started in the background/);
		await waitFor(() => noticeOf(rt).length === 1, 3000, "notification");
		assert.match(noticeOf(rt)[0]!.message.content, /bg-done/);
	});

	test("hard timeout still applies after handoff", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "sleep 10", timeout: 0.8 });
		assert.equal(result.details.background, true);
		assert.match(text(result), /killed if still running 0.8 seconds/);
		await waitFor(() => noticeOf(rt).length === 1, 3000, "timeout notification");
		assert.match(noticeOf(rt)[0]!.message.content, /killed after its 0.8-second timeout/);
	});

	test("a timeout is reported even when the command exits 0 on SIGTERM", async () => {
		const cmd = "trap 'exit 0' TERM; echo READY; while :; do sleep 0.01; done";
		const fg = await runtime("t1", "off").bash({ command: cmd, timeout: 0.4 });
		assert.equal(fg.isError, true);
		assert.match(text(fg), /Command timed out after 0.4 seconds/);
		assert.equal(fg.structuredContent.status, "timed_out");
		const rt = runtime("t2", "150");
		const bg = await rt.bash({ command: cmd, timeout: 0.6 });
		assert.equal(bg.details.background, true);
		await waitFor(() => noticeOf(rt).length === 1, 3000, "timeout notice");
		assert.match(noticeOf(rt)[0]!.message.content, /killed after its 0.6-second timeout/);
		assert.doesNotMatch(noticeOf(rt)[0]!.message.content, /exited with code 0/);
	});

	test("repeated truncated foreground results stay inside the session log budget", async () => {
		process.env.PI_ASYNC_BASH_SESSION_LOG_MB = "1";
		process.env.PI_ASYNC_BASH_MAX_LOG_MB = "1";
		try {
			const rt = runtime("budget");
			let dir = "";
			let lastLog = "";
			for (let i = 0; i < 6; i++) {
				const result = await rt.bash({ command: "seq 1 60000" }); // ~350 KB, truncated to 2000 lines
				assert.match(text(result), /Output truncated/);
				lastLog = result.details.logPath;
				dir = dirname(lastLog);
			}
			const sizes = fs.readdirSync(dir).map((f) => fs.statSync(join(dir, f)).size);
			const total = sizes.reduce((a, b) => a + b, 0);
			assert.ok(total <= 1024 * 1024, `retained ${total} bytes in ${sizes.length} logs`);
			assert.ok(sizes.length < 6, "older truncated logs were evicted");
			assert.ok(fs.existsSync(lastLog), "the newest referenced log is kept");
			assert.equal(text(await rt.job({ action: "list" })), "No background jobs in this session.");
		} finally {
			delete process.env.PI_ASYNC_BASH_SESSION_LOG_MB;
			delete process.env.PI_ASYNC_BASH_MAX_LOG_MB;
		}
	});

	test("foreground timeout is a tool error", async () => {
		const rt = runtime("s", "off");
		const result = await rt.bash({ command: "echo x; sleep 10", timeout: 0.3 });
		assert.equal(result.isError, true);
		assert.match(text(result), /x\n\nCommand timed out after 0.3 seconds/);
	});

	test("aborting a foreground call kills its process tree", async () => {
		const rt = runtime("s", "5000");
		const ac = new AbortController();
		let latest = "";
		const pending = rt.bash({ command: "sleep 30 & echo $!; wait" }, ac.signal, (u: any) => {
			latest = u.content.map((c: any) => c.text).join("");
		});
		await waitFor(() => /^\d+$/m.test(latest), 3000, "descendant pid in progress update");
		const pid = Number(latest.trim());
		assert.ok(alive(pid));
		ac.abort();
		await assert.rejects(pending, /Command aborted/);
		await waitFor(() => !alive(pid), 3000, "descendant to die");
	});

	test("abort after handoff does not stop the background job", async () => {
		const rt = runtime();
		const ac = new AbortController();
		const result = await rt.bash({ command: "sleep 30" }, ac.signal);
		assert.equal(result.details.background, true);
		ac.abort();
		await sleep(100);
		const status = await rt.job({ action: "status", job_id: result.details.jobId });
		assert.match(text(status), /still running/);
		const pid = status.details.pid as number;
		assert.ok(alive(pid));
		const stopped = await rt.job({ action: "stop", job_id: result.details.jobId });
		assert.match(text(stopped), /was stopped/);
		await waitFor(() => !alive(pid), 3000, "stopped process to exit");
		await sleep(400);
		assert.equal(noticeOf(rt).length, 0, "explicitly stopped jobs are not re-announced");
	});
});

describe("delivery", () => {
	test("busy agent: delivered once at turn_end through a boundary entry", async () => {
		const rt = runtime();
		rt.idle = false;
		const result = await rt.bash({ command: "sleep 0.5; echo busy-done" });
		assert.equal(result.details.background, true);
		await sleep(700);
		assert.equal(noticeOf(rt).length, 0, "no direct send while busy");
		const [first] = await rt.emit("turn_end", { outcome: "completed" });
		assert.equal(first.continue, true);
		assert.equal(first.entries.length, 1);
		assert.equal(first.entries[0].type, "custom_message");
		assert.equal(first.entries[0].customType, NOTIFY_CUSTOM_TYPE);
		assert.match(first.entries[0].content, /busy-done/);
		const [second] = await rt.emit("turn_end", { outcome: "completed" });
		assert.equal(second, undefined);
		rt.idle = true;
		await sleep(1200);
		assert.equal(noticeOf(rt).length, 0, "no duplicate after the agent becomes idle");
	});

	test("aborted run: notice is recorded without triggering a turn", async () => {
		const rt = runtime();
		rt.idle = false;
		await rt.bash({ command: "sleep 0.4", run_in_background: true });
		await sleep(600);
		assert.deepEqual(await rt.emit("turn_end", { outcome: "aborted" }), [undefined]);
		await rt.emit("agent_settled", { aborted: true });
		assert.equal(noticeOf(rt).length, 1);
		assert.equal(noticeOf(rt)[0]!.options?.triggerTurn, false);
	});

	test("after a user abort, later completions are recorded without starting a turn until a new run", async () => {
		const rt = runtime();
		await rt.emit("agent_start");
		await rt.emit("agent_settled", { aborted: true });
		await rt.bash({ command: "sleep 0.4; echo after-abort", run_in_background: true });
		await waitFor(() => noticeOf(rt).length === 1, 3000, "late notice");
		assert.equal(noticeOf(rt)[0]!.options?.triggerTurn, false);
		assert.match(noticeOf(rt)[0]!.message.content, /after-abort/);
		await rt.emit("agent_start");
		await rt.emit("agent_settled", { aborted: false });
		await rt.bash({ command: "sleep 0.2", run_in_background: true });
		await waitFor(() => noticeOf(rt).length === 2, 3000, "second notice");
		assert.equal(noticeOf(rt)[1]!.options?.triggerTurn, true);
	});

	test("bash_job wait delivers the result and suppresses the notification", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "sleep 0.5; echo waited" });
		const waited = await rt.job({ action: "wait", job_id: result.details.jobId, timeout: 5 });
		assert.match(text(waited), /exited with code 0/);
		assert.match(text(waited), /waited/);
		await sleep(500);
		assert.equal(noticeOf(rt).length, 0);
	});

	test("bounded wait returns while the job keeps running", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		const started = Date.now();
		const waited = await rt.job({ action: "wait", job_id: result.details.jobId, timeout: 0.3 });
		assert.ok(Date.now() - started < 1000);
		assert.match(text(waited), /still running/);
		await rt.job({ action: "stop", job_id: result.details.jobId });
		await assert.rejects(rt.job({ action: "status", job_id: "job-404" }), /Unknown job/);
		await assert.rejects(rt.job({ action: "wait" }), /job_id is required/);
	});

	test("simultaneous completions are coalesced into one notice", async () => {
		const rt = runtime();
		await rt.bash({ command: "sleep 0.3; echo one", run_in_background: true });
		await rt.bash({ command: "sleep 0.3; echo two", run_in_background: true });
		await waitFor(() => noticeOf(rt).length >= 1, 3000, "notice");
		await sleep(300);
		assert.equal(noticeOf(rt).length, 1);
		assert.match(noticeOf(rt)[0]!.message.content, /2 bash background jobs finished/);
	});

	test("handoff/exit race: exactly one of foreground result or notification", async () => {
		const rt = runtime("race", "150");
		let notified = 0;
		let foreground = 0;
		for (let i = 0; i < 12; i++) {
			const before = noticeOf(rt).length;
			const result = await rt.bash({ command: `sleep 0.1${i % 10}` });
			if (result.details.background) {
				await waitFor(() => noticeOf(rt).length === before + 1, 3000, "race notification");
				notified++;
			} else {
				foreground++;
			}
			await sleep(250);
			assert.equal(noticeOf(rt).length, before + (result.details.background ? 1 : 0), `iteration ${i}`);
		}
		assert.equal(notified + foreground, 12);
	});
});

describe("session lifecycle", () => {
	test("session_shutdown stops jobs and nothing is delivered afterwards", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		const status = await rt.job({ action: "status", job_id: result.details.jobId });
		const pid = status.details.pid as number;
		await rt.emit("session_shutdown", { reason: "new" });
		await waitFor(() => !alive(pid), 3000, "job to die on shutdown");
		await sleep(400);
		assert.equal(rt.sent.length, 0);
		await assert.rejects(rt.bash({ command: "true" }), /shut down/);
	});

	test("reload: the old runtime's late completion never reaches the new runtime", async () => {
		const oldRt = runtime("same-session");
		await oldRt.bash({ command: "sleep 0.3", run_in_background: true });
		await oldRt.emit("session_shutdown", { reason: "reload" });
		oldRt.stale = true;
		const newRt = runtime("same-session");
		await newRt.emit("session_start", { reason: "reload" });
		await sleep(800);
		assert.equal(oldRt.sent.length, 0);
		assert.equal(newRt.sent.length, 0);
		assert.equal((await newRt.job({ action: "list" })).content[0].text, "No background jobs in this session.");
	});

	test("session id change inside one runtime retires the old jobs", async () => {
		const rt = runtime("first");
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		const pid = (await rt.job({ action: "status", job_id: result.details.jobId })).details.pid as number;
		rt.sessionId = "second";
		await rt.bash({ command: "true" });
		await waitFor(() => !alive(pid), 3000, "old job to stop");
		await assert.rejects(rt.job({ action: "status", job_id: result.details.jobId }), /Unknown job/);
		await sleep(300);
		assert.equal(noticeOf(rt).length, 0);
	});

	test("job controls are session-guarded even when bash_job is the first call in a new session", async () => {
		const rt = runtime("old-session");
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		const pid = (await rt.job({ action: "status", job_id: result.details.jobId })).details.pid as number;
		try {
			rt.sessionId = "new-session";
			await assert.rejects(rt.job({ action: "status", job_id: result.details.jobId }), /Unknown job/);
			await assert.rejects(rt.job({ action: "stop", job_id: result.details.jobId }), /Unknown job/);
			assert.equal(text(await rt.job({ action: "list" })), "No background jobs in this session.");
			await waitFor(() => !alive(pid), 3000, "old-session job to stop");
			// The turn boundary of the new session delivers nothing from the old one.
			assert.deepEqual(await rt.emit("turn_end", { outcome: "completed" }), [undefined]);
			await sleep(300);
			assert.equal(noticeOf(rt).length, 0);
		} finally {
			if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	test("stale sendMessage is swallowed", async () => {
		const rt = runtime();
		rt.stale = true;
		await rt.bash({ command: "true", run_in_background: true });
		await sleep(400);
		assert.equal(rt.sent.length, 0);
	});

	test("same-session model switch keeps job controls usable", async () => {
		const rt = runtime();
		const result = await rt.bash({ command: "sleep 30", run_in_background: true });
		rt.model = { provider: "p2", id: "m2" };
		await rt.emit("model_select", { model: rt.model, source: "set" });
		assert.match(text(await rt.job({ action: "status", job_id: result.details.jobId })), /still running/);
		assert.match(text(await rt.job({ action: "list" })), new RegExp(result.details.jobId));
		assert.equal(text(await rt.bash({ command: 'echo "$PI_PROVIDER/$PI_MODEL"' })), "p2/m2");
		assert.match(text(await rt.job({ action: "stop", job_id: result.details.jobId })), /was stopped/);
	});
});

