// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bridge from the Vector FEE V3 container parser to the vendor-neutral
 * {@link NvmModel} consumed by the webview, Language Model tools, MCP server
 * and CLI.
 *
 * See docs/design.md §5 and [TODO-Vector].
 */

import { MemoryImage } from "../memoryImage";
import { BlockStatus, NvmBlock, NvmBlockInstance, NvmIssue, NvmModel, NvmSector } from "../model";
import { feeLcfgByTag, parseFeeLcfg } from "./feeLcfg";
import { FeeV3Options, parseVectorFeeV3 } from "./vectorFeeV3";

export interface FeeV3ModelOptions extends FeeV3Options {
	/** Contents of the generated `Fee_Lcfg.c` used to resolve block names/lengths. */
	feeLcfgSource?: string;
	/** Profile id recorded on the produced model. */
	profileId?: string;
}

/**
 * Parse a Vector FEE V3 image and lift it into an {@link NvmModel}. When a
 * `Fee_Lcfg.c` source is supplied, chunks are truncated to their configured net
 * payload length and annotated with their business block name.
 */
export function buildFeeV3Model(image: MemoryImage, opts: FeeV3ModelOptions = {}): NvmModel {
	const result = parseVectorFeeV3(image, opts);
	const byTag = opts.feeLcfgSource ? feeLcfgByTag(parseFeeLcfg(opts.feeLcfgSource)) : undefined;

	const blocks: NvmBlock[] = [];
	const allInstances: NvmBlockInstance[] = [];
	const issues: NvmIssue[] = [];

	for (const chunk of result.chunks) {
		const def = byTag?.get(chunk.tag);
		const netLength = def?.payloadLength ?? chunk.size;
		const payloadStart = chunk.payloadAddress;
		const payloadEnd = payloadStart + netLength;

		const status: BlockStatus = "valid";

		const instance: NvmBlockInstance = {
			logicalId: chunk.tag,
			fileRange: { start: chunk.headerAddress, end: payloadStart + chunk.size },
			header: { tag: chunk.tag, size: chunk.size, bank: chunk.bank },
			payloadRange: { start: payloadStart, end: payloadEnd },
			crc: {},
			datasetIndex: chunk.slotIndex,
			status,
		};

		allInstances.push(instance);
		blocks.push({
			logicalId: chunk.tag,
			name: def?.name,
			active: instance,
			history: [],
		});

		if (!chunk.consistent) {
			issues.push({
				severity: "warning",
				code: "FEE_SLOT_TAG_MISMATCH",
				message: `FEE chunk tag ${chunk.tag} was reached through link-table slot ${chunk.slotIndex}`,
				blockId: chunk.tag,
			});
		}
		if (!def) {
			issues.push({
				severity: "info",
				code: "FEE_TAG_UNRESOLVED",
				message: `No Fee_Lcfg entry for tag ${chunk.tag}; using raw chunk size`,
				blockId: chunk.tag,
			});
		}
	}

	blocks.sort((a, b) => a.active.fileRange.start - b.active.fileRange.start);
	allInstances.sort((a, b) => a.fileRange.start - b.fileRange.start);

	const sectors: NvmSector[] = result.sections.map(s => ({
		index: s.bank,
		fileRange: { start: s.linkTableAddress, end: s.linkTableAddress + s.ltSize * result.alignment },
		meta: { id: s.id, ltSize: s.ltSize, usedSlots: s.usedSlots, chunks: s.chunks.length },
	}));

	return {
		profileId: opts.profileId ?? "vector-fee-v3",
		sectors,
		blocks,
		allInstances,
		issues,
	};
}
