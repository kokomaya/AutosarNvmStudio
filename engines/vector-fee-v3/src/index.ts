// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vector MICROSAR FEE V3 layout engine — runtime-loaded pack.
 *
 * This is a fully self-contained engine: it imports nothing from the extension
 * and receives only the injected {@link EngineSdk}. Reference a built copy from
 * a `*.nvmlayout.json` via `engineScript` (workspace-local) or install it as a
 * pack and reference it by `engine: "vector-fee-v3"`.
 */

import { buildFeeV3Blocks, FeeV3BlockOptions } from "./feeV3Blocks";
import { Engine, EngineSdk, LayoutInput } from "./types";

export function createEngine(sdk: EngineSdk): Engine {
	return {
		id: "vector-fee-v3",
		parse(input: LayoutInput, options?: Record<string, unknown>) {
			// `input.sources` is keyed by the logical names the descriptor declared
			// (e.g. { "feeLcfg": "Fee_Lcfg.c" }).
			const feeLcfg = input.sources.feeLcfg || input.sources["fee_lcfg.c"];
			return buildFeeV3Blocks(
				sdk,
				input.text,
				feeLcfg,
				(options as FeeV3BlockOptions) || {},
				input.sources,
			);
		},
	};
}
