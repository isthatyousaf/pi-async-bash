#!/bin/sh
# Reproduce the UI captures in qa/captures/ from the real Pi TUI (tmux PTY, faux model, no network).
# Each capture is the tmux screen with ANSI colors (.ans), plain text (.txt), and, when
# agent-browser is available, a PNG rendering of the .ans file (qa/ans2html.py).
set -eu
WT="$(cd "$(dirname "$0")/.." && pwd)"
Q="$WT/qa/tui.sh"
OUT="$WT/qa/captures"
export QA_DIR="${QA_DIR:-/tmp/pab-qa}"
mkdir -p "$OUT"
snap() { # name [dark|light]
	"$Q" cap "$1" >/dev/null
	cp "$QA_DIR/cap/$1.ans" "$QA_DIR/cap/$1.txt" "$OUT/"
	python3 "$WT/qa/ans2html.py" "$OUT/$1.ans" "$QA_DIR/cap/$1.html" "${2:-dark}" "$1"
	if command -v agent-browser >/dev/null 2>&1; then
		agent-browser open "file://$QA_DIR/cap/$1.html" >/dev/null 2>&1 && agent-browser screenshot "$OUT/$1.png" >/dev/null 2>&1 || true
	fi
}

# 1. Live foreground output, then a manual handoff (foreground budget off).
"$Q" start 100 30 --bash-foreground-ms off; sleep 3
"$Q" send 'run for i in $(seq 1 40); do echo "compiling module $i"; sleep 0.25; done'; sleep 2.6
snap 01-live-foreground
"$Q" keys C-M-b; sleep 1.2
snap 02-manual-background-widget
sleep 9; snap 03-background-completion

# 2. Outcomes: success with long output, empty, failure, timeout, guard-free interrupt.
"$Q" start 100 46; sleep 3
"$Q" send 'run seq 1 40'; sleep 1.2
"$Q" send 'run true'; sleep 1.2
"$Q" send 'run echo "warning: unused import" >&2; echo "error: build failed"; exit 2'; sleep 1.2
"$Q" send 'to 1 echo starting; sleep 5'; sleep 2.5
"$Q" send 'run printf "no trailing newline"'; sleep 1.2
snap 04-outcomes

# 3. Several background commands, widget, coalesced notice, jobs panel with a scrolled log.
"$Q" start 110 34; sleep 3
"$Q" send 'desc Start the dev server :: for i in $(seq 1 500); do echo "GET /api/items 200 ${i}ms"; sleep 0.2; done'; sleep 1.5
"$Q" send 'two sleep 3; echo "数据 ✓ wide glyphs 🚀" || sleep 3; echo "tests failed"; exit 1'; sleep 5
snap 05-multi-background-notice
"$Q" keys M-j; sleep 1.2
snap 06-jobs-panel
"$Q" keys PageUp; sleep 0.5
snap 07-jobs-panel-scrolled
"$Q" keys x; sleep 0.4
snap 08-jobs-panel-confirm-stop
"$Q" keys Escape; sleep 0.3

# 4. Narrow terminal (resize while a job runs) and the panel at that width.
"$Q" resize 50 30; sleep 1
snap 09-narrow
"$Q" keys M-j; sleep 1
snap 10-narrow-panel
"$Q" keys Escape

# 5. Light theme and regular (non-fullscreen) mode.
QA_THEME=light "$Q" start 100 22; sleep 3
"$Q" send 'run echo light; exit 2'; sleep 1.2
"$Q" send 'bg sleep 30'; sleep 1.5
snap 11-light light
"$Q" start 100 22 --tui-mode regular --bash-foreground-ms off; sleep 3
"$Q" send 'run for i in 1 2 3 4 5 6 7 8; do echo "line $i"; sleep 0.4; done'; sleep 1.8
snap 12-regular-live
"$Q" keys Escape; sleep 1.2
snap 13-regular-interrupted
"$Q" stop
echo "captures in $OUT"
