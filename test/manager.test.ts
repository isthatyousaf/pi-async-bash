import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
	cleanOutput,
	createSessionLogDir,
	type Job,
	JobManager,
	type JobManagerOptions,
	pruneSessionLogDirs,
	readLogTail,
} from "../src/manager.ts";
import { alive, sleep, tempDir, waitFor } from "./helpers.ts";

const managers: JobManager[] = [];
after(() => {
	for (const m of managers) m.dispose();
});

function make(opts: Partial<JobManagerOptions> = {}): { mgr: JobManager; completed: Job[] } {
	const completed: Job[] = [];
	const mgr = new JobManager({
		logDir: join(tempDir(), "logs"),
		shell: "/bin/bash",
		shellArgs: ["-c"],
		killGraceMs: 300,
		onBackgroundComplete: (job) => completed.push(job),
		...opts,
	});
	managers.push(mgr);
	return { mgr, completed };
}

describe("JobManager", () => {
	test("quick exit with stdout and stderr in one private log", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: "echo out; echo err >&2", cwd: process.cwd() });
		assert.equal(await job.launched, true);
		const info = await job.done;
		assert.equal(info.status, "exited");
		assert.equal(info.exitCode, 0);
		assert.equal(mgr.tail(job, 1000, 10).text, "out\nerr");
		assert.equal(fs.statSync(job.logPath).mode & 0o777, 0o600);
		assert.equal(fs.statSync(mgr.logDir).mode & 0o777, 0o700);
		assert.equal(completed.length, 0, "foreground-owned jobs are not reported as background completions");
	});

	test("nonzero and signal exits", async () => {
		const { mgr } = make();
		assert.equal((await mgr.start({ command: "exit 3", cwd: "/" }).done).exitCode, 3);
		const sig = await mgr.start({ command: "kill -TERM $$", cwd: "/" }).done;
		assert.equal(sig.status, "exited");
		assert.equal(sig.signal, "SIGTERM");
		assert.equal(sig.exitCode, 143);
	});

	test("cwd and env are passed through", async () => {
		const { mgr } = make();
		const dir = tempDir();
		const job = mgr.start({ command: 'pwd; echo "$PAB_X"', cwd: dir, env: { ...process.env, PAB_X: "hello" } });
		await job.done;
		assert.equal(mgr.tail(job, 1000, 10).text, `${fs.realpathSync(dir)}\nhello`);
	});

	test("spawn failure and missing cwd", async () => {
		const { mgr } = make({ shell: "/nonexistent/shell-binary" });
		const job = mgr.start({ command: "true", cwd: "/" });
		assert.equal(await job.launched, false);
		const info = await job.done;
		assert.equal(info.status, "spawn_error");
		assert.match(info.error ?? "", /ENOENT/);
		assert.throws(() => mgr.start({ command: "true", cwd: "/does/not/exist" }), /Working directory does not exist/);
	});

	test("invalid timeouts are rejected", () => {
		const { mgr } = make();
		for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
			assert.throws(() => mgr.start({ command: "true", cwd: "/", timeoutMs: t }), /Invalid timeout/);
		}
	});

	test("hard timeout survives handoff and reports once", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: "sleep 5", cwd: "/", timeoutMs: 300 });
		await sleep(50);
		assert.equal(mgr.handoff(job), true);
		const started = Date.now();
		const info = await job.done;
		assert.ok(Date.now() - started < 2000);
		assert.equal(info.status, "timed_out");
		assert.equal(completed.length, 1);
		assert.equal(completed[0], job);
	});

	test("explicit background job reports completion", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: "echo bg", cwd: "/", background: true });
		await job.done;
		assert.deepEqual(completed, [job]);
	});

	test("handoff after exit returns false (completion race)", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: "true", cwd: "/" });
		await job.done;
		assert.equal(mgr.handoff(job), false);
		assert.equal(job.owner, "foreground");
		assert.equal(completed.length, 0);
	});

	test("stop kills the whole process tree", async () => {
		const { mgr } = make();
		const job = mgr.start({ command: "sleep 30 & echo $!; sleep 30", cwd: "/", background: true });
		await waitFor(() => /^\d+$/m.test(mgr.tail(job, 100, 5).text), 3000, "descendant pid");
		const pid = Number(mgr.tail(job, 100, 5).text.trim());
		assert.ok(alive(pid));
		const info = await mgr.requestStop(job, "stopped");
		assert.equal(info.status, "stopped");
		await waitFor(() => !alive(pid), 3000, "descendant to die");
	});

	test("stop escalates to SIGKILL when TERM is ignored", async () => {
		const { mgr } = make({ killGraceMs: 200 });
		const job = mgr.start({ command: "trap '' TERM; sleep 30; true", cwd: "/" });
		await sleep(100);
		const info = await mgr.requestStop(job, "stopped");
		assert.equal(info.status, "stopped");
		assert.equal(info.signal, "SIGKILL");
	});

	test("per-job output limit kills a job producing enormous no-newline output", async () => {
		const { mgr } = make({ maxLogBytes: 200_000, monitorIntervalMs: 25 });
		const job = mgr.start({ command: "yes abcdefgh | tr -d '\\n'", cwd: "/", background: true });
		const info = await job.done;
		assert.equal(info.status, "output_limit");
		const tail = mgr.tail(job, 4096, 100);
		assert.ok(tail.truncated);
		assert.ok(tail.text.length <= 4096);
		assert.match(tail.text, /^[a-h]+$/);
	});

	test("total log budget evicts the oldest finished logs", async () => {
		const { mgr } = make({ maxTotalLogBytes: 150_000 });
		const a = mgr.start({ command: "head -c 100000 /dev/zero", cwd: "/" });
		await a.done;
		const b = mgr.start({ command: "head -c 100000 /dev/zero", cwd: "/" });
		await b.done;
		mgr.checkOutputLimits();
		assert.equal(a.logDeleted, true);
		assert.equal(fs.existsSync(a.logPath), false);
		assert.equal(b.logDeleted, false);
	});

	test("finished-job bookkeeping is bounded", async () => {
		const { mgr } = make({ maxCompleted: 2 });
		const jobs: Job[] = [];
		for (let i = 0; i < 3; i++) {
			const job = mgr.start({ command: `echo ${i}`, cwd: "/" });
			await job.done;
			jobs.push(job);
		}
		assert.equal(mgr.get(jobs[0]!.id), undefined);
		assert.equal(fs.existsSync(jobs[0]!.logPath), false);
		assert.ok(mgr.get(jobs[2]!.id));
	});

	test("running job limit", async () => {
		const { mgr } = make({ maxRunning: 1 });
		const job = mgr.start({ command: "sleep 5", cwd: "/" });
		assert.throws(() => mgr.start({ command: "true", cwd: "/" }), /Too many running/);
		await mgr.requestStop(job, "stopped");
		await mgr.start({ command: "true", cwd: "/" }).done;
	});

	test("dispose stops running jobs, refuses new ones, and suppresses callbacks", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: "sleep 30", cwd: "/", background: true });
		await job.launched;
		const pid = job.pid!;
		mgr.dispose();
		mgr.dispose();
		const info = await job.done;
		assert.equal(info.status, "shutdown");
		assert.equal(completed.length, 0);
		await waitFor(() => !alive(pid), 3000, "process to die");
		assert.throws(() => mgr.start({ command: "true", cwd: "/" }), /shut down/);
		assert.equal(fs.existsSync(job.logPath), true, "logs survive teardown");
	});

	test("bounded wait returns without finishing the job", async () => {
		const { mgr } = make();
		const job = mgr.start({ command: "sleep 5", cwd: "/" });
		assert.equal(await mgr.wait(job, 100), false);
		assert.equal(job.running, true);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		assert.equal(await mgr.wait(job, 10_000, ac.signal), false);
		await mgr.requestStop(job, "stopped");
		assert.equal(await mgr.wait(job, 100), true);
	});
});

