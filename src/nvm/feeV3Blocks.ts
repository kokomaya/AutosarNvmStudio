// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Build editor-space NVM block descriptors (with colored sub-fields) from a
 * Vector FEE V3 image. This bridges the verified `parseVectorFeeV3` container
 * parser to the {@link NvmBlockInfo} shape consumed by the webview.
 *
 * See docs/nvm-context.md §7 for the verified FEE V3 layout.
 */

import {
    FeeV3Chunk,
    feeLcfgByTag,
    loadHexImage,
    parseFeeLcfg,
    parseVectorFeeV3,
} from "../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../shared/protocol";

/** Size of the FEE V3 chunk header: tag(2) reserved(2) size(4). */
const CHUNK_HEADER_SIZE = 8;

/**
 * Parse an S-record / Intel HEX image and return one {@link NvmBlockInfo} per
 * FEE V3 chunk. Offsets are expressed in the editor's byte space (i.e. relative
 * to the image base address, which maps to editor offset 0).
 *
 * Returns an empty array when the text is not a FEE V3 container.
 */
export function buildFeeV3Blocks(imageText: string, feeLcfgSource?: string): NvmBlockInfo[] {
	let image;
	try {
		image = loadHexImage(imageText);
	} catch {
		return [];
	}
	if (image.span === 0) {
		return [];
	}

	let result;
	try {
		result = parseVectorFeeV3(image);
	} catch {
		return [];
	}
	if (result.chunks.length === 0) {
		return [];
	}

	const byTag = feeLcfgSource ? feeLcfgByTag(parseFeeLcfg(feeLcfgSource)) : undefined;
	const base = result.baseAddress;
	const blocks: NvmBlockInfo[] = [];

	// 1) Sector structure: header + the sector/link table (one 8-byte slot per
	// block index). This colors the region at the start of every sector so the
	// user can see and click the table that maps slots -> data blocks.
	const alignment = result.alignment;
	for (const section of result.sections) {
		const sectionOffset = section.linkTableAddress - alignment - base;
		const linkTableOffset = section.linkTableAddress - base;
		if (sectionOffset < 0) {
			continue;
		}

		const bySlot = new Map<number, FeeV3Chunk>();
		for (const c of section.chunks) {
			bySlot.set(c.slotIndex, c);
		}

		const headerUnit = `sector${section.bank}:header`;
		const fields: NvmFieldInfo[] = [
			// Sector header sub-fields (verified: id/counter, then ltSize; the
			// trailing bytes carry a one's-complement check of the first bytes).
			{ name: `Counter / id (0x${section.id.toString(16)})`, kind: "counter", offset: sectionOffset, length: 1, unit: headerUnit },
			{ name: `ltSize (${section.ltSize} slots)`, kind: "ltSize", offset: sectionOffset + 1, length: 2, unit: headerUnit },
			{ name: "Header status / complement", kind: "status", offset: sectionOffset + 3, length: alignment - 3, unit: headerUnit },
		];
		for (let slot = 0; slot < section.ltSize; slot++) {
			const slotOffset = linkTableOffset + slot * alignment;
			const slotUnit = `sector${section.bank}:slot${slot}`;
			const c = bySlot.get(slot);
			if (c) {
				const def = byTag?.get(c.tag);
				const label = def?.name ?? `tag ${c.tag}`;
				// Link-table slot: linkTarget(4 LE) payloadSize(2 LE) pad(2).
				fields.push(
					{
						name: `Slot ${slot} → ${label}: linkTarget`,
						kind: "linkTarget",
						offset: slotOffset,
						length: 4,
						unit: slotUnit,
					},
					{
						name: `Slot ${slot} → ${label}: payloadSize (${def?.payloadLength ?? c.size} B)`,
						kind: "payloadSize",
						offset: slotOffset + 4,
						length: 2,
						unit: slotUnit,
					},
					{ name: `Slot ${slot} → ${label}: pad`, kind: "pad", offset: slotOffset + 6, length: 2, unit: slotUnit },
				);
			} else {
				fields.push({
					name: `Slot ${slot} (unused)`,
					kind: "linkEmpty",
					offset: slotOffset,
					length: alignment,
					unit: slotUnit,
				});
			}
		}

		blocks.push({
			id: `sector${section.bank}`,
			name: `Sector ${section.bank} table (id=0x${section.id.toString(16)}, ${section.usedSlots} used)`,
			offset: sectionOffset,
			length: alignment + section.ltSize * alignment,
			raw: {
				bank: section.bank,
				id: section.id,
				ltSize: section.ltSize,
				usedSlots: section.usedSlots,
				chunks: section.chunks.length,
			},
			fields,
		});
	}

	// 2) Data blocks: each FEE chunk split into header / marker / payload.
	for (const c of result.chunks) {
		const def = byTag?.get(c.tag);
		const netLength = def?.payloadLength ?? c.size;

		const headerOffset = c.headerAddress - base;
		const payloadOffset = c.payloadAddress - base;
		if (headerOffset < 0 || payloadOffset < headerOffset) {
			continue;
		}

		const markerOffset = headerOffset + CHUNK_HEADER_SIZE;
		const markerLength = payloadOffset - markerOffset; // alignment padding + 0x0A marker
		const blockLength = payloadOffset + netLength - headerOffset;

		const blockUnit = `tag${c.tag}`;
		const fields: NvmFieldInfo[] = [
			// Chunk header: tag(2 LE) reserved(2) size(4 LE).
			{ name: `tag (${c.tag})`, kind: "tag", offset: headerOffset, length: 2, unit: blockUnit },
			{ name: "reserved", kind: "reserved", offset: headerOffset + 2, length: 2, unit: blockUnit },
			{ name: `size (${c.size} B)`, kind: "size", offset: headerOffset + 4, length: 4, unit: blockUnit },
		];
		if (markerLength > 0) {
			fields.push({ name: "Padding / marker", kind: "marker", offset: markerOffset, length: markerLength, unit: blockUnit });
		}
		if (netLength > 0) {
			fields.push({ name: "Payload", kind: "payload", offset: payloadOffset, length: netLength, unit: blockUnit });
		}

		blocks.push({
			id: `tag${c.tag}`,
			name: def?.name ?? `Tag ${c.tag}`,
			offset: headerOffset,
			length: blockLength,
			raw: {
				tag: c.tag,
				bank: c.bank,
				slotIndex: c.slotIndex,
				consistent: c.consistent,
				netLength,
				rawSize: c.size,
			},
			fields,
		});
	}

	blocks.sort((a, b) => a.offset - b.offset);
	return blocks;
}
