// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Config-driven value formatters for the rich struct decoder.
 *
 * Each {@link NvmFormat} `kind` is a GENERIC display primitive — none carries
 * vendor or use-case knowledge. The config chooses which field uses which
 * formatter (and supplies enum tables / bit labels), so the plugin itself stays
 * vendor-layout-free and use-case-free. The reference NvmAnalyzer's per-block
 * C# `Dump()` formatting (version strings, ms→time, UDS status-bit expansion,
 * hex·dec·label triples) is reproduced here as data-selected transforms.
 *
 * Pure arithmetic/string only (no Node/`src` imports) so it is safe in the web
 * build and the injected engine SDK. `formatValue` never throws.
 */

import { evaluateExpression } from "./expr";
import { NvmDecodedNode, NvmFormat, NvmStructCatalog } from "./structRich";

/** Input to {@link formatValue}. */
export interface FormatInput {
	format: NvmFormat;
	/** Numeric raw value (NaN when the field is not a single scalar). */
	rawNum: number;
	/** The field's raw bytes, in memory order. */
	bytes: Uint8Array;
	/** Absolute editor offset of `bytes[0]` (for any child nodes emitted). */
	baseOffset: number;
	catalog: NvmStructCatalog;
	/** Sibling field values in scope for the `expr` escape hatch. */
	scope: Record<string, number>;
}

/** What a formatter contributes to a decoded node. */
export interface FormatResult {
	value?: number | string | boolean;
	hex?: string;
	enumLabel?: string;
	unit?: string;
	children?: NvmDecodedNode[];
}

/** Hex of a non-negative integer to `bytesWide` bytes. */
function hex(value: number, bytesWide: number): string {
	const v = value < 0 ? value >>> 0 : value;
	return "0x" + v.toString(16).toUpperCase().padStart(Math.max(2, bytesWide * 2), "0");
}

/** Printable-ASCII char or '.' (matches the reference GetASCII). */
function asciiChar(b: number): string {
	return b < 0x20 || b > 0x7e ? "." : String.fromCharCode(b);
}

/** Strip an enum label's prefix up to and including its last underscore. */
function shortEnumLabel(label: string): string {
	const i = label.lastIndexOf("_");
	return i >= 0 ? label.slice(i + 1) : label;
}

/** Resolve an enum table (inline wins, else catalog by name). */
function enumTable(
	fmt: NvmFormat,
	catalog: NvmStructCatalog,
): Record<string, string> | undefined {
	return fmt.inline ?? (fmt.enum ? catalog.enums[fmt.enum]?.values : undefined);
}

/**
 * Format a raw value/bytes per a {@link NvmFormat}. Returns the pieces to merge
 * onto the decoded node. Total: any failure yields an empty result, never throws.
 */
export function formatValue(input: FormatInput): FormatResult {
	const { format: fmt, rawNum, bytes, catalog, scope, baseOffset } = input;
	try {
		switch (fmt.kind) {
			case "hex": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				return { value: hex(rawNum, bytes.length || 1) };
			}
			case "dec": {
				return Number.isNaN(rawNum) ? {} : { value: rawNum };
			}
			case "both": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				return { value: `${hex(rawNum, bytes.length || 1)} - ${rawNum}` };
			}
			case "enum": {
				const table = enumTable(fmt, catalog);
				const label = table ? table[String(Math.trunc(rawNum))] : undefined;
				return { enumLabel: label };
			}
			case "version": {
				const parts = fmt.parts ?? 3;
				const sep = fmt.sep ?? ".";
				const nums: string[] = [];
				for (let i = 0; i < parts && i < bytes.length; i++) {
					nums.push(String(bytes[i]).padStart(3, "0"));
				}
				let text = nums.join(sep);
				if (fmt.buildEnum && bytes.length > parts) {
					const table = catalog.enums[fmt.buildEnum]?.values;
					const raw = bytes[parts];
					const label = table?.[String(raw)];
					text += " " + (label ? shortEnumLabel(label) : String(raw));
				}
				return { value: text };
			}
			case "duration": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				const unit = fmt.unit ?? "ms";
				const ms = unit === "s" ? rawNum * 1000 : unit === "us" ? rawNum / 1000 : rawNum;
				const totalSec = Math.floor(ms / 1000);
				const hr = Math.floor(totalSec / 3600);
				const min = Math.floor(totalSec / 60) % 60;
				const sec = totalSec % 60;
				const milli = Math.floor(ms % 1000);
				const p2 = (n: number) => String(n).padStart(2, "0");
				const time = `${p2(hr)}:${p2(min)}:${p2(sec)},${String(milli).padStart(3, "0")}`;
				return { value: `${rawNum} ${unit} - ${time}` };
			}
			case "bitflags": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				const bitCount = (bytes.length || 1) * 8;
				const children: NvmDecodedNode[] = [];
				const table = enumTable(fmt, catalog);
				const entries: { bit: number; label: string }[] = fmt.flags
					? [...fmt.flags]
					: Array.from({ length: bitCount }, (_, bit) => ({
							bit,
							label: table?.[String(bit)] ?? `bit ${bit}`,
						}));
				// High bit first (matches the reference UDS status dump).
				entries.sort((a, b) => b.bit - a.bit);
				for (const e of entries) {
					const set = (rawNum & (1 << e.bit)) !== 0;
					children.push({
						name: `${e.bit} - ${e.label}`,
						type: "flag",
						offset: baseOffset,
						length: bytes.length || 1,
						value: set,
					});
				}
				return { value: hex(rawNum, bytes.length || 1), children };
			}
			case "scaled": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				const v = rawNum * (fmt.factor ?? 1) + (fmt.offset ?? 0);
				return { value: affix(fmt, v), unit: fmt.suffix ? undefined : fmt.unit };
			}
			case "signed":
				return Number.isNaN(rawNum) ? {} : { value: rawNum };
			case "temp": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				return { value: `${rawNum + (fmt.offset ?? 0)}`, unit: fmt.suffix ?? "°C" };
			}
			case "odometer": {
				if (Number.isNaN(rawNum)) {
					return {};
				}
				const sentinel = fmt.sentinel ?? 0xffffff;
				if (rawNum === sentinel) {
					return { value: "none" };
				}
				const v = rawNum * (fmt.factor ?? 1) + (fmt.offset ?? 0);
				return { value: affix(fmt, v) };
			}
			case "ascii": {
				let hexPart = "";
				let ascii = "";
				for (const b of bytes) {
					hexPart += b.toString(16).toUpperCase().padStart(2, "0") + " ";
					ascii += asciiChar(b);
				}
				return { value: `${hexPart.trimEnd()}${bytes.length ? " - " + ascii : ""}` };
			}
			case "expr": {
				if (!fmt.expr) {
					return {};
				}
				const result = evaluateExpression(fmt.expr, { value: rawNum, ...scope });
				const shown = fmt.hex ? hex(result, bytes.length || 4) : String(result);
				return { value: affixStr(fmt, shown) };
			}
			default:
				return {};
		}
	} catch {
		return {};
	}
}

/** Apply prefix/suffix to a numeric value → string (keeps number when no affix). */
function affix(fmt: NvmFormat, value: number): number | string {
	if (!fmt.prefix && !fmt.suffix) {
		return value;
	}
	return `${fmt.prefix ?? ""}${value}${fmt.suffix ?? ""}`;
}

/** Apply prefix/suffix to an already-stringified value. */
function affixStr(fmt: NvmFormat, value: string): string {
	return `${fmt.prefix ?? ""}${value}${fmt.suffix ?? ""}`;
}
