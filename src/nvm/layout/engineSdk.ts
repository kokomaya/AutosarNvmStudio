// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The stable SDK injected into external engine scripts.
 *
 * An engine script (see {@link ExternalEngineModule}) never bundles its own copy
 * of the NVM kernel; instead it receives this object and calls into the
 * authoritative, versioned shared code. Bumping the kernel in a
 * backwards-incompatible way should bump {@link ENGINE_SDK_VERSION} so engines
 * can guard on `sdk.version`.
 */

import {
    computeCrc,
    evaluateExpression,
    feeLcfgByTag,
    loadHexImage,
    parseFeeLcfg,
    parseVectorFeeV3,
    resolveFieldLink,
} from "../../../shared/nvm";
import {
    buildFeeV3Blocks,
} from "../feeV3Blocks";

/** Bumped whenever the injected SDK surface changes incompatibly. */
export const ENGINE_SDK_VERSION = 1;

/** The API surface handed to every external engine's `createEngine(sdk)`. */
export interface EngineSdk {
	/** SDK contract version; engines may guard on this. */
	readonly version: number;
	/** Decode an S-record / Intel HEX text into a sparse {@link MemoryImage}. */
	readonly loadHexImage: typeof loadHexImage;
	/** Walk a Vector MICROSAR FEE V3 link-table image. */
	readonly parseVectorFeeV3: typeof parseVectorFeeV3;
	/** Parse a `Fee_Lcfg.c` into block definitions. */
	readonly parseFeeLcfg: typeof parseFeeLcfg;
	/** Index Fee_Lcfg definitions by link-table tag. */
	readonly feeLcfgByTag: typeof feeLcfgByTag;
	/** Rocksoft-model CRC (all six presets). */
	readonly computeCrc: typeof computeCrc;
	/** The safe whitelist expression evaluator (no `eval`). */
	readonly evaluateExpression: typeof evaluateExpression;
	/** Decode + range-check an in-file address into an editor offset. */
	readonly resolveFieldLink: typeof resolveFieldLink;
	/** Convenience: the full built-in Vector FEE V3 → blocks pipeline. */
	readonly buildFeeV3Blocks: typeof buildFeeV3Blocks;
}

/** Assemble the injected SDK from the authoritative shared kernel. */
export function createEngineSdk(): EngineSdk {
	return {
		version: ENGINE_SDK_VERSION,
		loadHexImage,
		parseVectorFeeV3,
		parseFeeLcfg,
		feeLcfgByTag,
		computeCrc,
		evaluateExpression,
		resolveFieldLink,
		buildFeeV3Blocks,
	};
}
