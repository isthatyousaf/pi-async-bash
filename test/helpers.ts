import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "pab-test-"): string {
	return fs.mkdtempSync(join(tmpdir(), prefix));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a condition; fail after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
