// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `@nvm` chat participant: reuses the built-in Copilot Chat UI so users can ask
 * questions about the active NVM dump in natural language. The handler gathers a
 * compact context (blocks + annotations) from the active hex editor and forwards
 * the conversation to the user's selected language model.
 *
 * The Chat API postdates this extension's `@types/vscode` baseline, so it is
 * accessed loosely and guarded — nothing registers on hosts without the API, and
 * the "Ask NVM AI" command falls back to opening the chat with the NVM tools.
 */

import * as vscode from "vscode";
import { NvmCapabilities } from "./nvmCapabilities";

interface ChatApi {
	createChatParticipant(id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable;
}

function getChatApi(): ChatApi | undefined {
	const chat = (vscode as unknown as { chat?: Partial<ChatApi> }).chat;
	return chat && typeof chat.createChatParticipant === "function" ? (chat as ChatApi) : undefined;
}

/** Build a compact, model-friendly context for the active dump (via the facade). */
async function buildContext(caps: NvmCapabilities): Promise<string> {
	try {
		const o = caps.describeDump();
		const annotations = await caps.listAnnotations();
		const lines: string[] = [];
		lines.push(
			`Dump: ${o.totalBlocks} blocks (decoded ${o.decodedBlocks}, ${o.distinctStructures} distinct structures). ` +
				`Annotations: ${annotations.bookmarks.length} bookmarks, ${annotations.tags.length} tags, ${annotations.notes.length} notes.`,
		);
		if (o.nameFamilies.length) {
			lines.push("", "Top block name families (name* : count):");
			for (const f of o.nameFamilies.slice(0, 25)) {
				lines.push(`- ${f.key} : ${f.count}`);
			}
			if (o.truncated.nameFamilies) {
				lines.push("- … more families (use #nvmDescribeDump for the full aggregate)");
			}
		}
		for (const a of o.attributes.slice(0, 4)) {
			const vals = a.values.slice(0, 8).map(v => `${v.key}(${v.count})`).join(", ");
			lines.push("", `${a.label}: ${vals}`);
		}
		return lines.join("\n");
	} catch (e) {
		return e instanceof Error ? e.message : "There is no active NVM dump open in the hex editor.";
	}
}

const SYSTEM_PROMPT =
	"You are an assistant embedded in an AUTOSAR NVM hex-analysis tool. Answer using the " +
	"provided dump context and the NVM tools. The context is only an aggregate summary — for " +
	"EXACT counts of a block type call the nvm_describeDump tool (never guess from a truncated " +
	"list); to find blocks by name/field/attribute call nvm_searchBlocks; to inspect one block " +
	"call nvm_analyzeBlock / nvm_getDecoded. Be concise and technical.";

/**
 * Register the `@nvm` chat participant (when the API exists) plus the
 * `nvmStudio.nvm.openChat` command that opens Copilot Chat prefilled for NVM.
 */
export function registerChatParticipant(caps: NvmCapabilities): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const chat = getChatApi();

	if (chat) {
		const handler = async (
			request: { prompt: string; model?: unknown; toolInvocationToken?: unknown },
			_context: unknown,
			stream: {
				markdown(v: string): void;
				progress?(v: string): void;
			},
			token: vscode.CancellationToken,
		): Promise<void> => {
			const ctx = await buildContext(caps);
			const model = (request as { model?: LanguageModelLike }).model;
			if (!model || typeof model.sendRequest !== "function") {
				stream.markdown(
					"No language model is available. Here is the current NVM context:\n\n```\n" + ctx + "\n```",
				);
				return;
			}
			const system = `${SYSTEM_PROMPT}\n\nCONTEXT:\n${ctx}`;
			try {
				// Preferred path: let the model iteratively call the #nvm* tools so it
				// can fetch exact counts / drill into blocks. Falls back to a single
				// pass with the aggregate context when the tool-calling API is absent.
				const usedTools = await runWithTools(
					model,
					system,
					request.prompt,
					stream,
					token,
					request.toolInvocationToken,
				);
				if (!usedTools) {
					const messages = buildMessages(system, request.prompt);
					const response = await model.sendRequest(messages, {}, token);
					for await (const fragment of response.text) {
						stream.markdown(fragment);
					}
				}
			} catch (e) {
				stream.markdown(`AI request failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		};

		try {
			disposables.push(chat.createChatParticipant("nvmStudio.nvm", handler as never));
		} catch (e) {
			console.warn("NVM chat participant registration failed:", e);
		}
	}

	disposables.push(
		vscode.commands.registerCommand("nvmStudio.nvm.openChat", async () => {
			// Prefer opening Copilot Chat addressed to our participant; fall back to
			// a report-context message if the participant/API is unavailable.
			const opened = await tryOpenChat("@nvm ");
			if (!opened) {
				let hasDump = false;
				try {
					caps.listBlocks({ limit: 1 });
					hasDump = true;
				} catch {
					hasDump = false;
				}
				const query = hasDump
					? `Analyze this NVM dump. Use #nvmListBlocks and #nvmRiskDetection.`
					: "Open an NVM dump, then ask about it here.";
				await tryOpenChat(query);
			}
		}),
	);

	return disposables;
}

