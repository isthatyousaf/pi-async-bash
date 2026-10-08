#!/bin/sh
# Drive the real Pi TUI in an isolated tmux server with the QA faux model (no network, no model spend).
#   qa/tui.sh start [cols] [rows] [extra pi args...]   start Pi (fresh agent dir under $QA_DIR)
#   qa/tui.sh send <text>                              type text and press Enter
#   qa/tui.sh keys <tmux key>...                       send raw keys (e.g. M-j, Escape, C-M-b, PageUp)
#   qa/tui.sh cap <name>                               save $QA_DIR/cap/<name>.ans (ANSI) and .txt
#   qa/tui.sh resize <cols> <rows>
#   qa/tui.sh stop
# Env: QA_THEME=light, QA_SESSION=1 (persist sessions; then QA_KEEP=1 ... start ... -c to resume)
set -eu
WT="$(cd "$(dirname "$0")/.." && pwd)"
QA_DIR="${QA_DIR:-/tmp/pab-qa}"
SOCK="pab-qa"
T="tmux -L $SOCK"
cmd="$1"; shift
case "$cmd" in
start)
	cols="${1:-100}"; rows="${2:-32}"; shift 2 || true
	if [ -n "${QA_SESSION:-}" ]; then sess="--session-dir $QA_DIR/sessions"; else sess="--no-session"; fi
	[ -n "${QA_KEEP:-}" ] || rm -rf "$QA_DIR/agent" "$QA_DIR/cwd"
	mkdir -p "$QA_DIR/agent" "$QA_DIR/cwd" "$QA_DIR/cap" "$QA_DIR/logs"
	cat > "$QA_DIR/agent/settings.json" <<JSON
{ "tuiMode": "fullscreen", "theme": "${QA_THEME:-dark}", "outputPad": 1, "quietStartup": true,
  "defaultProjectTrust": "always", "enableInstallTelemetry": false, "collapseChangelog": true,
  "lastChangelogVersion": "99.0.0", "compaction": { "enabled": false } }
JSON
	$T kill-server 2>/dev/null || true
	sleep 0.3
	$T -f "$WT/qa/tmux.conf" new-session -d -s qa -x "$cols" -y "$rows" \
		"cd '$QA_DIR/cwd' && env -u PI_DENY_TOOLS PI_CODING_AGENT_DIR='$QA_DIR/agent' PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
		 PI_ASYNC_BASH_LOG_DIR='$QA_DIR/logs' PI_TUI_WRITE_LOG='$QA_DIR/tui-write.log' TERM=xterm-256color COLORTERM=truecolor \
		 pi --no-extensions --no-skills --no-prompt-templates --no-context-files $sess \
		 -e '$WT/src/index.ts' -e '$WT/qa/faux-qa.ts' --model faux/faux-1 $* ; sleep 30"
	$T set-option -t qa status off >/dev/null
	;;
send) $T send-keys -t qa -l "$*"; $T send-keys -t qa Enter ;;
type) $T send-keys -t qa -l "$*" ;;
keys) $T send-keys -t qa "$@" ;;
cap)
	$T capture-pane -t qa -p -e > "$QA_DIR/cap/$1.ans"
	$T capture-pane -t qa -p > "$QA_DIR/cap/$1.txt"
	cat "$QA_DIR/cap/$1.txt" ;;
resize) $T resize-window -t qa -x "$1" -y "$2" ;;
stop) $T kill-server 2>/dev/null || true ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
