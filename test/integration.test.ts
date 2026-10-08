/**
 * End-to-end with Pi's real AgentSession, the faux model provider (no network), and the extension
 * loaded from its file path by DefaultResourceLoader (through jiti, like `pi -e`).
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tempDir, waitFor } from "./helpers.ts";
import { piRoot } from "./ui-helpers.ts";

const EXTENSION = resolve(import.meta.dirname, "../src/index.ts");

describe("Pi integration (faux provider)", () => {
	let session: AgentSession;
	let faux: ReturnType<typeof fauxProvider>;
	let toolInfo: { name: string; path?: string }[] = [];
	let guardPi: ExtensionAPI;

	before(async () => {
		process.env.PI_ASYNC_BASH_FOREGROUND_MS = "300";
		process.env.PI_ASYNC_BASH_LOG_DIR = tempDir("pab-int-logs-");
		const agentDir = tempDir("pab-agent-");
		const cwd = tempDir("pab-cwd-");
		faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		// A guard like ~/.pi/agent/extensions/long-sleep-guard.ts, loaded before the replacement tool.
		const guard = (pi: ExtensionAPI) => {
			guardPi = pi;
			// Stub of a Codex-style adapter tool; the real adapter suppresses builtin bash by active-tool projection.
			pi.registerTool({
				name: "exec_command",
				label: "exec_command (stub)",
				description: "stub",
				parameters: Type.Object({ cmd: Type.String() }),
				defaultActive: false,
				async execute() {
					return { content: [{ type: "text", text: "stub" }], details: undefined };
				},
			});
			pi.on("tool_call", (event) => {
				const command = (event.input as { command?: unknown }).command;
				if (event.toolName === "bash" && typeof command === "string" && /sleep 999/.test(command)) {
					return { block: true, reason: "Blocked by test guard" };
				}
				return undefined;
			});
			pi.on("session_start", () => {
				toolInfo = pi.getAllTools().map((t) => ({ name: t.name, path: t.sourceInfo?.path }));
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [EXTENSION],
			extensionFactories: [guard],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const errors = resourceLoader.getExtensions().errors;
		assert.deepEqual(errors, []);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		}));
		await session.bindExtensions({});
	});

	after(() => {
		session?.dispose();
		delete process.env.PI_ASYNC_BASH_FOREGROUND_MS;
	});

	test("extension bash replaces the builtin and adds bash_job only", () => {
		const bash = toolInfo.find((t) => t.name === "bash");
		assert.equal(bash?.path, EXTENSION);
		assert.ok(toolInfo.some((t) => t.name === "bash_job"));
		for (const name of ["exec", "wait", "write_stdin"]) assert.equal(toolInfo.some((t) => t.name === name), false);
		assert.equal(toolInfo.find((t) => t.name === "exec_command")?.path?.endsWith(EXTENSION), false, "exec_command is only the test stub");
		const active = session.getActiveToolNames();
		assert.ok(active.includes("bash") && active.includes("bash_job"));
	});

	test("existing tool_call guards still block bash", async () => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 999" })), fauxAssistantMessage("blocked ok")]);
		await session.prompt("try the long sleep");
		const result = session.messages.findLast((m) => m.role === "toolResult") as any;
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /Blocked by test guard/);
	});

	test("handoff returns running, then completion triggers a follow-up turn", async () => {
		const callsBefore = faux.state.callCount;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo start; sleep 0.8; echo integration-done" })),
			fauxAssistantMessage(fauxText("waiting for the job")),
			fauxAssistantMessage(fauxText("job noticed")),
		]);
		await session.prompt("run the slow command");
		const toolResult = session.messages.findLast((m) => m.role === "toolResult") as any;
		assert.equal(toolResult.isError, false);
		assert.match(JSON.stringify(toolResult.content), /NOT completed/);
		await waitFor(() => faux.state.callCount === callsBefore + 3 && session.isIdle, 5000, "follow-up turn");
		const notices = session.messages.filter((m: any) => m.role === "custom" && m.customType === "bash-job-complete") as any[];
		assert.equal(notices.length, 1);
		assert.match(JSON.stringify(notices[0].content), /integration-done/);
		const last = session.messages.at(-1) as any;
		assert.equal(last.role, "assistant");
		assert.match(JSON.stringify(last.content), /job noticed/);
	});

	test("completion during a busy run arrives through turn_end, after the tool result", async () => {
		const callsBefore = faux.state.callCount;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.05; echo quick-bg", run_in_background: true })),
			// Keep the run busy past the job's completion with a second, slower foreground call.
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.25" })),
			fauxAssistantMessage(fauxText("saw it")),
		]);
		await session.prompt("background then foreground");
		await waitFor(() => session.isIdle && faux.state.callCount === callsBefore + 3, 5000, "run to settle");
		const msgs = session.messages as any[];
		const noticeIndex = msgs.findLastIndex((m) => m.role === "custom" && m.customType === "bash-job-complete");
		assert.ok(noticeIndex > 0);
		assert.match(JSON.stringify(msgs[noticeIndex].content), /quick-bg/);
		assert.equal(msgs[noticeIndex - 1].role, "toolResult", "notice follows a tool result, never splits a tool call from its result");
		assert.equal(msgs.filter((m) => m.role === "custom" && /quick-bg/.test(JSON.stringify(m.content))).length, 1);
	});

	test("shortcuts, command and notice renderer register without conflicts with Pi's keys", async () => {
		const { KeybindingsManager } = await import(join(piRoot, "dist/core/keybindings.js"));
		const runner = session.extensionRunner;
		const shortcuts = runner.getShortcuts(new KeybindingsManager().getEffectiveConfig());
		assert.ok(shortcuts.has("alt+j") && shortcuts.has("ctrl+alt+b"));
		assert.deepEqual(runner.getShortcutDiagnostics(), []);
		assert.ok(runner.getRegisteredCommands().some((c: { name: string }) => c.name === "bash-jobs"));
		assert.ok(runner.getMessageRenderer("bash-job-complete"));
	});

	test("a model switch keeps background jobs and their completion", async () => {
		const callsBefore = faux.state.callCount;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.6; echo after-switch", run_in_background: true })),
			fauxAssistantMessage(fauxText("started")),
			fauxAssistantMessage(fauxToolCall("bash_job", { action: "list" })),
			fauxAssistantMessage(fauxText("listed")),
			fauxAssistantMessage(fauxText("completion seen")),
		]);
		await session.prompt("start it");
		await session.setModel(faux.getModel("faux-2")!);
		await session.prompt("list jobs");
		const listed = session.messages.findLast((m) => m.role === "toolResult") as any;
		assert.match(JSON.stringify(listed.content), /running/);
		await waitFor(() => faux.state.callCount === callsBefore + 5 && session.isIdle, 5000, "completion turn");
		const notices = session.messages.filter((m: any) => m.role === "custom" && /after-switch/.test(JSON.stringify(m.content)));
		assert.equal(notices.length, 1);
	});

	test("coexists with Codex-style suppression of bash via active-tool projection", async () => {
		const defaults = ["read", "bash", "edit", "write"];
		const before = session.getActiveToolNames();
		// Same projection as pi-codex-conversion's mergeAdapterTools: adapter tools + non-default tools.
		guardPi.setActiveTools(["exec_command", ...before.filter((n) => !defaults.includes(n) && n !== "exec_command")]);
		const codex = session.getActiveToolNames();
		assert.equal(codex.includes("bash"), false);
		assert.ok(codex.includes("exec_command"));
		assert.ok(codex.includes("bash_job"), "job controls stay reachable after a switch to Codex tools");
		guardPi.setActiveTools(before);
		assert.ok(session.getActiveToolNames().includes("bash"));
		assert.equal(guardPi.getAllTools().find((t) => t.name === "bash")?.sourceInfo?.path, EXTENSION);
	});
});
