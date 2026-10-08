/** Real Pi themes and line checks for renderer tests. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export const piRoot = join(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent");

/** Pi's internal theme module (same instance the package index re-exports). */
const themeModule = (await import(join(piRoot, "dist/modes/interactive/theme/theme.js"))) as {
	getThemeByName(name: string): Theme | undefined;
};

export function piTheme(name: "dark" | "light"): Theme {
	const theme = themeModule.getThemeByName(name);
	assert.ok(theme, `theme ${name}`);
	return theme;
}

export function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

/** Every rendered line must fit the width it was rendered for. */
export function assertFits(lines: string[], width: number, what = "lines"): void {
	for (const [i, line] of lines.entries()) {
		const w = visibleWidth(line);
		assert.ok(w <= width, `${what}[${i}] is ${w} columns wide, more than ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
	}
}

export const WIDTHS = [20, 32, 60, 100, 180];
