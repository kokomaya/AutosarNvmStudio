// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Build editor-space NVM block descriptors (with colored sub-fields) from a
 * Vector FEE V3 image. Bridges {@link parseVectorFeeV3} to the block shape the
 * editor renders.
 *
 * Generic byte decoding (`loadHexImage`) comes from the injected SDK — this
 * pack bundles only Vector-specific logic.
 */

import { feeLcfgByTag, parseFeeLcfg } from "./feeLcfg";
import { EngineSdk, NvmBlock, NvmField } from "./types";
import { FeeV3Chunk, parseVectorFeeV3 } from "./vectorFeeV3";

/** Size of the FEE V3 chunk header: tag(2) reserved(2) size(4). */
const CHUNK_HEADER_SIZE = 8;

/** One byte-range attribute of a region, relative to the region start. */
export interface FeeV3FieldTemplate {
	name: string;
	kind: string;
	offset: number;
	length: number;
	color?: string;
	/** Marks a linkTarget field so the slot jumps to its data chunk. */
	link?: { encoding?: string; label?: string };
}

/** The byte STRUCTURE of the fixed regions the parser locates (config-driven). */
export interface FeeV3StructureTemplate {
	sectorHeader?: FeeV3FieldTemplate[];
	slot?: FeeV3FieldTemplate[];
	slotEmpty?: FeeV3FieldTemplate[];
	chunkHeader?: FeeV3FieldTemplate[];
	marker?: { name: string; kind: string; color?: string };
	payload?: { name: string; kind: string; color?: string };
}

/** The default field structure (used when the descriptor omits a part). */
export const DEFAULT_FEE_V3_STRUCTURE: Required<FeeV3StructureTemplate> = {
	sectorHeader: [
		{ name: "Counter / id", kind: "counter", offset: 0, length: 1 },
		{ name: "ltSize", kind: "ltSize", offset: 1, length: 2 },
		{ name: "Header status / complement", kind: "status", offset: 3, length: 5 },
	],
	slot: [
		{ name: "linkTarget", kind: "linkTarget", offset: 0, length: 4, link: { encoding: "u32le" } },
		{ name: "payloadSize", kind: "payloadSize", offset: 4, length: 2 },
		{ name: "pad", kind: "pad", offset: 6, length: 2 },
	],
	slotEmpty: [{ name: "unused slot", kind: "linkEmpty", offset: 0, length: 8 }],
	chunkHeader: [
		{ name: "tag", kind: "tag", offset: 0, length: 2 },
		{ name: "reserved", kind: "reserved", offset: 2, length: 2 },
		{ name: "size", kind: "size", offset: 4, length: 4 },
	],
	marker: { name: "Padding / marker", kind: "marker" },
	payload: { name: "Payload", kind: "payload" },
};

/** Tunable Vector FEE V3 container parameters (from a `*.nvmlayout.json`). */
export interface FeeV3BlockOptions {
	alignment?: number;
	numberOfSectors?: number;
	sectorSize?: number;
	structure?: FeeV3StructureTemplate;
}

/** Instantiate template fields at `regionOffset`, tagged with `unit`. */
function applyTemplate(
	template: FeeV3FieldTemplate[],
	regionOffset: number,
	unit: string,
	prefix = "",
	link?: { targetOffset: number; label?: string },
): NvmField[] {
	return template.map(t => ({
		name: prefix + t.name,
		kind: t.kind,
		offset: regionOffset + t.offset,
		length: t.length,
		color: t.color,
		unit,
		link: t.link && link ? { targetOffset: link.targetOffset, label: t.link.label ?? link.label } : undefined,
	}));
}

/**
 * Parse an S-record / Intel HEX image and return one {@link NvmBlock} per FEE V3
 * chunk (plus the sector tables). Offsets are editor byte offsets (image base
 * maps to editor offset 0). Returns `[]` when the text is not a FEE V3 image.
 */
export function buildFeeV3Blocks(
	sdk: EngineSdk,
	imageText: string,
	feeLcfgSource?: string,
	options: FeeV3BlockOptions = {},
): NvmBlock[] {
	let image;
	try {
		image = sdk.loadHexImage(imageText);
	} catch {
		return [];
	}
	if (image.span === 0) {
		return [];
	}

	let result;
	try {
		result = parseVectorFeeV3(image, {
			alignment: options.alignment,
			numberOfSectors: options.numberOfSectors,
			sectorSize: options.sectorSize,
		});
	} catch {
		return [];
	}
	if (result.chunks.length === 0) {
		return [];
	}

	const struct: Required<FeeV3StructureTemplate> = {
		...DEFAULT_FEE_V3_STRUCTURE,
		...(options.structure ?? {}),
	};

	const byTag = feeLcfgSource ? feeLcfgByTag(parseFeeLcfg(feeLcfgSource)) : undefined;
	const base = result.baseAddress;
	const blocks: NvmBlock[] = [];

	// 1) Sector structure: header + link table (one slot per block index).
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
		const fields: NvmField[] = applyTemplate(struct.sectorHeader, sectionOffset, headerUnit);
		for (let slot = 0; slot < section.ltSize; slot++) {
			const slotOffset = linkTableOffset + slot * alignment;
			const slotUnit = `sector${section.bank}:slot${slot}`;
			const c = bySlot.get(slot);
			if (c) {
				const def = byTag?.get(c.tag);
				const label = def?.name ?? `tag ${c.tag}`;
				const chunkHeaderOffset = c.headerAddress - base;
				const link =
					chunkHeaderOffset >= 0 ? { targetOffset: chunkHeaderOffset, label } : undefined;
				fields.push(
					...applyTemplate(struct.slot, slotOffset, slotUnit, `Slot ${slot} → ${label}: `, link),
				);
			} else {
				fields.push(...applyTemplate(struct.slotEmpty, slotOffset, slotUnit, `Slot ${slot}: `));
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

	// 2) Data blocks: one per chunk.
	for (const c of result.chunks) {
		const def = byTag?.get(c.tag);
		const netLength = def?.payloadLength ?? c.size;

		const headerOffset = c.headerAddress - base;
		const payloadOffset = c.payloadAddress - base;
		if (headerOffset < 0 || payloadOffset < headerOffset) {
			continue;
		}

		const markerOffset = headerOffset + CHUNK_HEADER_SIZE;
		const markerLength = payloadOffset - markerOffset;
		const blockLength = payloadOffset + netLength - headerOffset;

		const blockUnit = `tag${c.tag}`;
		const fields: NvmField[] = applyTemplate(struct.chunkHeader, headerOffset, blockUnit);
		if (markerLength > 0) {
			fields.push({
				name: struct.marker.name,
				kind: struct.marker.kind,
				offset: markerOffset,
				length: markerLength,
				color: struct.marker.color,
				unit: blockUnit,
			});
		}
		if (netLength > 0) {
			fields.push({
				name: struct.payload.name,
				kind: struct.payload.kind,
				offset: payloadOffset,
				length: netLength,
				color: struct.payload.color,
				unit: blockUnit,
			});
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
