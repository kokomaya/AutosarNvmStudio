// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * VS Code Language Model Tools for NVM analysis. These let Copilot (or any agent
 * using the LM Tools API) query the active dump. Every tool is a THIN adapter:
 * it validates the model's input, calls the vendor-blind {@link NvmCapabilities}
 * facade (which owns all paging/caps/guardrails), and formats the structured
 * result as text. No data-access or capping logic lives here (SRP/DIP).
 *
 * The LM Tools API postdates this extension's `@types/vscode` baseline, so it is
 * accessed loosely and guarded — the tools simply don't register on hosts
 * without the API (older desktop / web).
 */

import * as vscode from "vscode";
import {
	AnnotationsSummary,
	BlockSummary,
	DecodedSummaryNode,
	NvmCapabilities,
	NvmCapabilityError,
	Page,
} from "./nvmCapabilities";

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

/** Wrap a capability call so {@link NvmCapabilityError} becomes a normal result. */
async function guarded(fn: () => Promise<string> | string): Promise<unknown> {
	try {
		return textResult(await fn());
	} catch (e) {
		if (e instanceof NvmCapabilityError) {
			return textResult(e.message);
		}
		return textResult(`NVM tool error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function formatBlockPage(page: Page<BlockSummary>): string {
	if (page.total === 0) {
		return "The active dump has no matching NVM blocks.";
	}
	const lines = page.items.map(
		b => `- ${b.name ?? b.id} @ ${hex(b.offset)} (len ${b.length}, ${b.fieldCount} fields)`,
	);
	const range = `Showing ${page.offset + 1}–${page.offset + page.returned} of ${page.total}`;
	const more = page.hasMore
		? `\n(${page.total - page.offset - page.returned} more — call again with offset ${
				page.offset + page.returned
			})`
		: "";
	return `${range}:\n${lines.join("\n")}${more}`;
}

function formatDecoded(nodes: DecodedSummaryNode[], depth: number): string {
	const out: string[] = [];
	for (const n of nodes) {
		const indent = "  ".repeat(depth);
		const val =
			n.enumLabel !== undefined
				? n.enumLabel
				: n.value !== undefined
					? String(n.value)
					: n.type;
		const unit = n.unit ? ` ${n.unit}` : "";
		out.push(`${indent}- ${n.name}: ${val}${unit} @ ${hex(n.offset)}`);
		if (n.children?.length) {
			out.push(formatDecoded(n.children, depth + 1));
		}
	}
	return out.join("\n");
}

function formatAnnotations(a: AnnotationsSummary): string {
	const bm = a.bookmarks.map(b => `  - ${b.label ?? "bookmark"} @ ${hex(b.offset)}`).join("\n");
	const tags = a.tags.map(t => `  - ${t.label} (${t.assignments})`).join("\n");
	const notes = a.notes
		.map(n => `  - ${n.title ?? "note"} @ ${hex(n.offset)}–${hex(n.end)}`)
		.join("\n");
	const trunc = a.truncated ? "\n(some annotations omitted — list capped)" : "";
	return `Bookmarks:\n${bm || "  (none)"}\nTags:\n${tags || "  (none)"}\nNotes:\n${notes || "  (none)"}${trunc}`;
}

/** Register all NVM language-model tools. No-op on hosts without the LM API. */
export function registerLmTools(caps: NvmCapabilities): vscode.Disposable[] {
	const lm = getLmApi();
	if (!lm) {
		return [];
	}
	const d: vscode.Disposable[] = [];

	d.push(
		lm.registerTool<{ limit?: number; offset?: number }>("nvm_listBlocks", {
			invoke: async options =>
				guarded(() =>
					formatBlockPage(
						caps.listBlocks({ limit: options.input?.limit, offset: options.input?.offset }),
					),
				),
		}),
	);

	d.push(
		lm.registerTool<{ query: string; limit?: number; offset?: number }>("nvm_searchBlocks", {
			invoke: async options =>
				guarded(() =>
					formatBlockPage(
						caps.searchBlocks(options.input?.query ?? "", {
							limit: options.input?.limit,
							offset: options.input?.offset,
						}),
					),
				),
		}),
	);

	d.push(
		lm.registerTool<{ name: string }>("nvm_analyzeBlock", {
			invoke: async options =>
				guarded(() => {
					const b = caps.analyzeBlock(options.input?.name ?? "");
					const fields = b.fields
						.map(
							f =>
								`  - ${f.name} [${f.kind}] @ ${hex(f.offset)} len ${f.length}${
									f.linkTarget !== undefined ? ` → ${hex(f.linkTarget)}` : ""
								}`,
						)
						.join("\n");
					const rawLine =
						b.raw !== undefined ? `\nRaw${b.rawTruncated ? " (truncated)" : ""}: ${b.raw}` : "";
					const fieldsHdr = `Fields${b.fieldsTruncated ? " (truncated)" : ""}:`;
					return `Block: ${b.name ?? b.id}\nOffset: ${hex(b.offset)}\nLength: ${b.length}${rawLine}\n${fieldsHdr}\n${fields || "  (none)"}`;
				}),
		}),
	);

	d.push(
		lm.registerTool<{ name: string; maxDepth?: number; maxNodes?: number }>("nvm_getDecoded", {
			invoke: async options =>
				guarded(() => {
					const s = caps.getDecoded(options.input?.name ?? "", {
						maxDepth: options.input?.maxDepth,
						maxNodes: options.input?.maxNodes,
					});
					if (s.nodes.length === 0) {
						return `Block "${s.block}" has no decoded structure (not bound to a struct).`;
					}
					const trunc = s.truncated ? "\n(tree truncated — raise maxDepth/maxNodes for more)" : "";
					return `Decoded ${s.block}:\n${formatDecoded(s.nodes, 0)}${trunc}`;
				}),
		}),
	);

	d.push(
		lm.registerTool<{ offset: number; length: number }>("nvm_readBytes", {
			invoke: async options =>
				guarded(async () => {
					const w = await caps.readBytes(options.input?.offset ?? -1, options.input?.length ?? 0);
					return `Bytes @ ${hex(w.offset)} (${w.length} B):\n${w.hex}`;
				}),
		}),
	);

	d.push(
		lm.registerTool("nvm_listAnnotations", {
			invoke: async () => guarded(async () => formatAnnotations(await caps.listAnnotations())),
		}),
	);

	d.push(
		lm.registerTool<{ blockName?: string; start?: number; end?: number; title: string; body: string }>(
			"nvm_createNote",
			{
				invoke: async options =>
					guarded(async () => {
						const r = await caps.createNote({
							blockName: options.input?.blockName,
							start: options.input?.start,
							end: options.input?.end,
							title: options.input?.title ?? "",
							body: options.input?.body ?? "",
						});
						return r.created
							? `Created note${r.noteId ? ` (${r.noteId})` : ""}.`
							: `Note not created: ${r.reason ?? "cancelled"}.`;
					}),
			},
		),
	);

	d.push(
		lm.registerTool("nvm_exportReport", {
			invoke: async () =>
				guarded(async () => {
					const r = await caps.exportReport();
					return r.truncated ? `${r.markdown}\n\n> (report truncated)` : r.markdown;
				}),
		}),
	);

	d.push(
		lm.registerTool("nvm_riskDetection", {
			invoke: async () =>
				guarded(() => {
					const { risks } = caps.riskDetection();
					return risks.length
						? `Potential risks:\n${risks.map(r => `- ${r}`).join("\n")}`
						: "No obvious risks detected.";
				}),
		}),
	);

	return d;
}
