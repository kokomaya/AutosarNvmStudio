// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vector MICROSAR FEE "V3" container parser (link-table driven).
 *
 * This is a faithful port of `SectionV3` / `ChunkLinkV3` / `FeeBlockV3` from the
 * reference C# NvmAnalyzer. It recovers each logical NVM block by walking the
 * per-sector link table that MICROSAR FEE maintains at the start of the active
 * sector.
 *
 * Layout (all multi-byte fields little-endian, alignment `al`, default 8):
 *   sector header: id(1) blkHi(1) blkLo(1)  → ltSize = (blkHi<<4)|blkLo
 *   link table   : starts at relSectorStart + al, `ltSize` slots of `al` bytes:
 *                    linkTarget(4) payloadSize(2) pad(al-6)
 *                  a slot of 0xFFFFFFFF is an unused block index.
 *   chunk        : located by working backwards from `linkTarget`:
 *                    ... [header: tag(2) _(2) size(4)] [pad] 0x0A <payload> 0x0A [link]
 *
 * The chunk `tag` equals the FEE link-table index and is resolved to a business
 * block name via `Fee_Lcfg.c` (see feeLcfg.ts).
 *
 * See docs/design.md [TODO-Vector].
 */

import { MemoryImage } from "../memoryImage";

export interface FeeV3Options {
	/** Address alignment in bytes. MICROSAR RAD6xx FEE uses 8. */
	alignment?: number;
	/** Number of flash sectors that make up the FEE partition. */
	numberOfSectors?: number;
	/** Size of a single sector in bytes. */
	sectorSize?: number;
}

export interface FeeV3Chunk {
	/** FEE link-table index read from the chunk header (business key). */
	tag: number;
	/** Link-table slot the chunk was reached through (should equal `tag`). */
	slotIndex: number;
	/** Sector (bank) the chunk lives in. */
	bank: number;
	/** Absolute address of the chunk header (tag field). */
	headerAddress: number;
	/** Absolute address of the first payload byte (after the 0x0A marker). */
	payloadAddress: number;
	/** Absolute address of the link field this chunk was reached through. */
	linkTargetAddress: number;
	/** Raw chunk size taken from the header (aligned payload span). */
	size: number;
	/** Raw payload bytes, `size` long (before truncation to the net length). */
	data: Uint8Array;
	/** True when `slotIndex === tag`. */
	consistent: boolean;
}

export interface FeeV3Section {
	bank: number;
	id: number;
	ltSize: number;
	linkTableAddress: number;
	/** Number of non-empty slots in the link table. */
	usedSlots: number;
	chunks: FeeV3Chunk[];
}

export interface FeeV3Result {
	baseAddress: number;
	alignment: number;
	/** Chip base address (with bank prefix) that maps to flat index 0. */
	chipBase: number;
	sections: FeeV3Section[];
	/** All decoded chunks across all active sectors. */
	chunks: FeeV3Chunk[];
}

const EMPTY32 = 0xffffffff;
const MARKER = 0x0a;

function readU16LE(buf: Uint8Array, i: number): number {
	return buf[i] | (buf[i + 1] << 8);
}

