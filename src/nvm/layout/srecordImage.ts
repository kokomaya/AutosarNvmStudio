// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `image` capability adapter for address-based text containers (Motorola
 * S-record + Intel HEX). Wraps the generic `loadHexImage` loader. Additional
 * container formats (raw bin, ELF section, …) can register their own
 * {@link ImageProvider} without the core learning about them.
 */

import { ImageData, loadHexImage } from "../../../shared/nvm";
import { ImageProvider, RawDump } from "./context";

const HEX_EXTS = new Set([
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

export const srecordImageProvider: ImageProvider = {
	id: "srecord-intelhex-image",
	detect(dump: RawDump): boolean {
		if (HEX_EXTS.has(dump.ext)) {
			return true;
		}
		const head = dump.text.trimStart()[0];
		return head === "S" || head === ":";
	},
	provide(dump: RawDump): ImageData {
		const { baseAddress, bytes } = loadHexImage(dump.text).toFlat(0xff);
		return { baseAddress, bytes };
	},
};
