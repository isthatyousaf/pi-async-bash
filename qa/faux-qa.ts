/**
 * QA-only extension: a scripted local model (Pi's faux provider) so the real Pi TUI can be
 * exercised without network or model spend. Not part of the shipped extension.
 *
 * Prompts:
 *   run <cmd>               bash call
 *   bg <cmd>                bash call with run_in_background
 *   desc <label> :: <cmd>   bash call with a description
 *   to <secs> <cmd>         bash call with a timeout
 *   two <cmd1> || <cmd2>    two bash calls in one assistant message
 *   anything else           plain text reply
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

function textOf(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.map((c: any) => c.text ?? "").join("");
	return "";
}

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ tokensPerSecond: 400 });
	let n = 0;
	const respond = (context: any) => {
		const messages = context.messages ?? [];
		const last = messages[messages.length - 1];
		if (!last) return fauxAssistantMessage("ready");
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Done."));
		const text = textOf(last).trim();
		if (/bash background job/.test(text)) return fauxAssistantMessage(fauxText("Noted the background result."));
		const id = () => `qa-${++n}`;
		let m: RegExpExecArray | null;
		if ((m = /^run ([\s\S]+)$/.exec(text))) return fauxAssistantMessage(fauxToolCall("bash", { command: m[1] }, { id: id() }));
		if ((m = /^bg ([\s\S]+)$/.exec(text))) return fauxAssistantMessage(fauxToolCall("bash", { command: m[1], run_in_background: true }, { id: id() }));
		if ((m = /^desc (.+?) :: ([\s\S]+)$/.exec(text))) return fauxAssistantMessage(fauxToolCall("bash", { command: m[2], description: m[1] }, { id: id() }));
		if ((m = /^to (\d+(?:\.\d+)?) ([\s\S]+)$/.exec(text))) return fauxAssistantMessage(fauxToolCall("bash", { command: m[2], timeout: Number(m[1]) }, { id: id() }));
		if ((m = /^two ([\s\S]+?) \|\| ([\s\S]+)$/.exec(text)))
			return fauxAssistantMessage([fauxToolCall("bash", { command: m[1] }, { id: id() }), fauxToolCall("bash", { command: m[2] }, { id: id() })]);
		return fauxAssistantMessage(fauxText(`ok: ${text.slice(0, 40)}`));
	};
	faux.setResponses(Array.from({ length: 2000 }, () => respond));
	pi.registerProvider(faux.provider as never);
}
