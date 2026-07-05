// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The stable, **vendor-neutral** SDK injected into external engine scripts.
 *
 * The extension core carries ZERO vendor/layout knowledge. Engines (including
 * the reference Vector FEE V3 pack under `engines/`) receive this object and
 * build their own layout on top of these generic byte/format primitives. No
 * vendor-specific function (Vector, EB, …) ever appears here.
 *
 * Bumping the kernel incompatibly bumps {@link ENGINE_SDK_VERSION} so engines
 * can guard on `sdk.version`.
 */

import {
	computeCrc,
	decodeLinkValue,
	decodeStruct,
	evaluateExpression,
	loadHexImage,
	parseBlkStruct,
	parseEcucModule,
	parseIntelHex,
	parseSRecord,
	parseXml,
	resolveCrcPreset,
	resolveFieldLink,
	structByteLength,
} from "../../../shared/nvm";

/** Bumped whenever the injected SDK surface changes incompatibly. */
export const ENGINE_SDK_VERSION = 2;

/** The generic API surface handed to every external engine's `createEngine(sdk)`. */
export interface EngineSdk {
	/** SDK contract version; engines may guard on this. */
	readonly version: number;

	// --- byte / container decoding ---
	/** Decode an S-record / Intel HEX text into a sparse image (auto-detect). */
	readonly loadHexImage: typeof loadHexImage;
	/** Decode a Motorola S-record text. */
	readonly parseSRecord: typeof parseSRecord;
	/** Decode an Intel HEX text. */
	readonly parseIntelHex: typeof parseIntelHex;

	// --- integrity ---
	/** Rocksoft-model CRC (all six presets). */
	readonly computeCrc: typeof computeCrc;
	/** Resolve a CRC preset by name. */
	readonly resolveCrcPreset: typeof resolveCrcPreset;

	// --- expressions & links ---
	/** The safe whitelist expression evaluator (no `eval`). */
	readonly evaluateExpression: typeof evaluateExpression;
	/** Decode + range-check an in-file address into an editor offset. */
	readonly resolveFieldLink: typeof resolveFieldLink;
	/** Decode a raw address value from bytes per an encoding. */
	readonly decodeLinkValue: typeof decodeLinkValue;

	// --- struct decoding ---
	/** Parse a `.blk` struct definition. */
	readonly parseBlkStruct: typeof parseBlkStruct;
	/** Decode bytes into physical field values per a struct definition. */
	readonly decodeStruct: typeof decodeStruct;
	/** Byte length of a struct definition. */
	readonly structByteLength: typeof structByteLength;

	// --- generic AUTOSAR config (no vendor semantics) ---
	/** Dependency-free XML parser. */
	readonly parseXml: typeof parseXml;
	/** Read a generic ECUC module from ARXML. */
	readonly parseEcucModule: typeof parseEcucModule;
}

/** Assemble the injected SDK from the authoritative, vendor-neutral kernel. */
export function createEngineSdk(): EngineSdk {
	return {
		version: ENGINE_SDK_VERSION,
		loadHexImage,
		parseSRecord,
		parseIntelHex,
		computeCrc,
		resolveCrcPreset,
		evaluateExpression,
		resolveFieldLink,
		decodeLinkValue,
		parseBlkStruct,
		decodeStruct,
		structByteLength,
		parseXml,
		parseEcucModule,
	};
}

