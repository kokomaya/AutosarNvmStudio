// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Report generation: combine parsed NVM blocks with the user's bookmarks, tags
 * and notes into a Markdown analysis report. AI enrichment (P5) can prepend a
 * summary section produced by a language model.
 */

import { NvmBlockInfo } from "../../../shared/protocol";
import { AnnotationSet } from "../annotations/model";

export interface ReportInput {
	fileName: string;
	blocks: NvmBlockInfo[];
	annotations: AnnotationSet;
	/** Note id -> markdown body (resolved by the caller). */
	noteBodies: Map<string, string>;
	/** Optional AI-generated summary to prepend. */
	aiSummary?: string;
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

function rangeText(offset: number, endOffset?: number): string {
	return endOffset && endOffset > offset + 1 ? `${hex(offset)}–${hex(endOffset)}` : hex(offset);
}

/** Render a full Markdown report. */
export function generateReport(input: ReportInput): string {
	const { fileName, blocks, annotations, noteBodies, aiSummary } = input;
	const lines: string[] = [];

	lines.push(`# NVM Analysis Report — ${fileName}`, "");
	lines.push(`_Generated ${new Date().toISOString()}_`, "");

	if (aiSummary) {
		lines.push("## AI Summary", "", aiSummary.trim(), "");
	}

	lines.push("## Overview", "");
	lines.push(`- Blocks: **${blocks.length}**`);
	lines.push(`- Bookmarks: **${annotations.bookmarks.length}**`);
	lines.push(`- Tags: **${annotations.tags.length}** (${annotations.tagAssignments.length} assignments)`);
	lines.push(`- Notes: **${annotations.notes.length}**`, "");

	if (blocks.length) {
		lines.push("## Blocks", "");
		lines.push("| Name | Offset | Length | Fields |");
		lines.push("| --- | --- | ---: | ---: |");
		for (const b of blocks) {
			lines.push(
				`| ${escapeCell(b.name ?? b.id)} | ${hex(b.offset)} | ${b.length} | ${b.fields?.length ?? 0} |`,
			);
		}
		lines.push("");
	}

	if (annotations.bookmarks.length) {
		lines.push("## Bookmarks", "");
		for (const bm of annotations.bookmarks) {
			lines.push(`- **${escapeCell(bm.label ?? "Bookmark")}** — ${rangeText(bm.anchor.offset, bm.anchor.endOffset)}`);
		}
		lines.push("");
	}

	if (annotations.tags.length) {
		lines.push("## Tags", "");
		for (const tag of annotations.tags) {
			const assigns = annotations.tagAssignments.filter(a => a.tagId === tag.id);
			lines.push(`### ${escapeCell(tag.label)} (${assigns.length})`, "");
			for (const a of assigns) {
				lines.push(`- ${rangeText(a.anchor.offset, a.anchor.endOffset)}`);
			}
			lines.push("");
		}
	}

	if (annotations.notes.length) {
		lines.push("## Notes", "");
		for (const note of annotations.notes) {
			lines.push(
				`### ${escapeCell(note.title ?? "Note")} — ${rangeText(note.anchor.offset, note.anchor.endOffset)}`,
				"",
			);
			const body = noteBodies.get(note.id) ?? note.body ?? "";
			lines.push(body.trim() || "_(empty note)_", "");
		}
	}

	return lines.join("\n");
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|");
}
