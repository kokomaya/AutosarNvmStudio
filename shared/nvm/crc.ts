// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Fully parameterized CRC implementation (Rocksoft model) plus a table of
 * presets covering the algorithms observed in the C# NvmAnalyzer
 * (Crc8.cs, CRC16 usage, Utils.Crc32). See docs/design.md §14 / appendix B.
 */

export interface CrcModel {
	/** CRC width in bits: 8, 16 or 32. */
	width: 8 | 16 | 32;
	/** Generator polynomial in normal (MSB-first) representation. */
	poly: number;
	/** Initial register value. */
	init: number;
	/** Reflect input bytes. */
	refIn: boolean;
	/** Reflect the final register value. */
	refOut: boolean;
	/** Value XOR-ed into the final register. */
	xorOut: number;
}

export const crcPresets: Record<string, CrcModel> = {
	"CRC8-0xD5": { width: 8, poly: 0xd5, init: 0x00, refIn: false, refOut: false, xorOut: 0x00 },
	"CRC8-SAE-J1850": { width: 8, poly: 0x1d, init: 0xff, refIn: false, refOut: false, xorOut: 0xff },
	"CRC16-CCITT-FALSE": {
		width: 16,
		poly: 0x1021,
		init: 0xffff,
		refIn: false,
		refOut: false,
		xorOut: 0x0000,
	},
	"CRC16-ARC": { width: 16, poly: 0x8005, init: 0x0000, refIn: true, refOut: true, xorOut: 0x0000 },
	CRC32: {
		width: 32,
		poly: 0x04c11db7,
		init: 0xffffffff,
		refIn: true,
		refOut: true,
		xorOut: 0xffffffff,
	},
	CRC32C: {
		width: 32,
		poly: 0x1edc6f41,
		init: 0xffffffff,
		refIn: true,
		refOut: true,
		xorOut: 0xffffffff,
	},
};

/** Reflect the lowest `width` bits of `value`. */
function reflect(value: number, width: number): number {
	let result = 0;
	for (let i = 0; i < width; i++) {
		result = ((result << 1) | (value & 1)) >>> 0;
		value >>>= 1;
	}
	return result >>> 0;
}

/**
 * Compute a CRC over `data` (optionally a sub-range) using the given model.
 * Returns an unsigned integer.
 */
export function computeCrc(
	data: Uint8Array,
	model: CrcModel,
	start = 0,
	end = data.length,
): number {
	const { width, poly, init, refIn, refOut, xorOut } = model;
	const topbit = width === 32 ? 0x80000000 : 1 << (width - 1);
	const widthMask = width === 32 ? 0xffffffff : (1 << width) - 1;

	let crc = init >>> 0;
	for (let i = start; i < end; i++) {
		let byte = data[i] & 0xff;
		if (refIn) {
			byte = reflect(byte, 8);
		}
		crc = (crc ^ ((byte << (width - 8)) >>> 0)) >>> 0;
		for (let bit = 0; bit < 8; bit++) {
			if ((crc & topbit) !== 0) {
				crc = (((crc << 1) >>> 0) ^ poly) >>> 0;
			} else {
				crc = (crc << 1) >>> 0;
			}
			if (width < 32) {
				crc &= widthMask;
			}
		}
	}

	if (refOut) {
		crc = reflect(crc, width);
	}
	crc = (crc ^ xorOut) >>> 0;
	if (width < 32) {
		crc &= widthMask;
	}
	return crc >>> 0;
}

/** Resolve a CRC model from a preset name, throwing on unknown names. */
export function resolveCrcPreset(name: string): CrcModel {
	const preset = crcPresets[name];
	if (!preset) {
		throw new Error(
			`Unknown CRC preset "${name}". Known presets: ${Object.keys(crcPresets).join(", ")}`,
		);
	}
	return preset;
}
