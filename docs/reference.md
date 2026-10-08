# Behavior reference

Back to the [README](../README.md).

A Pi extension that replaces the `bash` tool with one whose processes belong to a session job manager, and adds a `bash_job` tool.

- A command that finishes within the foreground budget (default 2 s) returns like Pi's builtin `bash`: bounded output and exit status; a nonzero exit is a tool error.
- A command still running at the budget keeps running as a background job. The tool returns a job ID, `running` status, and the full log path. The result says the command has **not** completed.
- `run_in_background: true` returns as soon as the process has launched.
- When a background job finishes, the model is told once: job ID, exit status or kill reason, the last 20 lines (2 KB), and the log path.
- `bash_job` with `action` `list`, `status`, `wait` (bounded, default 30 s, max 600 s) or `stop` (process tree). It cannot start processes.

## Behavior

**Arguments.** `command`, optional `timeout` (seconds), optional `run_in_background`, optional `description` (display label only). The timeout is a hard deadline counted from launch. It still applies after the job moves to the background, and the process tree is killed when it expires. Values must be finite, positive, and at most 2147483.647 s. Omitted means no deadline, as in the builtin. Without a deadline, a background job runs until it exits or is stopped, or the session ends.

**Foreground budget.** The budget is wall-clock time from launch; output does not extend it. Only the user sets it, with `--bash-foreground-ms <ms|off>` or `PI_ASYNC_BASH_FOREGROUND_MS`; the flag wins. `off` (or `0`) waits for completion, as the builtin does; `run_in_background` still works. In one-shot `print`/`json` modes the default is `off`, because Pi exits after the run and would kill handed-off jobs.

**Abort.** Aborting a call that is still in the foreground kills its process tree. After handoff the call's abort signal no longer owns the process. Ending the turn or the run does not stop jobs.

**Notification delivery.** Completions are delivered once, in this order of preference:
1. While the agent is running, a `custom_message` entry at the next `turn_end`, after that turn's tool results (or at `agent_before_settle`), with `continue: true` so the model sees it.
2. While idle, `pi.sendMessage(..., { triggerTurn: true })` after a 200 ms coalescing delay.
3. After the user aborts a run, notices are recorded without starting a turn, both at `agent_settled` and for jobs that finish later. This lasts until the next run starts (`agent_start`). After a run that ends with a provider error (not an abort), an idle completion still starts a turn.

Completions that arrive close together are merged into one message: 8 jobs in detail, the rest by ID. If the model already saw the result (foreground completion, `bash_job wait`/`status` after exit, or `stop`), no notice is sent. Exactly one owner reports each job: the foreground caller if the job exits before handoff, otherwise the background notifier. Handoff is a synchronous ownership transition that fails once the job has exited. The extension does not use the agent's follow-up queue, which Pi clears when the user aborts.

**Session lifecycle.** Jobs belong to one extension runtime and one session ID. `session_shutdown`, whatever the reason (quit, reload, new, resume, fork), stops all running jobs: SIGTERM to the process group, then SIGKILL after 2 s to whatever is still in it. "Process tree" here means the process group: descendants that start their own session or group (`setsid`, daemons) escape it. Shutdown does not touch processes left behind by jobs that had already exited normally. Shutdown also drops pending notices and blocks late callbacks. Every use of the manager is checked against the calling context's session ID: launch, `bash_job` list/status/wait/stop, and notice delivery. If a different session ID ever reaches the same runtime, the old jobs are retired the same way, even when the first call is `bash_job`. Model and thinking-level changes, `/tree` navigation and compaction keep the same session, so jobs and `bash_job` keep working. Jobs do not survive a Pi restart or `/reload`. A process `exit` hook SIGKILLs every group that is still running or still being cleaned up. That includes a group whose shell died from SIGTERM while a descendant that ignores SIGTERM is still inside the grace period. A sudden SIGKILL of Pi itself runs no hook, so its jobs are left running.

