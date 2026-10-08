# pi-async-bash

- Public branch: `main`. Pre-publication branches stay local; cherry-pick later changes rather than merging their old author metadata into public history.
- Setup: `bun install --omit peer && sh scripts/link-pi.sh`. Pi supplies the peer packages; skip installing separate copies. The script links the installed Pi for tests (set `PI_ROOT` if the `pi` executable is a wrapper); re-run after a Pi update or node move.
- Gates: `npx tsc --noEmit -p .` and `node --test --test-concurrency=1 test/*.test.ts` (host Node 22 strips types; relative imports need `.ts`). Use Node, not Bun: Pi runs extensions under Node.
- `test/integration.test.ts` drives a real `AgentSession` with the faux provider (no network). Use it when changing delivery or lifecycle; `test/fake-pi.ts` covers handler-level cases.
- Keep `src/manager.ts` and `src/ui/board.ts` free of Pi imports. `src/ui/` is presentation only: `board.ts` (display view of jobs, row watchers, 1 s ticker, manual-handoff triggers), `bash-row.ts` (tool renderers), `completion.ts`, `jobs-widget.ts`, `jobs-panel.ts`, `install.ts` (command, shortcuts, widget). UI must never decide ownership or delivery; manual handoff only wakes the call's own wait, which then calls `handoff()`.
- Renderer components compute lines at render time from Pi's shared row state and cache by width + input version; Pi re-runs renderers on `context.invalidate()`. History rows have a result but `executionStarted: false`.
- Every board subscription, row watcher and the ticker must end on job finish, panel close, `reset()`, or `session_shutdown`; `test/ui.test.ts` and `test/ui-extension.test.ts` cover this. The fake runtime is headless (`rpc`) unless `withUI()` is called.
- Real TUI QA: `qa/tui.sh` (isolated tmux server `-L pab-qa`, temp agent dir, `qa/faux-qa.ts` scripted model) and `qa/capture-all.sh`. Do not `pgrep -f` a command string you also typed in the same shell; it matches itself.
- Ownership invariants: `handoff()` succeeds only while the job runs; `finish()` notifies only background-owned, undelivered jobs; the first `stopReason` is the final status.
- Group cleanup lives in `pendingGroupCleanup`, independently of retained job results. Releasing or evicting a result must not remove its pending group from exit cleanup; regressions are in `test/manager.test.ts`.
- Every retained log, including truncated foreground results, stays registered in the manager so the disk limits count it.
- In `src/index.ts`, reach the manager through `managerFor(ctx)` (the session guard), never the bare variable.
- Do not deliver notices through the agent's follow-up queue (`deliverAs: "followUp"`). Pi clears it on user abort. Deliver through `turn_end`/`agent_before_settle` entries or an idle `sendMessage`.
- For installation and rollback, see `docs/reference.md`. Running sessions need `/reload` after registration changes; reload stops running jobs.
