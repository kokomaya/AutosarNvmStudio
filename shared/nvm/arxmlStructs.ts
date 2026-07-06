// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parse AUTOSAR ARXML type definitions into a {@link NvmStructCatalog}.
 *
 * This is the "ARXML" struct-source adapter. It reads the standard AUTOSAR
 * type stack, vendor-blind:
 *
 * - `SW-BASE-TYPE`            → bit width + signedness + endianness (u8/i16/f32/…)
 * - `IMPLEMENTATION-DATA-TYPE`:
 *     - CATEGORY `VALUE`      → a leaf whose base type / compu method we resolve
 *     - CATEGORY `STRUCTURE`  → an {@link NvmStructDef} from its SUB-ELEMENTS
 *     - CATEGORY `ARRAY`      → an element with `dims: [ARRAY-SIZE]`
 *     - CATEGORY `TYPE_REFERENCE` → an alias to another data type
 * - `COMPU-METHOD`:
 *     - `LINEAR`              → `compu.factor` / `compu.offset`
 *     - `TEXTTABLE`/`SCALE_LINEAR_AND_TEXTTABLE` → an {@link NvmEnumDef}
 *
 * It builds on the dependency-free {@link parseXml} reader. It is lenient: any
 * shape it cannot resolve is skipped, never thrown.
 */

import { child, childText, descendants, parseXml, XmlNode } from "./arxml/xml";
import { NvmEnumDef, NvmStructCatalog, NvmStructDef, NvmStructField, RichPrimitive } from "./structRich";

