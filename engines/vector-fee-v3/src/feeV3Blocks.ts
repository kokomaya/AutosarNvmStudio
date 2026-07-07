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
import {
	buildStructResolver,
	decodeBoundBlock,
	FeeV3StructOptions,
	matchBinding,
} from "./feeV3Structs";
import { nvmCfgByName, parseNvmCfg } from "./nvmCfg";
import { EngineSdk, NvmBlock, NvmField } from "./types";
import { FeeV3Chunk, parseVectorFeeV3 } from "./vectorFeeV3";

/** Size of the FEE V3 chunk header: tag(2) datasetIdx(1) mgmtType(1) pld(2) aln(2). */
const CHUNK_HEADER_SIZE = 8;

/**
 * Stride used to fold (sector, slot) into a single best-effort write sequence.
 * Larger than any realistic link-table slot count so sectors never interleave.
 */
const SECTOR_SEQ_STRIDE = 1_000_000;

/** Human-readable name for a chunk management-type byte. */
function mgmtLabel(mgmtType: number): string {
	switch (mgmtType) {
		case 0x01:
			return "NATIVE";
		case 0x10:
			return "DATASET";
		default:
			return `0x${mgmtType.toString(16).toUpperCase().padStart(2, "0")}`;
	}
}

/** Two-digit upper-case hex for a small unsigned value. */
function hex(value: number, pad = 2): string {
	return `0x${value.toString(16).toUpperCase().padStart(pad, "0")}`;
}

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
	/**
	 * Integrity-check bytes (CMAC / CRC) that follow the business data. Sized from
	 * `NvM_Cfg.c` `NvMacSize` when available, else the whole post-data remainder.
	 */
	payloadExtra?: { name: string; kind: string; color?: string };
	/** Alignment padding after data + integrity, up to the stored payload size. */
	payloadPadding?: { name: string; kind: string; color?: string };
	/** Fixed 8-byte trailer written by Fee_InternalFillInstanceBufferTrailerPage. */
	chunkTrailer?: { name: string; kind: string; color?: string };
	/** The next-chunk link at the tail; the link-table slot points here. */
	nextLink?: { name: string; kind: string; color?: string };
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
		{ name: "block tag", kind: "tag", offset: 0, length: 2 },
		{ name: "dataset idx", kind: "datasetIdx", offset: 2, length: 1 },
		{ name: "mgmt type", kind: "mgmtType", offset: 3, length: 1 },
		{ name: "payload length", kind: "payloadLen", offset: 4, length: 2 },
		{ name: "align", kind: "align", offset: 6, length: 2 },
	],
	marker: { name: "Padding / start marker", kind: "marker" },
	payload: { name: "Payload", kind: "payload" },
	payloadExtra: { name: "MAC / CRC", kind: "mac" },
	payloadPadding: { name: "padding", kind: "padding" },
	chunkTrailer: { name: "chunk trailer", kind: "chunkTrailer" },
	nextLink: { name: "next chunk link", kind: "nextLink" },
};

