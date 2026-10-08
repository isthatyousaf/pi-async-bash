import { type JobManager, MAX_TIMER_MS } from "./manager.ts";

/**
 * Hold a headless final turn until one background result is ready. Each manager wait owns a
 * referenced timer: an awaited Promise alone cannot keep Node alive after shell handoff unrefs
 * the child. Cancel all losing waits, not their jobs, when a result or run abort arrives.
 */
export async function waitForBackgroundResult(manager: JobManager, signal?: AbortSignal): Promise<void> {
	while (!manager.isDisposed && !signal?.aborted) {
		const jobs = manager.list().filter((job) => job.running && job.owner === "background");
		if (jobs.length === 0) return;
		const waiting = new AbortController();
		const abort = () => waiting.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const waits = jobs.map((job) => manager.wait(job, MAX_TIMER_MS, waiting.signal));
		try {
			await Promise.race(waits);
		} finally {
			waiting.abort();
			signal?.removeEventListener("abort", abort);
			await Promise.all(waits);
		}
		if (jobs.some((job) => !job.running)) return;
		// A Node timer cannot exceed MAX_TIMER_MS. Re-arm if a deadline-free job outlives it.
	}
}