**Processes.** Each command runs in a fresh detached shell, in its own process group. The shell comes from Pi's `getShellConfig(settings.shellPath)`, and `shellCommandPrefix` is prepended. The environment matches the builtin's: Pi's `bin` dir on `PATH`, plus `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`, re-read on every call. stdout and stderr share one log file descriptor, in the order they were written. Stop, timeout, abort, and shutdown signal the whole group. The first stop reason is final: a command that traps SIGTERM and exits 0 is still reported as `timed_out`, `stopped` or `aborted`. The manager tracks group cleanup separately from the shell. After SIGTERM it checks the group when the shell exits; if members remain, it SIGKILLs the group when the 2 s grace ends. A PGID cannot be reused while any member is alive, and cleanup stops as soon as the group is seen empty, so delayed signals do not reach recycled IDs. Repeated stop requests send no extra signals. After a normal exit, descendants the command left running (`cmd &`) are not killed, as with the builtin. Signal exits report `128 + n`.

**Output, disk, and retention.**
- Logs: `$PI_ASYNC_BASH_LOG_DIR` or `$TMPDIR/pi-async-bash-<uid>/` (mode 0700, must be a real directory you own), one `mkdtemp` directory per session, and files created `O_EXCL|O_NOFOLLOW` with mode 0600.
- Model-facing output is the last 2000 lines / 50 KB, with ANSI escapes stripped and carriage-return overwrites applied. Memory use is bounded because tails are read from the end of the file.
- Per-job log limit: 64 MiB (`PI_ASYNC_BASH_MAX_LOG_MB`). Session total: 256 MiB (`PI_ASYNC_BASH_SESSION_LOG_MB`).
- Running jobs write straight to an inherited file descriptor, so the limits are not a strict ceiling while a writer runs. The log size is checked every 500 ms; a job over the limit has its group SIGKILLed at once (status `output_limit`). Overshoot is roughly the write rate times 500 ms, plus anything written by descendants that escaped the group.
- At completion the limit is always checked, including for commands that exit before the first check. An oversized log gives status `output_limit`, even after exit 0, and is trimmed to its last 64 MiB behind a marker line. So retained logs are strictly bounded. (A descendant still holding the old file after a normal exit can keep its space allocated until it closes.)
- The session total counts every retained log, including truncated foreground results. It is enforced on every check and every completion, also when no process is running: delivered logs go first, oldest first, then undelivered ones, then the largest running job is killed.
- At most 8 jobs run at once (`PI_ASYNC_BASH_MAX_JOBS`); launching another fails. The 50 most recent finished jobs are kept, and older records and their logs are deleted.
- A foreground completion whose output fit is forgotten and its log deleted. A truncated one stays registered (hidden from `bash_job`) so its log stays under the limits above.
- Logs outlive the session. Session directories untouched for 7 days are pruned when a later session creates its log directory.

## Interactive UI

The `bash` row is drawn Claude Code style (Pi `renderShell: "self"`, no tool box):

```
 ● Bash(npm test)
   ⎿  … +40 lines (ctrl+o to expand)
      last output lines
      Running… (12s · timeout 1m) · ctrl+alt+b to run in background
```

