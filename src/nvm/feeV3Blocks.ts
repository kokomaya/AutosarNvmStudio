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
	FieldLinkSpec,
	feeLcfgByTag,
	loadHexImage,
	parseFeeLcfg,
	parseVectorFeeV3,
} from "../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../shared/protocol";

/** Size of the FEE V3 chunk header: tag(2) reserved(2) size(4). */
const CHUNK_HEADER_SIZE = 8;

/** One byte-range attribute of a region, relative to the region start. */
export interface FeeV3FieldTemplate {
	name: string;
	kind: string;
	offset: number;
	length: number;
	/** Explicit background color (any CSS color); overrides the palette. */
	color?: string;
	/**
	 * Marks this field as an in-file link. For a slot's `linkTarget` this makes
	 * the slot jump to the data chunk it points at. The chunk offset is already
	 * known from the link-table walk, so `encoding`/`transform` are optional.
	 */
	link?: FieldLinkSpec;
}

/**
 * The byte STRUCTURE of the fixed regions the Vector parser locates. This lives
 * in configuration, not code: the parser only *finds* the regions (the
 * link-table algorithm); how each region splits into named/colored fields comes
 * from here. Any part omitted falls back to {@link DEFAULT_FEE_V3_STRUCTURE}.
 */
export interface FeeV3StructureTemplate {
	/** Sector header (length = `alignment`). Offsets relative to sector start. */
	sectorHeader?: FeeV3FieldTemplate[];
	/** A used link-table slot (length = `alignment`). Offsets relative to slot. */
	slot?: FeeV3FieldTemplate[];
	/** An unused link-table slot. */
	slotEmpty?: FeeV3FieldTemplate[];
	/** A data-chunk header (length = 8). Offsets relative to the header. */
	chunkHeader?: FeeV3FieldTemplate[];
	/** Name/kind for the alignment padding + start marker (length is dynamic). */
	marker?: { name: string; kind: string; color?: string };
	/** Name/kind for the chunk payload (length is dynamic = net payload length). */
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
	/** Address alignment in bytes (MICROSAR RAD6xx default 8). */
	alignment?: number;
	/** Number of flash sectors that make up the FEE partition (default 2). */
	numberOfSectors?: number;
	/** Size of a single sector in bytes (default 0x30000). */
	sectorSize?: number;
	/** Field structure of each region (config-driven; defaults applied per part). */
	structure?: FeeV3StructureTemplate;
}

/** Instantiate template fields at `regionOffset`, tagged with `unit`. */
function applyTemplate(
	template: FeeV3FieldTemplate[],
	regionOffset: number,
	unit: string,
	prefix = "",
	link?: { targetOffset: number; label?: string },
): NvmFieldInfo[] {
	return template.map(t => ({
		name: prefix + t.name,
		kind: t.kind,
		offset: regionOffset + t.offset,
		length: t.length,
		color: t.color,
		unit,
		// A template field marked with `link` becomes a jump to the resolved
		// chunk. The link-table walk already found the chunk's editor offset,
		// so no re-decode is needed here.
		link: t.link && link ? { targetOffset: link.targetOffset, label: t.link.label ?? link.label } : undefined,
	}));
}

/**
 * Parse an S-record / Intel HEX image and return one {@link NvmBlockInfo} per
 * FEE V3 chunk. Offsets are expressed in the editor's byte space (i.e. relative
 * to the image base address, which maps to editor offset 0).
 *
 * Returns an empty array when the text is not a FEE V3 container.
 */
export function buildFeeV3Blocks(
	imageText: string,
	feeLcfgSource?: string,
	options: FeeV3BlockOptions = {},
): NvmBlockInfo[] {
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

	// The field breakdown of each region comes from config (defaults per part).
	const struct: Required<FeeV3StructureTemplate> = {
		...DEFAULT_FEE_V3_STRUCTURE,
		...(options.structure ?? {}),
	};

	const byTag = feeLcfgSource ? feeLcfgByTag(parseFeeLcfg(feeLcfgSource)) : undefined;
	const base = result.baseAddress;
	const blocks: NvmBlockInfo[] = [];

	// 1) Sector structure: header + the sector/link table (one slot per block
	// index). The parser locates these regions; `struct` describes their fields.
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
		const fields: NvmFieldInfo[] = applyTemplate(struct.sectorHeader, sectionOffset, headerUnit);
		for (let slot = 0; slot < section.ltSize; slot++) {
			const slotOffset = linkTableOffset + slot * alignment;
			const slotUnit = `sector${section.bank}:slot${slot}`;
			const c = bySlot.get(slot);
			if (c) {
				const def = byTag?.get(c.tag);
				const label = def?.name ?? `tag ${c.tag}`;
				// The slot's linkTarget points at this chunk; expose the resolved
				// editor offset so a linkTarget field can jump straight to it.
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

	// 2) Data blocks: the parser locates each chunk; `struct` describes the fields.
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
		const fields: NvmFieldInfo[] = applyTemplate(struct.chunkHeader, headerOffset, blockUnit);
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
