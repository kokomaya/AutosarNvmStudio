// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vector MICROSAR FEE "V3" (link-table) layout *engine*.
 *
 * This is **not** an auto-applied built-in format: it only runs when a
 * `*.nvmlayout.json` explicitly selects it with `"provider": "vector-fee-v3"`.
 * Container parameters (alignment / sector size / sector count) are taken from
 * that descriptor's `options` (falling back to MICROSAR RAD6xx defaults).
 */

import { buildFeeV3Blocks, FeeV3BlockOptions, FeeV3StructureTemplate } from "../feeV3Blocks";
import { applyPalette, LayoutConfig, LayoutInput, matchesConfig, NvmLayoutProvider } from "./provider";

export const VECTOR_FEE_V3_ID = "vector-fee-v3";

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/** The matching descriptor that selects this engine, if any. */
function selectingConfig(input: LayoutInput): LayoutConfig | undefined {
	return input.configs.find(c => c.provider === VECTOR_FEE_V3_ID && matchesConfig(c, input));
}

/** Extract container params + field structure from the selecting descriptor. */
function optionsFor(config: LayoutConfig | undefined): FeeV3BlockOptions {
	const opts = config?.options ?? {};
	const structure = opts.structure as FeeV3StructureTemplate | undefined;
	return {
		alignment: asNumber(opts.alignment),
		numberOfSectors: asNumber(opts.numberOfSectors),
		sectorSize: asNumber(opts.sectorSize),
		structure: structure && typeof structure === "object" ? structure : undefined,
	};
}

export const vectorFeeV3Provider: NvmLayoutProvider = {
	id: VECTOR_FEE_V3_ID,
	label: "Vector MICROSAR FEE V3 (link table)",
	// Only runs when a config opts in — never auto-applied to a bare file.
	detect(input: LayoutInput): boolean {
		return selectingConfig(input) !== undefined;
	},
	parse(input: LayoutInput) {
		const config = selectingConfig(input);
		// The Fee_Lcfg.c content is resolved by the core from the descriptor's
		// declared sources (e.g. { "feeLcfg": "Fee_Lcfg.c" }); no core knows Vector.
		const feeLcfg = input.sources.feeLcfg ?? input.sources["fee_lcfg.c"];
		const blocks = buildFeeV3Blocks(input.text, feeLcfg, optionsFor(config));
		applyPalette(blocks, config?.palette);
		return blocks;
	},
};
