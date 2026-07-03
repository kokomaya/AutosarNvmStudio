// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CrcModel } from "./crc";
import { Endianness } from "./model";

/**
 * Declarative description of how to turn a byte image into NVM blocks.
 *
 * M0 implements the linear ("none" container) path: profiles describe a
 * block header, a payload length and an optional CRC. Later milestones add
 * the L1 container layer, crypto (L4) and business mapping (L5). The types
 * here already reserve those sections so profiles remain forward-compatible.
 * See docs/design.md §6.
 */

export type FieldRole =
	| "blockId"
	| "payloadLength"
	| "address"
	| "crc"
	| "status"
	| "version"
	| "datasetIndex"
	| "instanceCount"
	| "validity";

export interface HeaderField {
	/** Field name, referenced by transforms / payload length expressions. */
	name: string;
	/** Byte offset of the field relative to the block start. */
	offset: number;
	/** Field size in bytes (1..4). */
	size: number;
	/** Overrides the profile-level endianness for this field. */
	endian?: Endianness;
	/** Semantic role, used by the engine to locate id / length / crc / etc. */
	role?: FieldRole;
	/**
	 * Optional whitelisted expression applied to the raw value. The raw value
	 * is available as `v`; other already-parsed fields are in scope by name.
	 */
	transform?: string;
}

export interface PayloadSpec {
	/** Where the payload begins. M0 supports "header" (after the header). */
	after: "header";
	/**
	 * Payload length: a fixed number, `$fieldName`, or a whitelisted
	 * expression referencing parsed header fields.
	 */
	length: number | string;
}

export interface MarkerSpec {
	/** Byte offset (relative to block start) at which to read the marker. */
	at: number;
	/** Marker size in bytes. */
	size: number;
	/** Matching value terminates iteration. */
	value: number;
	/** Endianness for reading the marker. */
	endian?: Endianness;
}

export type CrcStoredSource =
	| { source: "trailer"; size: number; endian?: Endianness }
	| { source: "field"; field: string };

export type CrcRange = "payload" | "header" | "header+payload";

export interface CrcSpec {
	/** Reference a built-in preset (see crcPresets). */
	preset?: string;
	/** Fully custom model (takes precedence over `preset`). */
	model?: CrcModel;
	/** Byte range the CRC is computed over. */
	range: CrcRange;
	/** Where the stored CRC lives. */
	stored: CrcStoredSource;
}

export interface BlockSpec {
	/**
	 * Iteration strategy. M0 supports:
	 * - "sequential": walk contiguous blocks starting at `start`.
	 * - "fixed-count": like sequential but stop after `count` blocks.
	 */
	iterate: "sequential" | "fixed-count";
	/** File offset at which parsing begins. Defaults to 0. */
	start?: number;
	/** Number of blocks to read for "fixed-count". */
	count?: number;
	/** Explicit header size. Defaults to the max (offset + size) of headers. */
	headerSize?: number;
	/** Header field definitions. */
	header: HeaderField[];
	/** Payload description. */
	payload: PayloadSpec;
	/** Optional end marker that terminates iteration when matched. */
	endMarker?: MarkerSpec;
	/** Byte alignment applied to each block's total size. Defaults to 1. */
	align?: number;
}

export interface NvmProfile {
	/** Stable identifier, e.g. `vendor.vector.fee.v2`. */
	id: string;
	/** Human readable name. */
	name?: string;
	/** Default byte order for multi-byte fields. Defaults to "little". */
	endian?: Endianness;
	/** L1 container layer. Reserved for M1; "none" (or omitted) => linear. */
	container?: { kind: "none" };
	block: BlockSpec;
	integrity?: { crc?: CrcSpec };
}

/**
 * Validate a parsed profile object and normalize defaults. Throws with a
 * descriptive message on the first problem found.
 */
export function validateProfile(input: unknown): NvmProfile {
	if (typeof input !== "object" || input === null) {
		throw new Error("Profile must be an object");
	}
	const p = input as Record<string, unknown>;
	if (typeof p.id !== "string" || p.id.length === 0) {
		throw new Error("Profile.id is required and must be a non-empty string");
	}
	if (p.endian !== undefined && p.endian !== "little" && p.endian !== "big") {
		throw new Error(`Profile.endian must be "little" or "big"`);
	}
	if (p.container !== undefined) {
		const kind = (p.container as { kind?: unknown }).kind;
		if (kind !== "none") {
			throw new Error(`Unsupported container.kind "${String(kind)}" (M0 supports "none")`);
		}
	}

	const block = p.block as Record<string, unknown> | undefined;
	if (!block || typeof block !== "object") {
		throw new Error("Profile.block is required");
	}
	if (block.iterate !== "sequential" && block.iterate !== "fixed-count") {
		throw new Error(`block.iterate must be "sequential" or "fixed-count" (M0)`);
	}
	if (block.iterate === "fixed-count" && typeof block.count !== "number") {
		throw new Error(`block.count is required when iterate is "fixed-count"`);
	}
	if (!Array.isArray(block.header) || block.header.length === 0) {
		throw new Error("block.header must be a non-empty array");
	}
	for (const field of block.header as HeaderField[]) {
		if (typeof field.name !== "string" || field.name.length === 0) {
			throw new Error("Each header field requires a non-empty name");
		}
		if (typeof field.offset !== "number" || field.offset < 0) {
			throw new Error(`Header field "${field.name}" requires a non-negative offset`);
		}
		if (typeof field.size !== "number" || field.size < 1 || field.size > 4) {
			throw new Error(`Header field "${field.name}" size must be between 1 and 4`);
		}
	}
	const payload = block.payload as PayloadSpec | undefined;
	if (!payload || payload.after !== "header" || payload.length === undefined) {
		throw new Error(`block.payload must be { after: "header", length: ... }`);
	}

	const crc = (p.integrity as { crc?: CrcSpec } | undefined)?.crc;
	if (crc) {
		if (!crc.preset && !crc.model) {
			throw new Error("integrity.crc requires either a preset or a model");
		}
		if (!crc.stored) {
			throw new Error("integrity.crc.stored is required");
		}
	}

	return input as NvmProfile;
}
