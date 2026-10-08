/** Scripted local model for real print/JSON lifecycle tests. No network or credentials. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider();
	let step = 0;
	const respond = (context: any) => {
		const text = JSON.stringify(context.messages);
		if (text.includes("[bash background job finished]")) {
			return fauxAssistantMessage(text.includes("was killed after") ? "FINAL_TIMEOUT_OBSERVED" : "FINAL_COMPLETION_OBSERVED");
		}
		if (step++ === 0) {
			if (text.includes("case-multiple")) {
				return fauxAssistantMessage([
					fauxToolCall("bash", { command: "sleep 0.6; echo FIRST_JOB_FINISHED", run_in_background: true }),
					fauxToolCall("bash", { command: "sleep 1.0; echo SECOND_JOB_FINISHED", run_in_background: true }),
				]);
			}
			const timeout = text.includes("case-timeout");
			return fauxAssistantMessage(fauxToolCall("bash", {
				command: timeout ? "sleep 4; echo SHOULD_NOT_FINISH" : "sleep 0.6; echo HEADLESS_JOB_FINISHED",
				timeout: timeout ? 0.4 : 5,
				run_in_background: text.includes("case-explicit"),
			}));
		}
		if (step === 2) {
			return fauxAssistantMessage(fauxToolCall("bash", { command: "echo INDEPENDENT_WORK" }));
		}
		return fauxAssistantMessage("INTERIM_STILL_RUNNING");
	};
	faux.setResponses(Array.from({ length: 12 }, () => respond));
	pi.registerProvider(faux.provider as never);
	pi.on("before_agent_start", (event, ctx) => {
		if (event.prompt.includes("case-abort")) setTimeout(() => ctx.abort(), 200);
	});
	// Like an auto-exiting host: waiting until agent_before_settle is too late.
	pi.on("agent_end", (_event, ctx) => ctx.shutdown());
}
