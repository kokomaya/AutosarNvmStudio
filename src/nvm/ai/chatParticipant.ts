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

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

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
		const page = caps.listBlocks({ limit: 200 });
		const annotations = await caps.listAnnotations();
		const lines: string[] = [];
		lines.push(
			`Blocks: ${page.total}, Bookmarks: ${annotations.bookmarks.length}, Tags: ${annotations.tags.length}, Notes: ${annotations.notes.length}`,
		);
		if (page.items.length) {
			lines.push("", "Blocks:");
			for (const b of page.items) {
				lines.push(`- ${b.name ?? b.id} @ ${hex(b.offset)} (len ${b.length}, ${b.fieldCount} fields)`);
			}
			if (page.hasMore) {
				lines.push(`… ${page.total - page.returned} more (use #nvmSearchBlocks to narrow).`);
			}
		}
		return lines.join("\n");
	} catch (e) {
		return e instanceof Error ? e.message : "There is no active NVM dump open in the hex editor.";
	}
}

/**
 * Register the `@nvm` chat participant (when the API exists) plus the
 * `hexEditor.nvm.openChat` command that opens Copilot Chat prefilled for NVM.
 */
export function registerChatParticipant(caps: NvmCapabilities): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	const chat = getChatApi();

	if (chat) {
		const handler = async (
			request: { prompt: string; model?: unknown },
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
			const messages = buildMessages(
				`You are an assistant embedded in an AUTOSAR NVM hex-analysis tool. Answer using the provided dump context. Be concise and technical.\n\nCONTEXT:\n${ctx}`,
				request.prompt,
			);
			try {
				const response = await model.sendRequest(messages, {}, token);
				for await (const fragment of response.text) {
					stream.markdown(fragment);
				}
			} catch (e) {
				stream.markdown(`AI request failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		};

		try {
			disposables.push(chat.createChatParticipant("hexEditor.nvm", handler as never));
		} catch (e) {
			console.warn("NVM chat participant registration failed:", e);
		}
	}

	disposables.push(
		vscode.commands.registerCommand("hexEditor.nvm.openChat", async () => {
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
	): Promise<{ text: AsyncIterable<string> }>;
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