- **Header:** state dot (blinking while a foreground command runs; accent while in the background; success/error/warning when finished), `Bash(command)` limited to two lines / 160 characters (full command when expanded), duration when it took 1 s or more.
- **Body:** the last 5 output lines with a `… +N lines` count; the same tail while running and when finished, so the row does not jump. Empty success shows `(No output)`; failures show `Exit code N`, `Timed out after …`, `Interrupted`, `Stopped`, or the error text. Background rows show `Running in the background (12s) · alt+j to manage` and change in place to `Done · ran in the background · 34s` (or the failure) when the job ends. Rows from a resumed session whose job no longer exists say `status not available in this session`.
- **Expanded (`app.tools.expand`, ctrl+o):** full command, all returned output, job ID, PID, how it reached the background, deadline, log path, live log tail.
- **Completion notice:** the `bash-job-complete` message renders as `● Background command completed · 1m 12s` with the description or command and the last 3 output lines; several jobs render one line each (8 max). The model-facing content is unchanged; `details.jobs[].outputTail` holds the display tail.
- **Jobs widget:** one line below the editor while background commands run (`● npm run dev · 3m 12s · alt+j to manage`); nothing otherwise.
- **Jobs panel** (`alt+j` or `/bash-jobs`): overlay listing running jobs (both owners) and retained background jobs, with the selected job's full command, description, status/timing/deadline, PID, log path, and a scrollable live log tail. Keys: `↑/↓` or `k/j` select, `PgUp/PgDn` (or `shift+↑/↓`) scroll, `Home/g` top, `End/G` follow, `x` twice to stop (the model is told the user stopped it), `b` to move a foreground command to the background, `Esc`/`q`/`ctrl+c` close. In fullscreen mode the wheel scrolls the log and a click selects a job. It never opens by itself.
- **Manual background (`ctrl+alt+b`):** wakes every waiting foreground `bash` call of this session, which then performs the normal `handoff()`. Control returns to the agent even with `--bash-foreground-ms off`. If the command exits first, the call reports it in the foreground; it is never reported twice.
- `description` (optional `bash` argument): a short label shown in the widget, panel and notice. The command stays visible.

Shortcuts: Claude uses Ctrl+B and Down. In Pi, Ctrl+B moves the editor cursor left and Down navigates history, so this extension uses `ctrl+alt+b` and `alt+j`. These have no Pi default; other extensions may bind them. Nothing is intercepted through raw terminal input.

The UI exists only in `tui` mode (widget, panel); renderers are passive. RPC, JSON and print modes run the same execution and delivery code. Live rows refresh from a 1 s ticker that runs only while a watched job runs; partial updates are sent only when the log grows. All subscriptions end when a job finishes, the panel closes, or the session shuts down.

Reproduce the captures in `qa/captures/` (real Pi TUI in an isolated tmux server, scripted faux model, no network): `sh qa/capture-all.sh`. Drive it by hand with `qa/tui.sh start|send|keys|cap|resize|stop`. PNGs are renderings of the tmux ANSI captures (`qa/ans2html.py`), not terminal screenshots.

## Differences

From Claude Code's Bash:
- Pi hands off automatically after 2 s. In Claude, 2 s only starts progress display; automatic backgrounding happens at the timeout.
- `timeout` is in seconds, as in Pi, not milliseconds.
- Shortcuts are `ctrl+alt+b` (background) and `alt+j` (jobs), not Ctrl+B and Down.
- Collapsed output shows the tail, not the head, in both live and final rows.
- The jobs view is an overlay panel, not an inline task list.
- The deadline survives backgrounding. Claude clears its timer at handoff.

From Pi's builtin `bash`:
- No `spawnHook` or custom `BashOperations` (remote execution).
- Output goes to a file, not pipes, so a descendant holding stdout does not delay completion.
- A huge output is killed at the log limit rather than streamed into an unbounded temp file.
- `!`/`!!` user shell commands are unchanged; they still use Pi's executor.

## Compatibility

- Replaces `bash` and adds `bash_job`. No other tools are replaced, and the extension does not change the active tool set.
- Existing `tool_call` guards still see `toolName: "bash"` and `input.command` before execution, and can block it. `bash_job` cannot launch processes.
- Jobs remain attached to the same session when you switch models.

## Activation and rollback

Install: `pi install git:github.com/isthatyousaf/pi-async-bash`, then restart Pi or run `/reload`.

Try a local checkout for one run: `pi -e ./src/index.ts` (add `--bash-foreground-ms 5000` to change the budget).

Uninstall: `pi remove git:github.com/isthatyousaf/pi-async-bash`, then restart or `/reload`. If installed through an explicit `extensions` path instead, remove that path. Pi's builtin `bash` returns automatically. Reload stops running jobs.

## Development

```sh
bun install --omit peer # typescript, @types/node; Pi supplies peers
sh scripts/link-pi.sh  # symlink the installed Pi packages into node_modules
npx tsc --noEmit -p .
node --test --test-concurrency=1 test/*.test.ts
```

Tests use real short subprocesses and Pi's faux provider; they make no network or model calls.
