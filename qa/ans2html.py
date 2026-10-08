#!/usr/bin/env python3
"""Render a tmux `capture-pane -e` ANSI capture to a standalone HTML page (truecolor SGR subset).

Usage: qa/ans2html.py capture.ans out.html [dark|light] [title]
The page uses a monospace grid; screenshots of it are a rendering of the real terminal capture,
not a mock.
"""
import html
import re
import sys
import unicodedata

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]")
BASIC = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
         "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]


def color256(n):
    if n < 16:
        return BASIC[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        f = lambda v: 0 if v == 0 else 55 + v * 40
        return "#%02x%02x%02x" % (f(r), f(g), f(b))
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


def cells(chunk):
    """Escape text and pin every non-ASCII character to its terminal cell width (1 or 2 columns),
    so fallback fonts cannot shift the grid."""
    out = []
    for ch in chunk:
        if ord(ch) < 128:
            out.append(html.escape(ch))
            continue
        if unicodedata.combining(ch):
            out.append(ch)
            continue
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        out.append('<span style="display:inline-block;width:%dch;text-align:center;overflow:hidden;vertical-align:bottom">%s</span>' % (w, html.escape(ch)))
    return "".join(out)


def convert(text, bg, fg):
    out = []
    state = {"fg": None, "bg": None, "bold": False, "dim": False, "italic": False, "ul": False}

    def span(chunk):
        if not chunk:
            return
        style = []
        if state["fg"]:
            style.append("color:%s" % state["fg"])
        if state["bg"]:
            style.append("background:%s" % state["bg"])
        if state["bold"]:
            style.append("font-weight:700")
        if state["dim"]:
            style.append("opacity:.6")
        if state["italic"]:
            style.append("font-style:italic")
        if state["ul"]:
            style.append("text-decoration:underline")
        esc = cells(chunk)
        out.append('<span style="%s">%s</span>' % (";".join(style), esc) if style else esc)

    for line in text.split("\n"):
        pos = 0
        line = OTHER.sub(lambda m: m.group(0) if m.group(0).endswith("m") and m.group(0).startswith("\x1b[") else "", line)
        for m in SGR.finditer(line):
            span(line[pos:m.start()])
            pos = m.end()
            params = [p for p in re.split(r"[;:]", m.group(1))] or ["0"]
            i = 0
            while i < len(params):
                p = int(params[i] or 0)
                if p == 0:
                    state.update(fg=None, bg=None, bold=False, dim=False, italic=False, ul=False)
                elif p == 1:
                    state["bold"] = True
                elif p == 2:
                    state["dim"] = True
                elif p == 3:
                    state["italic"] = True
                elif p == 4:
                    state["ul"] = True
                elif p == 22:
                    state["bold"] = state["dim"] = False
                elif p == 23:
                    state["italic"] = False
                elif p == 24:
                    state["ul"] = False
                elif p == 39:
                    state["fg"] = None
                elif p == 49:
                    state["bg"] = None
                elif 30 <= p <= 37:
                    state["fg"] = BASIC[p - 30]
                elif 90 <= p <= 97:
                    state["fg"] = BASIC[p - 90 + 8]
                elif 40 <= p <= 47:
                    state["bg"] = BASIC[p - 40]
                elif p in (38, 48):
                    key = "fg" if p == 38 else "bg"
                    if i + 1 < len(params) and params[i + 1] == "2" and i + 4 < len(params):
                        state[key] = "#%02x%02x%02x" % tuple(int(x or 0) for x in params[i + 2:i + 5])
                        i += 4
                    elif i + 1 < len(params) and params[i + 1] == "5" and i + 2 < len(params):
                        state[key] = color256(int(params[i + 2] or 0))
                        i += 2
                i += 1
        span(line[pos:])
        out.append("\n")
    return "".join(out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "dark"
    title = sys.argv[4] if len(sys.argv) > 4 else src
    bg, fg = ("#1e1e1e", "#d4d4d4") if mode == "dark" else ("#fafafa", "#222222")
    with open(src, encoding="utf-8", errors="replace") as f:
        body = convert(f.read(), bg, fg)
    page = f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>body{{margin:0;background:{bg};}}pre{{margin:0;padding:12px 14px;color:{fg};background:{bg};
font:14px/1.3 'JetBrainsMono Nerd Font Mono','JetBrains Mono','SF Mono','Noto Sans Mono',monospace;
white-space:pre;display:inline-block;}}</style><pre>{body}</pre>"""
    with open(dst, "w", encoding="utf-8") as f:
        f.write(page)


if __name__ == "__main__":
    main()
