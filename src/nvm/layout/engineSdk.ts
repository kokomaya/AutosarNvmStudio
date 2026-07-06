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
	arxmlStructs,
	compileBlkToRich,
	computeCrc,
	decodeLinkValue,
	decodeStruct,
	decodeStructRich,
	evaluateExpression,
	loadHexImage,
	mergeCatalogs,
	parseBlkStruct,
	parseCStructs,
	parseCStructsEx,
	parseEcucModule,
	parseIntelHex,
	parseSRecord,
	parseStructCatalog,
	parseXml,
	resolveCrcPreset,
	resolveFieldLink,
	structByteLength,
} from "../../../shared/nvm";

/**
 * Bumped whenever the injected SDK surface changes incompatibly.
 *
 * v3 adds the rich business-struct decoding surface (`decodeStructRich` and the
 * three struct-source parsers). It is a pure superset of v2, so v2 engines keep
 * working unchanged; v3 engines guard on `sdk.version >= 3` before using the new
 * members.
 */
export const ENGINE_SDK_VERSION = 3;

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

	// --- struct decoding (legacy flat `.blk`) ---
	/** Parse a `.blk` struct definition. */
	readonly parseBlkStruct: typeof parseBlkStruct;
	/** Decode bytes into physical field values per a struct definition. */
	readonly decodeStruct: typeof decodeStruct;
	/** Byte length of a struct definition. */
	readonly structByteLength: typeof structByteLength;

	// --- rich business-struct decoding (SDK v3+) ---
	/**
	 * Decode payload bytes into a TREE of named typed values (arrays, nested
	 * structs, bitfields, enums, scaling). Absolute node offsets. Never throws.
	 */
	readonly decodeStructRich: typeof decodeStructRich;
	/** Compile a legacy flat `.blk` StructDef into the rich model. */
	readonly compileBlkToRich: typeof compileBlkToRich;
	/** Coerce untrusted JSON into a rich struct + enum catalog. */
	readonly parseStructCatalog: typeof parseStructCatalog;
	/** Merge catalogs (later arguments win on key conflicts). */
	readonly mergeCatalogs: typeof mergeCatalogs;
	/** Parse generated C source headers into a struct + enum catalog. */
	readonly parseCStructs: typeof parseCStructs;
	/** Parse C source with diagnostics for unresolved macros / types. */
	readonly parseCStructsEx: typeof parseCStructsEx;
	/** Parse ARXML type definitions into a struct + enum catalog. */
	readonly arxmlStructs: typeof arxmlStructs;

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
		decodeStructRich,
		compileBlkToRich,
		parseStructCatalog,
		mergeCatalogs,
		parseCStructs,
		parseCStructsEx,
		arxmlStructs,
		parseXml,
		parseEcucModule,
	};
}

