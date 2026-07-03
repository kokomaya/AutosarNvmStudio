// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Business-level struct decoding (design.md §5 L5).
 *
 * A struct describes how to turn a block's payload bytes into named physical
 * values. It is intentionally the same model the legacy NvmAnalyzer `.blk`
 * files express:
 *
 *   Title ; Unit ; NrBts ; Endian(msb|lsb) ; Type(u8/i16/u32/f32/..) ; Opers
 *
 * where `Opers` is an ordered, comma-separated list of scaling operations
 * such as `*0.03125, -273` or `(u16), +1985`. Users can author structs in
 * this legacy text form or directly as JSON (StructDef).
 */

import { DecodedField } from "./model";

export type FieldEndian = "msb" | "lsb";

export interface StructField {
	title: string;
	unit?: string;
	/** Field width in bits. */
	bits: number;
	endian: FieldEndian;
	/** Base type: u8/u16/u32, i8/i16/i32, f32/f64, bool, raw. */
	type: string;
	/** Raw ordered operation string, e.g. "*0.03125, -273". */
	opers?: string;
}

export interface StructDef {
	name: string;
	fields: StructField[];
}

/** Parse a legacy `.blk` struct definition into a StructDef. */
export function parseBlkStruct(text: string, name = "struct"): StructDef {
	const fields: StructField[] = [];
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line.trim().length === 0) {
			continue;
		}
		// Skip the header line (contains "Vers:") and the dashed separator.
		if (/Vers\s*:/i.test(line) || /^-{5,}/.test(line.trim())) {
			continue;
		}
		if (!line.includes(";")) {
			continue;
		}
		const parts = line.split(";").map(p => p.trim());
		const [title, unit, bitsText, endianText, typeText, opers] = parts;
		const bits = parseInt(bitsText, 10);
		if (!title || Number.isNaN(bits)) {
			continue;
		}
		const endian: FieldEndian = /lsb/i.test(endianText ?? "") ? "lsb" : "msb";
		fields.push({
			title,
			unit: unit && unit !== "-" ? unit : undefined,
			bits,
			endian,
			type: (typeText ?? "u8").toLowerCase(),
			opers: opers && opers.length > 0 ? opers : undefined,
		});
	}
	return { name, fields };
}

/** Total number of bytes a struct consumes (bit widths rounded up). */
export function structByteLength(struct: StructDef): number {
	const totalBits = struct.fields.reduce((sum, f) => sum + f.bits, 0);
	return Math.ceil(totalBits / 8);
}

/** Read an unsigned integer of `bits` bits starting at `bitOffset`. */
function readBitsUnsigned(
	data: Uint8Array,
	bitOffset: number,
	bits: number,
	endian: FieldEndian,
): number {
	// Byte-aligned fast path with endianness handling.
	if (bitOffset % 8 === 0 && bits % 8 === 0) {
		const byteOffset = bitOffset / 8;
		const numBytes = bits / 8;
		let value = 0;
		if (endian === "msb") {
			for (let i = 0; i < numBytes; i++) {
				value = value * 256 + (data[byteOffset + i] ?? 0);
			}
		} else {
			for (let i = numBytes - 1; i >= 0; i--) {
				value = value * 256 + (data[byteOffset + i] ?? 0);
			}
		}
		return value >>> 0 === value ? value : value; // keep as number (<=32 bits expected)
	}
	// Generic MSB-first bit extraction for sub-byte fields.
	let value = 0;
	for (let i = 0; i < bits; i++) {
		const absBit = bitOffset + i;
		const byte = data[absBit >> 3] ?? 0;
		const bit = (byte >> (7 - (absBit & 7))) & 1;
		value = (value << 1) | bit;
	}
	return value >>> 0;
}

function signExtend(value: number, bits: number): number {
	const signBit = 1 << (bits - 1);
	return (value & signBit) !== 0 ? value - (1 << bits) : value;
}

function parseNumber(token: string): number {
	return /^0x/i.test(token) ? parseInt(token, 16) : Number(token);
}

/** Cast a value to an integer of the given signed/unsigned width. */
function castTo(value: number, spec: string): number {
	const match = /^([uif])(\d+)$/.exec(spec);
	if (!match) {
		return value;
	}
	const kind = match[1];
	const width = parseInt(match[2], 10);
	if (kind === "f") {
		return value;
	}
	let truncated = Math.trunc(value);
	if (width >= 32) {
		truncated = truncated >>> 0;
		return kind === "i" ? truncated | 0 : truncated;
	}
	const mask = (1 << width) - 1;
	truncated &= mask;
	return kind === "i" ? signExtend(truncated, width) : truncated;
}

/** Apply the ordered `.blk` operation list to a raw numeric value. */
export function applyOpers(value: number, opers: string | undefined): number {
	if (!opers) {
		return value;
	}
	for (const rawToken of opers.split(",")) {
		const token = rawToken.trim();
		if (token.length === 0) {
			continue;
		}
		const cast = /^\(\s*([uif]\d+)\s*\)$/.exec(token);
		if (cast) {
			value = castTo(value, cast[1]);
			continue;
		}
		const op = token[0];
		const operand = token.slice(1).trim();
		switch (op) {
			case "*":
				value *= parseNumber(operand);
				break;
			case "/":
				value /= parseNumber(operand);
				break;
			case "+":
				value += parseNumber(operand);
				break;
			case "-":
				value -= parseNumber(operand);
				break;
			case "&":
				value = (value & parseNumber(operand)) >>> 0;
				break;
			case "|":
				value = (value | parseNumber(operand)) >>> 0;
				break;
			default:
				// Unknown operation token: ignore rather than fail the whole decode.
				break;
		}
	}
	return value;
}

/**
 * Decode `data` (a block payload, or a slice a user selected) using a struct
 * definition. Byte ranges in the result are relative to the start of `data`.
 */
export function decodeStruct(data: Uint8Array, struct: StructDef): DecodedField[] {
	const result: DecodedField[] = [];
	let bitOffset = 0;

	for (const field of struct.fields) {
		const startByte = Math.floor(bitOffset / 8);
		const endByte = Math.ceil((bitOffset + field.bits) / 8);

		let raw: number;
		let asNumber: number;
		if (field.type === "f32" || field.type === "f64") {
			const bytes = data.subarray(startByte, endByte);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const little = field.endian === "lsb";
			raw =
				field.type === "f32"
					? view.getFloat32(0, little)
					: view.getFloat64(0, little);
			asNumber = raw;
		} else {
			const unsigned = readBitsUnsigned(data, bitOffset, field.bits, field.endian);
			raw = field.type.startsWith("i") || field.type.startsWith("s")
				? signExtend(unsigned, field.bits)
				: unsigned;
			asNumber = raw;
		}

		const physical = applyOpers(asNumber, field.opers);
		let value: number | string | boolean = physical;
		if (field.type === "bool") {
			value = physical !== 0;
		}

		result.push({
			path: field.title,
			rawBytes: [startByte, endByte],
			raw,
			value,
			unit: field.unit,
		});

		bitOffset += field.bits;
	}

	return result;
}