/** Tunable Vector FEE V3 container parameters (from a `*.nvmlayout.json`). */
export interface FeeV3BlockOptions extends FeeV3StructOptions {
	alignment?: number;
	numberOfSectors?: number;
	sectorSize?: number;
	structure?: FeeV3StructureTemplate;
	/**
	 * Include historical (superseded) chunks left by append-only writes, each
	 * flagged `stale`. Defaults to `true`. Set `false` to emit only the current
	 * versions the link table references.
	 */
	includeStaleChunks?: boolean;
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

/** Build a single colored region (name + kind) at an absolute editor offset. */
function regionField(
	region: { name: string; kind: string; color?: string },
	offset: number,
	length: number,
	unit: string,
): NvmField {
	return { name: region.name, kind: region.kind, offset, length, color: region.color, unit };
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
	sources: Record<string, string> = {},
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
			includeStaleChunks: options.includeStaleChunks,
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
	// Authoritative business-data / integrity sizing (NvMNvBlockLength, NvMacSize)
	// keyed by block name. Optional: absent when the descriptor declares no
	// `nvmCfg` source, in which case the FEE payload length is used as before.
	const nvmSource = sources.nvmCfg || sources["nvm_cfg.c"];
	const byName = nvmSource ? nvmCfgByName(parseNvmCfg(nvmSource)) : undefined;
	const base = result.baseAddress;
	const blocks: NvmBlock[] = [];

	// Optional business-struct decoding: build the catalog + bindings from the
	// declared struct sources. `undefined` when not configured or SDK < v3.
	const structResolver = buildStructResolver(sdk, sources, options);

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
			group: { key: `sector${section.bank}`, label: `Sector ${section.bank}`, order: section.bank },
			attributes: [
				{ key: "kind", label: "Kind", value: "sector table", kind: "kind" },
				{ key: "sector", label: "Sector", value: section.bank, kind: "sector" },
				{ key: "usedSlots", label: "Used slots", value: section.usedSlots },
				{ key: "ltSize", label: "Slots", value: section.ltSize },
				{ key: "chunks", label: "Chunks", value: section.chunks.length },
			],
			fields,
		});
	}

	// 2) Data blocks: one per chunk.
	for (const c of result.chunks) {
		const def = byTag?.get(c.tag);
		const blockName = def?.name ?? `Tag ${c.tag}`;
		const rawSize = c.size; // full stored payload (link-table payloadSize)

		// Split the stored payload into business data / integrity (CMAC) / padding.
		// NvM_Cfg.c is authoritative: stored = NvMNvBlockLength + NvMacSize + padding.
		// Without it, fall back to the FEE payload length as the business length and
		// treat the remainder as one integrity/padding region (legacy behaviour).
		const meta = byName?.get(blockName);
		const dataLength = Math.min(meta?.nvBlockLength ?? def?.payloadLength ?? rawSize, rawSize);
		const macLength = meta ? Math.min(meta.macSize, Math.max(0, rawSize - dataLength)) : 0;
		const paddingLength = Math.max(0, rawSize - dataLength - macLength);

		const headerOffset = c.headerAddress - base;
		const payloadOffset = c.payloadAddress - base;
		if (headerOffset < 0 || payloadOffset < headerOffset) {
			continue;
		}

		const markerOffset = headerOffset + CHUNK_HEADER_SIZE;
		const markerLength = payloadOffset - markerOffset;

		// The link-table slot points at the chunk TAIL (the next-chunk link field).
		// Between the stored payload and that link sits the fixed chunk trailer.
		const trailerStart = payloadOffset + rawSize;
		const nextLinkOffset = c.linkTargetAddress - base;
		const nextLinkLength = 8;
		const hasTail = nextLinkOffset >= trailerStart;
		const trailerLength = hasTail ? nextLinkOffset - trailerStart : 0;
		const blockEnd = hasTail ? nextLinkOffset + nextLinkLength : trailerStart;
		const blockLength = blockEnd - headerOffset;

		// Unique per-instance id/unit so every copy of the same block (versions in
		// the same sector, or one per sector) is independently selectable/colorable.
		// Historical chunks share slotIndex -1, so key on the header offset, which
		// is globally unique. The shared logical identity (below) still groups them
		// in the "by block id" view.
		const blockUnit = `tag${c.tag}.s${c.bank}.@${headerOffset.toString(16)}`;
		const fields: NvmField[] = applyTemplate(struct.chunkHeader, headerOffset, blockUnit);
		if (markerLength > 0) {
			fields.push(regionField(struct.marker, markerOffset, markerLength, blockUnit));
		}
		if (dataLength > 0) {
			fields.push(regionField(struct.payload, payloadOffset, dataLength, blockUnit));
		}
		if (meta) {
			// Known split: business data, then CMAC/CRC, then alignment padding.
			if (macLength > 0) {
				fields.push(
					regionField(struct.payloadExtra, payloadOffset + dataLength, macLength, blockUnit),
				);
			}
			if (paddingLength > 0) {
				fields.push(
					regionField(
						struct.payloadPadding,
						payloadOffset + dataLength + macLength,
						paddingLength,
						blockUnit,
					),
				);
			}
		} else if (paddingLength > 0) {
			// Unknown split: one integrity/padding region after the data.
			fields.push(
				regionField(struct.payloadExtra, payloadOffset + dataLength, paddingLength, blockUnit),
			);
		}
		if (trailerLength > 0) {
			fields.push(regionField(struct.chunkTrailer, trailerStart, trailerLength, blockUnit));
		}
		if (hasTail) {
			const nextLinkField = regionField(struct.nextLink, nextLinkOffset, nextLinkLength, blockUnit);
			// The next-chunk link stores the address of this block's PREVIOUS
			// version's tail; expose it as an in-file jump when it resolves.
			if (c.nextLinkTargetOffset !== undefined) {
				nextLinkField.link = {
					targetOffset: c.nextLinkTargetOffset,
					label: `${def?.name ?? `Tag ${c.tag}`} (previous version)`,
				};
			}
			fields.push(nextLinkField);
		}

		// Business-struct decode: if this block is bound to a struct AND has net
		// business payload, decode it into a value tree the inspector renders.
		let decoded;
		if (structResolver && dataLength > 0 && (structResolver.decodeStale || !c.stale)) {
			const binding = matchBinding(structResolver, {
				name: blockName,
				tag: c.tag,
				identityKey: `tag:0x${c.tag.toString(16)}`,
			});
			if (binding) {
				// The business slice is the first `dataLength` bytes of the stored
				// payload (data only — never the trailing CMAC/CRC or padding).
				const businessBytes = c.data.subarray(0, dataLength);
				decoded = decodeBoundBlock(structResolver, binding, businessBytes, payloadOffset);
			}
		}

		blocks.push({
			id: blockUnit,
			name: blockName,
			offset: headerOffset,
			length: blockLength,
			raw: {
				tag: c.tag,
				bank: c.bank,
				slotIndex: c.slotIndex,
				consistent: c.consistent,
				datasetIndex: c.datasetIndex,
				mgmtType: c.mgmtType,
				netLength: dataLength,
				macLength,
				rawSize,
				stale: c.stale,
			},
			// Vendor-neutral projection for the editor's Blocks views. `sequence`
			// is BEST-EFFORT: FEE stores no monotonic write counter, so we order by
			// sector then physical header offset — Vector writes a sector top-down,
			// so the highest-offset chunk in a sector is the most recently written.
			group: { key: `sector${c.bank}`, label: `Sector ${c.bank}`, order: c.bank },
			sequence: c.bank * SECTOR_SEQ_STRIDE + headerOffset,
			identity: { key: `tag:0x${c.tag.toString(16)}`, label: def?.name ?? `Tag ${c.tag}` },
			attributes: [
				{ key: "id", label: "ID", value: hex(c.tag, 4), kind: "id" },
				{ key: "state", label: "State", value: c.stale ? "stale" : "latest", kind: "state" },
				{ key: "sector", label: "Sector", value: c.bank, kind: "sector" },
				{ key: "slot", label: "Slot", value: c.slotIndex < 0 ? "-" : c.slotIndex },
				{ key: "mgmt", label: "Mgmt", value: mgmtLabel(c.mgmtType), kind: "mgmt" },
				{ key: "dataset", label: "Dataset", value: c.datasetIndex },
				{ key: "size", label: "Size", value: rawSize },
				{ key: "payload", label: "Payload", value: dataLength },
				...(macLength > 0
					? [{ key: "mac", label: "MAC / CRC", value: macLength, kind: "mac" }]
					: []),
			],
			fields,
			decoded,
		});
	}

	// Flag the current version of each logical block. The active sector's link
	// table is authoritative: a non-stale chunk IS the current version. Historical
	// (stale) chunks never win, even if physically later, so fall back to the
	// highest write sequence only among non-stale instances.
	const latestByIdentity = new Map<string, NvmBlock>();
	for (const b of blocks) {
		if (!b.identity || typeof b.sequence !== "number") {
			continue;
		}
		if ((b.raw as { stale?: boolean })?.stale) {
			continue; // stale copies are never the latest
		}
		const best = latestByIdentity.get(b.identity.key);
		if (!best || (best.sequence ?? -Infinity) < b.sequence) {
			latestByIdentity.set(b.identity.key, b);
		}
	}
	for (const b of latestByIdentity.values()) {
		b.isLatest = true;
	}

	blocks.sort((a, b) => a.offset - b.offset);
	return blocks;
}