describe("stop ownership and cleanup", () => {
	const TERM_EXITS_0 = "trap 'exit 0' TERM; echo READY; while :; do sleep 0.01; done";

	test("a requested stop stays authoritative when the shell exits 0 on TERM", async () => {
		const { mgr } = make();
		const job = mgr.start({ command: TERM_EXITS_0, cwd: "/" });
		await waitFor(() => mgr.tail(job, 100, 5).text.includes("READY"), 3000, "READY");
		const info = await mgr.requestStop(job, "timed_out");
		assert.equal(info.exitCode, 0);
		assert.equal(info.status, "timed_out");
	});

	test("deadline after handoff reports timed_out even with a clean exit, once", async () => {
		const { mgr, completed } = make();
		const job = mgr.start({ command: TERM_EXITS_0, cwd: "/", timeoutMs: 400 });
		mgr.handoff(job);
		const info = await job.done;
		assert.equal(info.status, "timed_out");
		assert.equal(info.exitCode, 0);
		assert.deepEqual(completed, [job]);
	});

	test("the first stop reason wins and repeated stops add no cleanup", async () => {
		const { mgr } = make({ killGraceMs: 5000 });
		const job = mgr.start({ command: TERM_EXITS_0, cwd: "/" });
		await waitFor(() => mgr.tail(job, 100, 5).text.includes("READY"), 3000, "READY");
		void mgr.requestStop(job, "stopped");
		const timer = job.cleanupTimer;
		void mgr.requestStop(job, "timed_out");
		void mgr.requestStop(job, "aborted");
		assert.equal(job.cleanupTimer, timer);
		const info = await job.done;
		assert.equal(info.status, "stopped");
		// The group was empty when the shell exited, so no delayed SIGKILL remains armed.
		assert.equal(job.cleanupPending, false);
		assert.equal(job.cleanupTimer, undefined);
	});

	test("a TERM-ignoring descendant is SIGKILLed after the shell exits", async () => {
		const { mgr } = make({ killGraceMs: 400 });
		const job = mgr.start({ command: "(trap '' TERM; exec sleep 30) & echo $!; wait", cwd: "/", background: true });
		await waitFor(() => /^\d+$/m.test(mgr.tail(job, 100, 5).text), 3000, "descendant pid");
		const pid = Number(mgr.tail(job, 100, 5).text.trim());
		try {
			const info = await mgr.requestStop(job, "stopped");
			assert.equal(info.status, "stopped");
			assert.equal(job.cleanupPending, true, "cleanup outlives the shell");
			assert.ok(alive(pid));
			await waitFor(() => !alive(pid), 3000, "descendant SIGKILL");
			await waitFor(() => !job.cleanupPending, 1000, "cleanup to finish");
		} finally {
			if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	test("process exit during the grace period still kills the group", async () => {
		const logDir = join(tempDir(), "l");
		const script = `
			import { JobManager } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).pathname)};
			const mgr = new JobManager({ logDir: ${JSON.stringify(logDir)}, shell: "/bin/bash", shellArgs: ["-c"], unref: true, killGraceMs: 30000 });
			const job = mgr.start({ command: "(trap '' TERM; exec sleep 30) & echo $!; wait", cwd: "/", background: true });
			const keepAlive = setTimeout(() => {}, 60000); // stands in for Pi's own event loop handles
			const timer = setInterval(async () => {
				const text = mgr.tail(job, 100, 5).text.trim();
				if (!/^\\d+$/.test(text)) return;
				clearInterval(timer);
				await mgr.requestStop(job, "shutdown");
				console.log(text, job.status, job.cleanupPending);
				process.exit(0);
			}, 20);
		`;
		const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
		const [pidText, status, pending] = res.stdout.trim().split(" ");
		const pid = Number(pidText);
		try {
			assert.equal(res.status, 0, res.stderr);
			assert.equal(status, "shutdown");
			assert.equal(pending, "true");
			await waitFor(() => !alive(pid), 2000, "exit hook to kill the descendant");
		} finally {
			if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
		}
	});
});

describe("cleanup independent of result retention", () => {
	for (const removal of ["release", "retention eviction"] as const) {
		test(`process exit kills pending descendants after ${removal}`, async () => {
			const logDir = join(tempDir(), "logs");
			const script = `
				import { JobManager } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).pathname)};
				const mgr = new JobManager({ logDir: ${JSON.stringify(logDir)}, shell: "/bin/bash", shellArgs: ["-c"], unref: true, killGraceMs: 30000, maxCompleted: 1 });
				const job = mgr.start({ command: "(trap '' TERM; exec sleep 30) & echo $!; wait", cwd: "/" });
				while (!/^\\d+$/.test(mgr.tail(job, 100, 5).text.trim())) await new Promise(r => setTimeout(r, 10));
				const pid = Number(mgr.tail(job, 100, 5).text.trim());
				console.log(JSON.stringify({ pid }));
				await mgr.requestStop(job, "timed_out");
				${removal === "release" ? "mgr.release(job);" : 'await mgr.start({ command: "true", cwd: "/" }).done;'}
				console.log(JSON.stringify({ removed: !mgr.get(job.id), pending: job.cleanupPending, active: mgr.activeCount() }));
				process.exit(0);
			`;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
			let pid: number | undefined;
			try {
				const lines = result.stdout.trim().split("\n");
				pid = JSON.parse(lines[0]!).pid;
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(JSON.parse(lines[1]!), { removed: true, pending: true, active: 1 });
				await waitFor(() => !alive(pid!), 2000, "exit hook to kill released job descendant");
			} finally {
				if (pid && alive(pid)) process.kill(pid, "SIGKILL");
			}
		});
	}
});

describe("output limits at completion", () => {
	test("a command that exits before any monitor tick is still limited", async () => {
		const { mgr } = make({ maxLogBytes: 1024, monitorIntervalMs: 500 });
		const job = mgr.start({ command: "yes x | head -c 16384", cwd: "/" });
		const info = await job.done;
		assert.equal(info.status, "output_limit");
		assert.equal(info.exitCode, 0);
		assert.ok(info.logBytes <= 1024, `logBytes ${info.logBytes}`);
		assert.equal(fs.statSync(job.logPath).size, info.logBytes);
		const content = fs.readFileSync(job.logPath, "utf8");
		assert.match(content, /^\[pi-async-bash: \d+ earlier bytes removed/);
		assert.match(content, /x\n$/);
	});

	test("session budget holds for finished jobs with no process left", async () => {
		const { mgr } = make({ maxLogBytes: 1000, maxTotalLogBytes: 3000 });
		for (let i = 0; i < 6; i++) await mgr.start({ command: "yes y | head -c 900", cwd: "/" }).done;
		const total = fs.readdirSync(mgr.logDir).reduce((sum, f) => sum + fs.statSync(join(mgr.logDir, f)).size, 0);
		assert.ok(total <= 3000, `total ${total}`);
		assert.equal(mgr.list().filter((j) => !j.logDeleted).length, 3);
	});
});

describe("event loop ownership", () => {
	test("with unref, a foreground job keeps Node alive but a handed-off job does not", () => {
		const script = (handoff: boolean) => `
			import { JobManager } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).pathname)};
			const mgr = new JobManager({ logDir: ${JSON.stringify(join(tempDir(), "l"))}, shell: "/bin/bash", shellArgs: ["-c"], unref: true });
			const job = mgr.start({ command: "sleep 0.4", cwd: "/" });
			${handoff ? "mgr.handoff(job);" : ""}
			job.done.then((info) => console.log("finished", info.status));
		`;
		const run = (handoff: boolean) =>
			spawnSync(process.execPath, ["--input-type=module", "-e", script(handoff)], { encoding: "utf8", timeout: 10_000 });
		const fg = run(false);
		assert.equal(fg.stdout.trim(), "finished exited", fg.stderr);
		const bg = run(true);
		assert.equal(bg.status, 0, bg.stderr);
		assert.equal(bg.stdout.trim(), "", "a background job does not hold the process open");
	});
});

describe("log helpers", () => {
	test("tail of an enormous single line is bounded", () => {
		const dir = tempDir();
		const path = join(dir, "x.log");
		fs.writeFileSync(path, "a".repeat(1_000_000));
		const tail = readLogTail(path, 1000, 10);
		assert.equal(tail.text.length, 1000);
		assert.equal(tail.truncated, true);
		assert.equal(tail.totalBytes, 1_000_000);
	});

	test("tail drops the partial first line and limits lines", () => {
		const dir = tempDir();
		const path = join(dir, "x.log");
		fs.writeFileSync(path, Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n") + "\n");
		const tail = readLogTail(path, 30, 100);
		assert.ok(!tail.text.startsWith("ine"));
		assert.ok(tail.text.endsWith("line99"));
		assert.equal(readLogTail(path, 100_000, 3).text, "line97\nline98\nline99");
	});

	test("cleanOutput strips escapes and applies carriage returns", () => {
		assert.equal(cleanOutput("\x1b[31mred\x1b[0m\n10%\r50%\r100%\nok\r\n"), "red\n100%\nok\n");
		assert.equal(cleanOutput("a\x00b\x07c"), "abc");
	});

	test("createSessionLogDir refuses a symlinked base and prune keeps the live dir", () => {
		const root = tempDir();
		const real = join(root, "real");
		fs.mkdirSync(real);
		fs.symlinkSync(real, join(root, "link"));
		assert.throws(() => createSessionLogDir(join(root, "link"), "s1"), /not a directory/);
		const base = join(root, "base");
		const live = createSessionLogDir(base, "s/../1");
		assert.equal(fs.statSync(base).mode & 0o777, 0o700);
		assert.ok(!live.includes("/../"));
		const old = createSessionLogDir(base, "old");
		const past = new Date(Date.now() - 10 * 86400_000);
		fs.utimesSync(old, past, past);
		fs.utimesSync(live, past, past);
		pruneSessionLogDirs(base, 86400_000, live);
		assert.equal(fs.existsSync(old), false);
		assert.equal(fs.existsSync(live), true);
	});
});
