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
import { NvmBlockInfo } from "../../../shared/protocol";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "../annotations/annotationService";
import { buildActiveReport } from "../report/reportCommands";

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

interface ChatApi {
	createChatParticipant(id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable;
}

function getChatApi(): ChatApi | undefined {
	const chat = (vscode as unknown as { chat?: Partial<ChatApi> }).chat;
	return chat && typeof chat.createChatParticipant === "function" ? (chat as ChatApi) : undefined;
}

/** Build a compact, model-friendly context for the active dump. */
async function buildContext(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): Promise<string> {
	const doc = registry.activeDocument;
	if (!doc) {
		return "There is no active NVM dump open in the hex editor.";
	}
	const blocks = registry.getNvmBlocks(doc) as NvmBlockInfo[];
	const set = await annotations.get(doc.uri);
	const lines: string[] = [];
	lines.push(`Active dump: ${doc.uri.path.replace(/^.*\//, "")}`);
	lines.push(`Blocks: ${blocks.length}, Bookmarks: ${set.bookmarks.length}, Tags: ${set.tags.length}, Notes: ${set.notes.length}`);
	if (blocks.length) {
		lines.push("", "Blocks:");
		for (const b of blocks.slice(0, 200)) {
			lines.push(`- ${b.name ?? b.id} @ ${hex(b.offset)} (len ${b.length}, ${b.fields?.length ?? 0} fields)`);
		}
	}
	return lines.join("\n");
}

/**
 * Register the `@nvm` chat participant (when the API exists) plus the
 * `hexEditor.nvm.openChat` command that opens Copilot Chat prefilled for NVM.
 */
export function registerChatParticipant(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
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
			const ctx = await buildContext(registry, annotations);
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
				const report = await buildActiveReport(registry, annotations);
				const query = report
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

/** Try to open the chat view with a starting query. Returns false if no API. */
async function tryOpenChat(query: string): Promise<boolean> {
	for (const cmd of ["workbench.action.chat.open", "workbench.action.chat.openInSidebar"]) {
		try {
			await vscode.commands.executeCommand(cmd, { query });
			return true;
		} catch {
			// try the next command id
		}
	}
	return false;
}
