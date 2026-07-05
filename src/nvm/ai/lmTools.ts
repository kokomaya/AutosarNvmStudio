// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * VS Code Language Model Tools for NVM analysis. These let Copilot (or any
 * agent using the LM Tools API) query the active dump: list blocks, analyze a
 * block, list annotations, export a report and run risk heuristics.
 *
 * The LM Tools API postdates this extension's `@types/vscode` baseline, so it is
 * accessed loosely and guarded — the tools simply don't register on hosts
 * without the API (older desktop / web).
 */

import * as vscode from "vscode";
import { NvmBlockInfo } from "../../../shared/protocol";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "../annotations/annotationService";
import { buildActiveReport } from "../report/reportCommands";

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

// Loose views of the LM Tools API (not present in the pinned @types/vscode).
interface LmToolInvokeOptions<T> {
	input?: T;
}
interface LmTool<T> {
	invoke(options: LmToolInvokeOptions<T>, token?: vscode.CancellationToken): Promise<unknown>;
}
interface LmApi {
	registerTool<T>(name: string, tool: LmTool<T>): vscode.Disposable;
}

function getLmApi(): LmApi | undefined {
	const lm = (vscode as unknown as { lm?: Partial<LmApi> }).lm;
	return lm && typeof lm.registerTool === "function" ? (lm as LmApi) : undefined;
}

/** Build a text tool result using whichever result class the host provides. */
function textResult(result: string): unknown {
	const v = vscode as unknown as {
		LanguageModelToolResult?: new (parts: unknown[]) => unknown;
		LanguageModelTextPart?: new (s: string) => unknown;
	};
	if (v.LanguageModelToolResult && v.LanguageModelTextPart) {
		return new v.LanguageModelToolResult([new v.LanguageModelTextPart(result)]);
	}
	// Fallback shape accepted by early proposals.
	return { content: [{ kind: "text", value: result }] };
}

function activeBlocks(registry: HexEditorRegistry): NvmBlockInfo[] | undefined {
	const doc = registry.activeDocument;
	return doc ? (registry.getNvmBlocks(doc) as NvmBlockInfo[]) : undefined;
}

/** Register all NVM language-model tools. No-op on hosts without the LM API. */
export function registerLmTools(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
	const lm = getLmApi();
	if (!lm) {
		return [];
	}
	const d: vscode.Disposable[] = [];

	d.push(
		lm.registerTool("nvm_listBlocks", {
			invoke: async () => {
				const blocks = activeBlocks(registry);
				if (!blocks) {
					return textResult("No active NVM dump. Open a dump in the hex editor first.");
				}
				if (blocks.length === 0) {
					return textResult("The active dump has no parsed NVM blocks (no matching layout/engine).");
				}
				const lines = blocks.map(
					b => `- ${b.name ?? b.id} @ ${hex(b.offset)} (len ${b.length}, ${b.fields?.length ?? 0} fields)`,
				);
				return textResult(`NVM blocks (${blocks.length}):\n${lines.join("\n")}`);
			},
		}),
	);

	d.push(
		lm.registerTool<{ name: string }>("nvm_analyzeBlock", {
			invoke: async options => {
				const blocks = activeBlocks(registry);
				if (!blocks?.length) {
					return textResult("No parsed NVM blocks in the active dump.");
				}
				const q = (options.input?.name ?? "").toLowerCase();
				const block =
					blocks.find(b => (b.name ?? b.id).toLowerCase() === q) ??
					blocks.find(b => (b.name ?? b.id).toLowerCase().includes(q));
				if (!block) {
					return textResult(`No block matching "${options.input?.name}".`);
				}
				const fields = (block.fields ?? [])
					.map(
						f =>
							`  - ${f.name} [${f.kind}] @ ${hex(f.offset)} len ${f.length}${
								f.link ? ` → ${hex(f.link.targetOffset)}` : ""
							}`,
					)
					.join("\n");
				return textResult(
					`Block: ${block.name ?? block.id}\nOffset: ${hex(block.offset)}\nLength: ${
						block.length
					}\nRaw: ${JSON.stringify(block.raw ?? {})}\nFields:\n${fields || "  (none)"}`,
				);
			},
		}),
	);

	d.push(
		lm.registerTool("nvm_listAnnotations", {
			invoke: async () => {
				const doc = registry.activeDocument;
				if (!doc) {
					return textResult("No active NVM dump.");
				}
				const set = await annotations.get(doc.uri);
				const bm = set.bookmarks.map(b => `  - ${b.label ?? "bookmark"} @ ${hex(b.anchor.offset)}`).join("\n");
				const tags = set.tags
					.map(t => `  - ${t.label} (${set.tagAssignments.filter(a => a.tagId === t.id).length})`)
					.join("\n");
				const notes = set.notes.map(n => `  - ${n.title ?? "note"} @ ${hex(n.anchor.offset)}`).join("\n");
				return textResult(
					`Bookmarks:\n${bm || "  (none)"}\nTags:\n${tags || "  (none)"}\nNotes:\n${notes || "  (none)"}`,
				);
			},
		}),
	);

	d.push(
		lm.registerTool("nvm_exportReport", {
			invoke: async () => {
				const report = await buildActiveReport(registry, annotations);
				return report ? textResult(report.markdown) : textResult("No active NVM dump to report on.");
			},
		}),
	);

	d.push(
		lm.registerTool("nvm_riskDetection", {
			invoke: async () => {
				const blocks = activeBlocks(registry);
				if (!blocks?.length) {
					return textResult("No parsed NVM blocks to analyze.");
				}
				const risks: string[] = [];
				const unresolved = blocks.filter(b => /^Tag \d+$/.test(b.name ?? ""));
				if (unresolved.length) {
					risks.push(
						`- ${unresolved.length} block(s) have unresolved names ("Tag N") — the engine's config source (e.g. the generated block table) may be missing.`,
					);
				}
				const empty = blocks.filter(b => !b.fields?.length && b.length === 0);
				if (empty.length) {
					risks.push(`- ${empty.length} zero-length block(s).`);
				}
				const overlap = findOverlap(blocks);
				if (overlap !== undefined) {
					risks.push(`- Overlapping blocks detected near ${hex(overlap)}.`);
				}
				return textResult(
					risks.length ? `Potential risks:\n${risks.join("\n")}` : "No obvious risks detected.",
				);
			},
		}),
	);

	return d;
}

function findOverlap(blocks: NvmBlockInfo[]): number | undefined {
	const sorted = [...blocks].sort((a, b) => a.offset - b.offset);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].length) {
			return sorted[i].offset;
		}
	}
	return undefined;
}