/** Last path segment of an AUTOSAR *-REF (e.g. ".../MyType" → "MyType"). */
function lastSegment(path: string | undefined): string {
	if (!path) {
		return "";
	}
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Resolved SW base type (width + signedness + endianness). */
interface BaseType {
	prim: RichPrimitive;
	endian?: "little" | "big";
}

/** Map a base type (bits + encoding) to a rich primitive. */
function baseToPrim(bits: number, encoding: string): RichPrimitive {
	const enc = encoding.toUpperCase();
	const isFloat = enc.includes("FLOAT") || enc.includes("IEEE");
	if (isFloat) {
		return bits >= 64 ? "f64" : "f32";
	}
	const signed = enc.includes("2C") || enc.includes("SIGN"); // 2's complement / signed
	const w = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 24 ? 24 : bits <= 32 ? 32 : 64;
	return `${signed ? "i" : "u"}${w}` as RichPrimitive;
}

/** Collect all SW-BASE-TYPEs by short name. */
function collectBaseTypes(root: XmlNode): Map<string, BaseType> {
	const out = new Map<string, BaseType>();
	for (const bt of descendants(root, "SW-BASE-TYPE")) {
		const name = childText(bt, "SHORT-NAME");
		if (!name) {
			continue;
		}
		const bits = parseInt(childText(bt, "BASE-TYPE-SIZE") ?? "8", 10) || 8;
		const encoding = childText(bt, "BASE-TYPE-ENCODING") ?? "";
		const byteOrder = childText(bt, "BYTE-ORDER") ?? "";
		const endian = byteOrder.includes("MOST") ? "big" : byteOrder.includes("LEAST") ? "little" : undefined;
		out.set(name, { prim: baseToPrim(bits, encoding), endian });
	}
	return out;
}

/** Collect COMPU-METHODs → either a linear compu or an enum table. */
interface CompuInfo {
	factor?: number;
	offset?: number;
	enumName?: string;
}
function collectCompuMethods(root: XmlNode, enums: Record<string, NvmEnumDef>): Map<string, CompuInfo> {
	const out = new Map<string, CompuInfo>();
	for (const cm of descendants(root, "COMPU-METHOD")) {
		const name = childText(cm, "SHORT-NAME");
		if (!name) {
			continue;
		}
		const category = (childText(cm, "CATEGORY") ?? "").toUpperCase();
		const scales = descendants(cm, "COMPU-SCALE");
		// TEXTTABLE → enum value → label.
		if (category.includes("TEXTTABLE")) {
			const values: Record<string, string> = {};
			for (const sc of scales) {
				const lower = childText(sc, "LOWER-LIMIT");
				const label = childText(sc, "VT") ?? childText(sc, "SYMBOL") ?? "";
				const key = parseFloat(lower ?? "");
				if (!Number.isNaN(key) && label) {
					values[String(Math.trunc(key))] = label;
				}
			}
			if (Object.keys(values).length) {
				enums[name] = { name, values };
				out.set(name, { enumName: name });
				continue;
			}
		}
		// LINEAR → phys = raw * (num1/den) + num0/den.
		const firstScale = scales[0];
		if (firstScale) {
			const coeffs = child(firstScale, "COMPU-RATIONAL-COEFFS");
			if (coeffs) {
				const numerator = child(coeffs, "COMPU-NUMERATOR");
				const denominator = child(coeffs, "COMPU-DENOMINATOR");
				const nums = numerator ? descendants(numerator, "V").map(v => parseFloat(v.text)) : [];
				const dens = denominator ? descendants(denominator, "V").map(v => parseFloat(v.text)) : [];
				const den = dens[0] && dens[0] !== 0 ? dens[0] : 1;
				const offset = nums.length > 0 ? nums[0] / den : 0;
				const factor = nums.length > 1 ? nums[1] / den : 1;
				out.set(name, { factor, offset });
			}
		}
	}
	return out;
}

/** Parse one IMPLEMENTATION-DATA-TYPE-ELEMENT (or the type itself) into a field. */
function elementToField(
	el: XmlNode,
	name: string,
	baseTypes: Map<string, BaseType>,
	compus: Map<string, CompuInfo>,
	enums: Record<string, NvmEnumDef>,
	structs: Record<string, NvmStructDef>,
): NvmStructField | undefined {
	const category = (childText(el, "CATEGORY") ?? "").toUpperCase();

	// ARRAY: one child element repeated ARRAY-SIZE times.
	if (category === "ARRAY") {
		const subs = descendants(el, "IMPLEMENTATION-DATA-TYPE-ELEMENT");
		const inner = subs[0];
		const size = parseInt(childText(inner, "ARRAY-SIZE") ?? childText(el, "ARRAY-SIZE") ?? "0", 10) || 0;
		const innerField = inner
			? elementToField(inner, name, baseTypes, compus, enums, structs)
			: undefined;
		if (innerField) {
			return { ...innerField, name, dims: [size, ...(innerField.dims ?? [])] };
		}
		return { name, type: "u8", dims: [size] };
	}

	// STRUCTURE nested inline: register as a struct, reference it.
	if (category === "STRUCTURE") {
		const nestedName = childText(el, "SHORT-NAME") ?? name;
		const def = structureToDef(el, nestedName, baseTypes, compus, enums, structs);
		structs[nestedName] = def;
		return { name, struct: nestedName };
	}

	// VALUE (or TYPE_REFERENCE resolved to a value): resolve base type + compu.
	const swDataDef = descendants(el, "SW-DATA-DEF-PROPS-CONDITIONAL")[0] ?? el;
	const baseRef = lastSegment(childText(swDataDef, "BASE-TYPE-REF"));
	const compuRef = lastSegment(childText(swDataDef, "COMPU-METHOD-REF"));
	const implRef = lastSegment(childText(el, "IMPLEMENTATION-DATA-TYPE-REF"));

	let prim: RichPrimitive | undefined;
	let endian: "little" | "big" | undefined;
	if (baseRef && baseTypes.has(baseRef)) {
		const bt = baseTypes.get(baseRef)!;
		prim = bt.prim;
		endian = bt.endian;
	}

	const field: NvmStructField = { name, type: prim ?? "u8" };
	if (endian) {
		field.endian = endian;
	}
	// If the value references another impl data type (alias to a struct), nest it.
	if (!prim && implRef && structs[implRef]) {
		return { name, struct: implRef };
	}
	if (compuRef && compus.has(compuRef)) {
		const info = compus.get(compuRef)!;
		if (info.enumName) {
			field.compu = { enum: info.enumName };
		} else if (info.factor !== undefined || info.offset !== undefined) {
			field.compu = { factor: info.factor, offset: info.offset };
		}
	}
	return field;
}

/** Build a struct def from a STRUCTURE IMPLEMENTATION-DATA-TYPE node. */
function structureToDef(
	node: XmlNode,
	name: string,
	baseTypes: Map<string, BaseType>,
	compus: Map<string, CompuInfo>,
	enums: Record<string, NvmEnumDef>,
	structs: Record<string, NvmStructDef>,
): NvmStructDef {
	const fields: NvmStructField[] = [];
	// Direct SUB-ELEMENTS only (not deep descendants — nested structures recurse).
	const subElementsContainer = child(node, "SUB-ELEMENTS");
	const subs = subElementsContainer
		? subElementsContainer.children.filter(c => c.tag === "IMPLEMENTATION-DATA-TYPE-ELEMENT")
		: [];
	for (const sub of subs) {
		const fname = childText(sub, "SHORT-NAME") ?? `field${fields.length}`;
		const field = elementToField(sub, fname, baseTypes, compus, enums, structs);
		if (field) {
			fields.push(field);
		}
	}
	return { name, fields };
}

/** Parse ARXML type definitions into a struct + enum catalog. */
export function arxmlStructs(xmlText: string): NvmStructCatalog {
	const structs: Record<string, NvmStructDef> = {};
	const enums: Record<string, NvmEnumDef> = {};
	if (!xmlText) {
		return { structs, enums };
	}
	let root: XmlNode;
	try {
		root = parseXml(xmlText);
	} catch {
		return { structs, enums };
	}
	const baseTypes = collectBaseTypes(root);
	const compus = collectCompuMethods(root, enums);

	for (const dt of descendants(root, "IMPLEMENTATION-DATA-TYPE")) {
		const name = childText(dt, "SHORT-NAME");
		const category = (childText(dt, "CATEGORY") ?? "").toUpperCase();
		if (!name || category !== "STRUCTURE") {
			continue;
		}
		structs[name] = structureToDef(dt, name, baseTypes, compus, enums, structs);
	}

	return { structs, enums };
}
