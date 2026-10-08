/**
 * Wires the presentation layer into Pi: completion message renderer, `/bash-jobs`, the two
 * shortcuts, the jobs widget, and the jobs panel overlay. Interactive pieces are created only in
 * `tui` mode; nothing here affects process ownership or delivery.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import type { JobBoard } from "./board.ts";
import { createCompletionRenderer } from "./completion.ts";
import { formatDuration, formatElapsed, jobLabel, outcomeOf } from "./format.ts";
import { JobsPanel, type PanelActions, sortJobs } from "./jobs-panel.ts";
import { JobsWidget } from "./jobs-widget.ts";

/**
 * Shortcuts. Claude Code uses Ctrl+B (background) and Down (task list); in Pi Ctrl+B is the editor's
 * cursor-left (and here also the herdr prefix) and Down is editor history, so neither is taken.
 * These keys have no Pi default and no binding in the installed extensions.
 */
export const JOBS_KEY = "alt+j";
export const BACKGROUND_KEY = "ctrl+alt+b";
export const WIDGET_KEY = "pi-async-bash-jobs";

export interface UiDeps {
	board: JobBoard;
	notifyType: string;
	/** Session-guarded user actions implemented by the extension. */
	actions: PanelActions & {
		/** Whether `ctx` belongs to the live session's job manager. */
		owns(ctx: ExtensionContext): boolean;
	};
}

export function expandKeyText(): string {
	try {
		return keyText("app.tools.expand") || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}

export function installUi(pi: ExtensionAPI, deps: UiDeps): { shutdown(): void } {
	const { board } = deps;
	let panel: JobsPanel | undefined;

	pi.registerMessageRenderer(deps.notifyType, createCompletionRenderer(expandKeyText) as never);

	const textSummary = (): string => {
		const jobs = sortJobs(board.list());
		if (jobs.length === 0) return "No shell jobs in this session.";
		const now = Date.now();
		return jobs
			.map((job) => {
				const state =
					job.status === "running"
						? `running ${formatElapsed(now - job.startedAt)}`
						: `${outcomeOf(job).label}${job.endedAt ? ` · ${formatDuration(job.endedAt - job.startedAt)}` : ""}`;
				return `${job.id}  ${state}  ${jobLabel(job, 60)}`;
			})
			.join("\n");
	};

	const openPanel = async (ctx: ExtensionContext, initialJobId?: string) => {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify(textSummary(), "info");
			return;
		}
		if (panel && !panel.isClosed) return;
		let columns = () => process.stdout.columns ?? 100;
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				columns = () => tui.terminal.columns;
				panel = new JobsPanel({
					board,
					theme,
					keybindings,
					actions: deps.actions,
					rows: () => tui.terminal.rows,
					requestRender: () => tui.requestRender(),
					close: () => done(undefined),
					initialJobId,
				});
				return panel;
			},
			{
				overlay: true,
				overlayOptions: () => {
					const narrow = columns() < 72;
					return narrow
						? { anchor: "center" as const, width: "100%" as const, maxHeight: "100%" as const, margin: 0 }
						: { anchor: "center" as const, width: "86%" as const, minWidth: 60, maxHeight: "92%" as const };
				},
			},
		);
		panel?.dispose();
		panel = undefined;
	};

	pi.registerCommand("bash-jobs", {
		description: "Show shell jobs started by bash: live log, status, stop",
		handler: async (_args, ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerShortcut(JOBS_KEY, {
		description: "Show shell jobs (pi-async-bash)",
		handler: (ctx) => {
			void openPanel(ctx);
		},
	});

	pi.registerShortcut(BACKGROUND_KEY, {
		description: "Move the running foreground bash command to the background (pi-async-bash)",
		handler: (ctx) => {
			const moved = deps.actions.owns(ctx) ? board.requestBackground() : 0;
			if (moved === 0 && ctx.hasUI) ctx.ui.notify("No foreground bash command is running.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new JobsWidget(board, theme, JOBS_KEY, () => tui.requestRender()), {
			placement: "belowEditor",
		});
	});

	return {
		shutdown() {
			panel?.close();
			panel = undefined;
		},
	};
}