interface LanguageModelLike {
	sendRequest(
		messages: unknown[],
		options: unknown,
		token: vscode.CancellationToken,
	): Promise<{ text: AsyncIterable<string>; stream?: AsyncIterable<unknown> }>;
}

/**
 * Run the model with the `nvm_*` language-model tools bound, looping to service
 * tool calls, and stream the assistant text. Returns false (without emitting)
 * when the tool-calling API classes are unavailable, so the caller can fall
 * back to a single-pass request. All API access is loose + guarded because the
 * tool-calling API postdates this extension's `@types/vscode` baseline.
 */
async function runWithTools(
	model: LanguageModelLike,
	system: string,
	prompt: string,
	stream: { markdown(v: string): void },
	token: vscode.CancellationToken,
	toolInvocationToken: unknown,
): Promise<boolean> {
	const v = vscode as unknown as {
		lm?: { tools?: { name: string; description?: string; inputSchema?: unknown }[]; invokeTool?: (...a: unknown[]) => Promise<unknown> };
		LanguageModelChatMessage?: { User(v: unknown): unknown; Assistant(v: unknown): unknown };
		LanguageModelToolCallPart?: new (...a: unknown[]) => unknown;
		LanguageModelToolResultPart?: new (callId: string, content: unknown[]) => unknown;
		LanguageModelTextPart?: new (s: string) => unknown;
	};
	const lm = v.lm;
	const Msg = v.LanguageModelChatMessage;
	const ToolCallPart = v.LanguageModelToolCallPart;
	const ToolResultPart = v.LanguageModelToolResultPart;
	const TextPart = v.LanguageModelTextPart;
	if (
		!lm ||
		typeof lm.invokeTool !== "function" ||
		!Array.isArray(lm.tools) ||
		!Msg ||
		typeof Msg.User !== "function" ||
		typeof Msg.Assistant !== "function" ||
		!ToolCallPart ||
		!ToolResultPart ||
		!TextPart
	) {
		return false;
	}
	const tools = lm.tools
		.filter(t => typeof t.name === "string" && t.name.startsWith("nvm_"))
		.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	if (tools.length === 0) {
		return false;
	}

	const messages: unknown[] = [Msg.User(`${system}\n\n${prompt}`)];
	const MAX_ROUNDS = 5;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		if (token.isCancellationRequested) {
			return true;
		}
		const response = await model.sendRequest(messages, { tools }, token);
		const parts = response.stream ?? response.text;
		const toolCalls: { callId: string; name: string; input: unknown; part: unknown }[] = [];
		const assistantParts: unknown[] = [];
		for await (const part of parts as AsyncIterable<unknown>) {
			if (typeof part === "string") {
				stream.markdown(part);
				continue;
			}
			const p = part as { value?: unknown; callId?: string; name?: string; input?: unknown };
			if (typeof p.callId === "string" && typeof p.name === "string") {
				toolCalls.push({ callId: p.callId, name: p.name, input: p.input, part });
				assistantParts.push(part);
			} else if (typeof p.value === "string") {
				stream.markdown(p.value);
			}
		}
		if (toolCalls.length === 0) {
			return true;
		}
		messages.push(Msg.Assistant(assistantParts));
		const resultParts: unknown[] = [];
		for (const call of toolCalls) {
			let resultText: string;
			try {
				const res = await lm.invokeTool(
					call.name,
					{ input: call.input ?? {}, toolInvocationToken },
					token,
				);
				resultText = extractToolText(res);
			} catch (e) {
				resultText = `Tool ${call.name} failed: ${e instanceof Error ? e.message : String(e)}`;
			}
			resultParts.push(new ToolResultPart(call.callId, [new TextPart(resultText)]));
		}
		messages.push(Msg.User(resultParts));
	}
	return true;
}

/** Flatten a LanguageModelToolResult's content parts into a text string. */
function extractToolText(res: unknown): string {
	const content = (res as { content?: unknown })?.content;
	if (!Array.isArray(content)) {
		return typeof res === "string" ? res : "";
	}
	return content
		.map(p => (typeof (p as { value?: unknown })?.value === "string" ? (p as { value: string }).value : ""))
		.join("");
}

/** Build chat messages using whichever message class the host provides. */
function buildMessages(system: string, user: string): unknown[] {
	const v = vscode as unknown as {
		LanguageModelChatMessage?: { User(v: string): unknown };
	};
	if (v.LanguageModelChatMessage && typeof v.LanguageModelChatMessage.User === "function") {
		return [v.LanguageModelChatMessage.User(`${system}\n\n${user}`)];
	}
	return [{ role: "user", content: `${system}\n\n${user}` }];
}

/**
 * Try to open the chat view with a starting query. Returns false if no API.
 * `isPartialQuery: true` places the text in the chat input box WITHOUT
 * auto-submitting it, so the user can edit the prompt before sending (VS Code
 * only calls `setInput`, not `acceptInput`, for a partial query).
 */
async function tryOpenChat(query: string): Promise<boolean> {
	for (const cmd of ["workbench.action.chat.open", "workbench.action.chat.openInSidebar"]) {
		try {
			await vscode.commands.executeCommand(cmd, { query, isPartialQuery: true });
			return true;
		} catch {
			// try the next command id
		}
	}
	return false;
}