function readU32LE(buf: Uint8Array, i: number): number {
	return (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0;
}

/**
 * Parse a Vector FEE V3 image and return every logical block chunk found in the
 * active sector(s).
 */
export function parseVectorFeeV3(image: MemoryImage, opts: FeeV3Options = {}): FeeV3Result {
	const al = opts.alignment ?? 8;
	const nrs = opts.numberOfSectors ?? 2;
	const ssz = opts.sectorSize ?? 0x30000;

	const { baseAddress, bytes } = image.toFlat(0xff);

	// Determine the chip base (link-table addresses carry a bank prefix such as
	// 0x01000000). We derive it from the first valid link target so file offsets
	// resolve regardless of the configured bank.
	let chipBase = baseAddress;
	outer: for (let b = 0; b < nrs; b++) {
		const rel = b === 0 ? 0 : b * ssz;
		const ltSize = ((bytes[rel + 1] << 4) | bytes[rel + 2]) & 0xffff;
		if (bytes[rel] === 0xff || ltSize === 0) {
			continue;
		}
		const ltStart = rel + al;
		for (let i = 0; i < ltSize; i++) {
			const tgt = readU32LE(bytes, ltStart + i * al);
			if (tgt !== EMPTY32) {
				chipBase = ((tgt & 0xff000000) >>> 0) | (baseAddress & 0x00ffffff);
				break outer;
			}
		}
	}

	const toFlat = (chipAddr: number): number => (chipAddr - chipBase) | 0;

	const sections: FeeV3Section[] = [];
	const allChunks: FeeV3Chunk[] = [];

	for (let b = 0; b < nrs; b++) {
		const rel = b === 0 ? 0 : b * ssz;
		if (rel + 3 > bytes.length) {
			continue;
		}
		const id = bytes[rel];
		const ltSize = ((bytes[rel + 1] << 4) | bytes[rel + 2]) & 0xffff;
		// An erased/spare sector has an all-0xFF header.
		if (id === 0xff || ltSize === 0 || ltSize > 0x1000) {
			continue;
		}

		const ltStart = rel + al;
		const chunks: FeeV3Chunk[] = [];
		let usedSlots = 0;

		for (let slot = 0; slot < ltSize; slot++) {
			const entry = ltStart + slot * al;
			if (entry + 6 > bytes.length) {
				break;
			}
			const linkTarget = readU32LE(bytes, entry);
			if (linkTarget === EMPTY32) {
				continue;
			}
			const pldSz = readU16LE(bytes, entry + 4);
			usedSlots++;

			const chunk = decodeChunk(bytes, toFlat, linkTarget, pldSz, al, baseAddress, b, slot);
			if (chunk) {
				chunks.push(chunk);
				allChunks.push(chunk);
			}
		}

		sections.push({
			bank: b,
			id,
			ltSize,
			linkTableAddress: baseAddress + ltStart,
			usedSlots,
			chunks,
		});
	}

	return { baseAddress, alignment: al, chipBase, sections, chunks: allChunks };
}

/**
 * Locate and decode a single chunk given a link-table entry. Mirrors
 * `SectionV3.GetBlocks` + `FeeBlockV3.Parse`.
 */
function decodeChunk(
	bytes: Uint8Array,
	toFlat: (chipAddr: number) => number,
	linkTarget: number,
	pldSz: number,
	al: number,
	baseAddress: number,
	bank: number,
	slot: number,
): FeeV3Chunk | undefined {
	let la = toFlat(linkTarget);
	if (la < al || la >= bytes.length) {
		return undefined;
	}

	// End marker sits one alignment unit below the link field.
	la -= al;
	if (bytes[la] !== MARKER) {
		return undefined;
	}

	// Start marker precedes the payload by `pldSz + 1`.
	la -= pldSz + 1;
	if (la < 0 || bytes[la] !== MARKER) {
		return undefined;
	}

	// Back up to the chunk header.
	la -= al;
	la -= al === 8 ? 8 : 0;
	if (la < 0) {
		return undefined;
	}

	// FeeBlockV3.Parse
	let idx = la;
	const tag = readU16LE(bytes, idx);
	if (tag === 0xffff) {
		return undefined;
	}
	idx += 2;
	idx += 2; // reserved / instance nibble
	const size = readU32LE(bytes, idx);
	if (size === 0xffff) {
		return undefined;
	}
	idx += 4;

	const rst = idx % al;
	idx += al - rst;

	if (bytes[idx] !== MARKER && !isInval(bytes, idx)) {
		return undefined;
	}
	idx += 1; // consume marker
	const payloadStart = idx;
	const end = Math.min(payloadStart + size, bytes.length);
	const data = bytes.subarray(payloadStart, end);

	return {
		tag,
		slotIndex: slot,
		bank,
		headerAddress: baseAddress + la,
		payloadAddress: baseAddress + payloadStart,
		linkTargetAddress: baseAddress + toFlat(linkTarget),
		size,
		data,
		consistent: tag === slot,
	};
}

/** Matches the FEE "invalidated" pattern 05 05 05 05. */
function isInval(bytes: Uint8Array, i: number): boolean {
	return bytes[i] === 0x05 && bytes[i + 1] === 0x05 && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x05;
}
