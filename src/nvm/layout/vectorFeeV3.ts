// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vector MICROSAR FEE "V3" (link-table) layout provider. Wraps the verified
 * {@link buildFeeV3Blocks} parser behind the vendor-neutral provider interface.
 */

import { buildFeeV3Blocks } from "../feeV3Blocks";
import { LayoutInput, NvmLayoutProvider } from "./provider";

const HEX_TEXT_EXTS = new Set([
	".mot",
	".srec",
	".s19",
	".s28",
	".s37",
	".s1",
	".s2",
	".s3",
	".hex",
	".ihex",
	".ihx",
]);

export const vectorFeeV3Provider: NvmLayoutProvider = {
	id: "vector-fee-v3",
	label: "Vector MICROSAR FEE V3 (link table)",
	detect(input: LayoutInput): boolean {
		return HEX_TEXT_EXTS.has(input.ext);
	},
	parse(input: LayoutInput) {
		return buildFeeV3Blocks(input.text, input.feeLcfgSource);
	},
};
