import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JobManager } from "../src/manager.ts";
import { waitForBackgroundResult } from "../src/headless.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const cli = join(packageRoot, manifest.bin.pi);
const extension = resolve(import.meta.dirname, "../src/index.ts");
const provider = resolve(import.meta.dirname, "fixtures/headless-provider.ts");

for (const scenario of ["case-auto", "case-explicit", "case-timeout", "case-multiple", "case-abort"]) {
	test(`real headless child delivers background result before exit: ${scenario}`, () => {
		const root = mkdtempSync(join(tmpdir(), "pab-headless-"));
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_ASYNC_BASH_") || key === "PI_DENY_TOOLS") delete env[key];
		}
		Object.assign(env, { PI_CODING_AGENT_DIR: join(root, "agent"), PI_ASYNC_BASH_LOG_DIR: join(root, "logs") });
		try {
			const result = spawnSync(process.execPath, [
				cli, "-p", "--mode", "json", "-ne", "-nc", "-ns", "-np", "--no-mcp", "--no-session", "--offline",
				"-e", provider, "-e", extension, "--model", "faux/faux-1", "--thinking", "off",
				"--bash-foreground-ms", "30", scenario,
			], { cwd: root, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
			assert.equal(result.status, 0, result.stderr);
			const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
			const results = records.filter((event) => event.type === "tool_execution_end");
			assert.ok(results.some((event) => event.result.details?.status === "running"), "shell call actually handed off");
			assert.ok(results.some((event) => event.result.content?.some((block: any) => block.text === "INDEPENDENT_WORK")), "model did other work after handoff");
			const notices = records.filter((event) => event.type === "message_end" && event.message?.customType === "bash-job-complete");
			// Boundary messages are persisted via entry_appended rather than message_end in some Pi modes.
			const boundaryNotices = records.filter((event) => event.type === "entry_appended" && event.entry?.customType === "bash-job-complete");
			if (scenario === "case-abort") {
				assert.equal(notices.length + boundaryNotices.length, 0, "abort releases the join without a completion turn");
				assert.ok(records.some((event) => event.type === "agent_settled" && event.aborted));
			} else {
				const expected = scenario === "case-timeout" ? "FINAL_TIMEOUT_OBSERVED" : "FINAL_COMPLETION_OBSERVED";
				assert.ok(records.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((block: any) => block.text === expected)), "model observed the final result before exit");
				const delivered = [...notices.map((event) => event.message), ...boundaryNotices.map((event) => event.entry)]
					.flatMap((notice) => notice.details.jobs);
				assert.equal(delivered.length, scenario === "case-multiple" ? 2 : 1);
				assert.equal(new Set(delivered.map((job) => job.id)).size, delivered.length, "one delivery per job");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("headless join waits for the first result without stopping other jobs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pab-join-"));
	const manager = new JobManager({ logDir: root, shell: "/bin/bash", shellArgs: ["-c"], unref: true });
	try {
		const slow = manager.start({ command: "sleep 4", cwd: root, background: true });
		const fast = manager.start({ command: "sleep 0.1; echo done", cwd: root, background: true });
		await waitForBackgroundResult(manager);
		assert.equal(fast.running, false);
		assert.equal(slow.running, true);
		const abort = new AbortController();
		const waiting = waitForBackgroundResult(manager, abort.signal);
		abort.abort();
		await waiting;
		assert.equal(slow.running, true, "cancelling a wait must not kill a job");
	} finally {
		manager.dispose();
		await Promise.all(manager.list().map((job) => manager.wait(job, 5000)));
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty or already-aborted headless join returns without creating resources", async () => {
	const root = mkdtempSync(join(tmpdir(), "pab-empty-join-"));
	const manager = new JobManager({ logDir: root, shell: "/bin/bash", shellArgs: ["-c"] });
	try {
		await waitForBackgroundResult(manager);
		await waitForBackgroundResult(manager, AbortSignal.abort());
		assert.equal(manager.runningCount(), 0);
	} finally {
		manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
