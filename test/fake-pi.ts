/** Minimal stand-in for Pi's ExtensionAPI and contexts, enough to drive the extension's handlers. */
import asyncBash from "../src/index.ts";

export interface Sent {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

export interface FakeTool {
	name: string;
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
	[key: string]: unknown;
}

/** Minimal interactive UI: records widgets, notifications and custom components. */
export class FakeUI {
	widgets = new Map<string, any>();
	notifications: { message: string; type?: string }[] = [];
	customs: { component: any; done: (v: unknown) => void; closed: boolean; options: any }[] = [];
	renders = 0;
	rows = 30;
	columns = 100;
	theme: any;
	tui = {
		requestRender: () => {
			this.renders++;
		},
		terminal: {
			get rows() {
				return 30;
			},
			get columns() {
				return 100;
			},
		},
	};

	constructor(theme: any) {
		this.theme = theme;
	}

	api(): any {
		const self = this;
		return {
			setWidget(key: string, factory: any) {
				self.widgets.get(key)?.dispose?.();
				if (factory === undefined) self.widgets.delete(key);
				else self.widgets.set(key, typeof factory === "function" ? factory(self.tui, self.theme) : factory);
			},
			notify(message: string, type?: string) {
				self.notifications.push({ message, type });
			},
			custom(factory: any, options: any) {
				return new Promise((resolve) => {
					const entry: any = { closed: false, options };
					entry.done = (value: unknown) => {
						if (entry.closed) return;
						entry.closed = true;
						entry.component?.dispose?.();
						resolve(value);
					};
					entry.component = factory(self.tui, self.theme, undefined, entry.done);
					self.customs.push(entry);
				});
			},
		};
	}
}

export class FakeRuntime {
	tools = new Map<string, FakeTool>();
	commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	shortcuts = new Map<string, { handler: (ctx: any) => unknown }>();
	messageRenderers = new Map<string, any>();
	ui: FakeUI | undefined;
	handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
	flags = new Map<string, string | undefined>();
	sent: Sent[] = [];
	stale = false;
	settings: Record<string, unknown> = {};
	idle = true;
	sessionId: string;
	model: { provider: string; id: string } | undefined = { provider: "p1", id: "m1" };
	/** Headless by default; `withUI()` switches to an interactive ("tui") context. */
	mode = "rpc";
	cwd = process.cwd();

	constructor(sessionId = "session-a", flags: Record<string, string> = {}) {
		this.sessionId = sessionId;
		for (const [k, v] of Object.entries(flags)) this.flags.set(k, v);
		const self = this;
		const pi = {
			registerTool(tool: FakeTool) {
				self.tools.set(tool.name, tool);
			},
			registerFlag() {},
			registerCommand(name: string, options: any) {
				self.commands.set(name, options);
			},
			registerShortcut(key: string, options: any) {
				self.shortcuts.set(key, options);
			},
			registerMessageRenderer(type: string, renderer: any) {
				self.messageRenderers.set(type, renderer);
			},
			getFlag(name: string) {
				return self.flags.get(name);
			},
			getSettings() {
				return self.settings;
			},
			on(event: string, handler: (event: any, ctx: any) => any) {
				const list = self.handlers.get(event) ?? [];
				list.push(handler);
				self.handlers.set(event, list);
				return () => {};
			},
			sendMessage(message: Sent["message"], options?: Sent["options"]) {
				if (self.stale) throw new Error("stale extension ctx");
				self.sent.push({ message, options });
			},
		};
		asyncBash(pi as never);
	}

	withUI(theme: any): FakeUI {
		this.mode = "tui";
		this.ui = new FakeUI(theme);
		return this.ui;
	}

	ctx(): any {
		const self = this;
		return {
			get cwd() {
				return self.cwd;
			},
			get mode() {
				return self.mode;
			},
			get hasUI() {
				return self.ui !== undefined;
			},
			get ui() {
				return self.ui?.api();
			},
			get model() {
				return self.model;
			},
			sessionManager: {
				getSessionId: () => self.sessionId,
				getSessionFile: () => undefined,
			},
			isIdle: () => self.idle,
		};
	}

	async emit(event: string, payload: Record<string, unknown> = {}): Promise<any[]> {
		const results = [];
		for (const handler of this.handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, this.ctx()));
		return results;
	}

	bash(params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (u: any) => void): Promise<any> {
		return this.tools.get("bash")!.execute("call-1", params, signal, onUpdate, this.ctx());
	}

	job(params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		return this.tools.get("bash_job")!.execute("call-2", params, signal, undefined, this.ctx());
	}
}

export function text(result: any): string {
	return result.content.map((c: any) => c.text ?? "").join("");
}
