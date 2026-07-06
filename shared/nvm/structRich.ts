// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Rich, vendor-blind business-struct decoding (design.md §5 L5, the general
 * form of {@link ./struct}).
 *
 * A {@link NvmStructDef} describes how to turn a block's payload bytes into a
 * TREE of named, typed physical values. Unlike the flat legacy `.blk` decoder
 * in `struct.ts`, this model supports everything the reference NvmAnalyzer's
 * hand-written C# decoders needed:
 *
 * - primitives (u8..u64 / i8..i64 / f32 / f64 / bool / raw bytes / ascii)
 * - arrays, including 2-D freeze frames (`dims: [rows, cols]`)
 * - nested structs (`struct: "OtherName"`, resolved from the catalog)
 * - bitfields (`bits: N` within a backing scalar `type`)
 * - explicit `offset` / `padding` / `align` (the C `i += n` padding gaps)
 * - per-field endianness override and linear/enum/opers scaling (`compu`)
 *
 * The decoder is intentionally TOTAL: any short read or malformed definition
 * yields a partial node and stops — it never throws. All 64-bit values cross
 * the wire as decimal strings (JSON.stringify throws on bigint), and every
 * node carries an ABSOLUTE editor byte offset so the UI can reveal/select it.
 *
 * The whole module is pure data + arithmetic (no `src/` or Node imports) so it
 * is safe in the desktop build, the web build, and the injected engine SDK.
 */

import { formatValue } from "./structFormat";
import { applyOpers, StructDef } from "./struct";

/** Byte order used by the rich model (matches `model.ts` / the protocol). */
export type RichEndian = "little" | "big";

/** Supported scalar element types. */
export type RichPrimitive =
	| "u8"
	| "u16"
	| "u24"
	| "u32"
	| "u64"
	| "i8"
	| "i16"
	| "i24"
	| "i32"
	| "i64"
	| "f32"
	| "f64"
	| "bool"
	| "bytes"
	| "ascii";

/** How a raw value is turned into a physical / labelled value. */
export interface RichCompu {
	/** Physical = raw * factor + offset (AUTOSAR LINEAR CompuMethod). */
	factor?: number;
	offset?: number;
	/** Name of an enum in the catalog whose table maps value → label. */
	enum?: string;
	/** Inline value → label table (alternative to a catalog enum). */
	enumInline?: Record<string, string>;
	/** Legacy `.blk` operation list, e.g. "*0.03125, -273" (reuses applyOpers). */
	opers?: string;
}

/** Presentation hint for a leaf value. Purely advisory. */
export type RichDisplay = "hex" | "dec" | "both" | "ascii" | "bool";

/**
 * A named, config-driven value formatter (see structFormat.ts). All kinds are
 * generic display primitives with NO vendor/use-case knowledge — the config
 * decides which field uses which, keeping the plugin use-case-free.
 */
export interface NvmFormat {
	kind:
		| "hex"
		| "dec"
		| "both"
		| "enum"
		| "version"
		| "duration"
		| "bitflags"
		| "scaled"
		| "signed"
		| "temp"
		| "odometer"
		| "ascii"
		| "expr";
	/** enum: catalog enum name. */
	enum?: string;
	/** enum/bitflags: inline value/bit → label. */
	inline?: Record<string, string>;
	/** version: how many leading bytes form the number parts (default 3). */
	parts?: number;
	/** version: catalog enum naming the trailing build-type byte. */
	buildEnum?: string;
	/** version: separator between parts (default "."). */
	sep?: string;
	/** duration: source unit of the raw value ("ms" | "s" | "us"). */
	unit?: string;
	/** bitflags: explicit bit → label list (bit 0 = LSB). */
	flags?: { bit: number; label: string }[];
	/** scaled/temp: physical = raw * factor + offset. */
	factor?: number;
	offset?: number;
	/** odometer/*: raw value treated as "unset" → rendered as `none`. */
	sentinel?: number;
	/** expr: whitelisted arithmetic over `value` (+ sibling fields) → number. */
	expr?: string;
	/** expr: render the expr result in hex. */
	hex?: boolean;
	/** expr/scaled/temp: text affixes around the formatted value. */
	prefix?: string;
	suffix?: string;
}

/** One field of a struct definition. `type` XOR `struct` selects the element. */
export interface NvmStructField {
	name: string;
	/** Primitive element type (mutually exclusive with {@link struct}). */
	type?: RichPrimitive;
	/** Nested struct (or union) element, referenced by catalog name. */
	struct?: string;
	/**
	 * Array dimensions. `[]`/omitted = scalar, `[n]` = 1-D, `[rows, cols]` = 2-D.
	 * A dimension given as a string names an already-decoded sibling field whose
	 * numeric value is the count (variable-length arrays).
	 */
	dims?: (number | string)[];
	/** Bitfield width, in bits, within the backing scalar {@link type}. */
	bits?: number;
	/** Byte count for `bytes` / `ascii` elements (default 1). */
	size?: number;
	/** Explicit in-struct byte offset (relative to the struct start). */
	offset?: number;
	/** Bytes to skip before this field (the C `i += n` padding gap). */
	padding?: number;
	/** Align the cursor up to this many bytes (relative to the struct start). */
	align?: number;
	/** Per-field byte order override. */
	endian?: RichEndian;
	unit?: string;
	compu?: RichCompu;
	display?: RichDisplay;
	/** Rich, config-driven formatter for this field's value. */
	format?: NvmFormat;
	/**
	 * When this field's element is a `union` struct, the name of the sibling
	 * field whose value selects the active member via {@link cases}.
	 */
	discriminator?: string;
	/**
	 * union member selection: discriminator value → member field name (of the
	 * referenced union def). `"default"` is used when no case matches.
	 */
	cases?: Record<string, string>;
}

/** How a struct's fields are laid out in memory. */
export type NvmLayoutMode = "packed" | "c";

/** A named struct (or union) layout. */
export interface NvmStructDef {
	name: string;
	/** Default byte order for the struct's fields. */
	endian?: RichEndian;
	/** Declared byte size (informational; the decoder walks fields). */
	size?: number;
	/**
	 * Memory layout. `"packed"` (default) = fields are consecutive with no gaps
	 * (back-compat for hand-authored JSON and compiled `.blk`). `"c"` = natural C
	 * alignment (each field aligned to its own alignment; struct size padded to
	 * its max member alignment) — emitted by the C-header parser.
	 */
	layout?: NvmLayoutMode;
	/** When true this def is a C `union`: all members overlay at offset 0. */
	union?: boolean;
	fields: NvmStructField[];
}

/** A named value → label table (reset reasons, DEM/DTC ids, states, …). */
export interface NvmEnumDef {
	name: string;
	values: Record<string, string>;
	/** Byte width of a field whose type IS this enum (AUTOSAR default 4). */
	width?: number;
}

/** The pool of structs + enums an engine assembles from its sources. */
export interface NvmStructCatalog {
	structs: Record<string, NvmStructDef>;
	enums: Record<string, NvmEnumDef>;
}

/**
 * One node of a decoded tree. Offsets are ABSOLUTE editor byte offsets so the
 * inspector can reveal/select the bytes directly. The webview treats this as
 * opaque display data — the engine has already done all decoding.
 */
export interface NvmDecodedNode {
	name: string;
	/** Primitive name, a struct name, or "array". */
	type: string;
	/** Absolute editor byte offset (baseOffset + in-struct offset). */
	offset: number;
	length: number;
	/** Raw value; u64/i64/bytes/ascii cross the wire as strings. */
	raw?: number | string;
	/** Physical value after compu (bool for `bool`, string for text). */
	value?: number | string | boolean;
	unit?: string;
	enumLabel?: string;
	/** Pre-rendered hex of the raw integer (UI stays dumb). */
	hex?: string;
	/** For a bitfield: its width and bit offset within the backing scalar. */
	bits?: { width: number; offset: number };
	children?: NvmDecodedNode[];
}

/** Options for {@link decodeStructRich}. */
export interface DecodeRichOpts {
	/** Absolute editor offset that maps to `bytes[0]`. */
	baseOffset: number;
	catalog: NvmStructCatalog;
	/** Safety cap on emitted nodes (default 20000). */
	maxNodes?: number;
}

/** Byte width of a fixed-width primitive, or 0 for variable (bytes/ascii). */
function primitiveWidth(type: RichPrimitive, size?: number): number {
	switch (type) {
		case "u8":
		case "i8":
		case "bool":
			return 1;
		case "u16":
		case "i16":
			return 2;
		case "u24":
		case "i24":
			return 3;
		case "u32":
		case "i32":
		case "f32":
			return 4;
		case "u64":
		case "i64":
		case "f64":
			return 8;
		case "bytes":
		case "ascii":
			return Math.max(0, size ?? 1);
	}
}

/** Alignment (in bytes) of a primitive type under natural C layout. */
function primitiveAlign(type: RichPrimitive, size?: number): number {
	switch (type) {
		case "u8":
		case "i8":
		case "bool":
		case "bytes":
		case "ascii":
			return 1;
		case "u16":
		case "i16":
			return 2;
		case "u24":
		case "i24":
			return 1; // packed 3-byte value, byte-aligned
		case "u32":
		case "i32":
		case "f32":
			return 4;
		case "u64":
		case "i64":
		case "f64":
			return 8;
	}
	return 1;
}

/**
 * Natural C alignment of a field's ELEMENT (ignoring array multiplicity), used
 * only when the owning struct has `layout: "c"`. Enum fields align to their enum
 * width; nested struct/union fields align to their max member alignment.
 */
function fieldAlign(field: NvmStructField, catalog: NvmStructCatalog, depth: number): number {
	if (field.struct) {
		const def = catalog.structs[field.struct];
		return def ? defAlign(def, catalog, depth + 1) : 1;
	}
	// An enum-typed field carries its width via compu.enum; its declared `type`
	// already reflects that width (the C parser emits u16/u32 accordingly), so the
	// primitive alignment is correct.
	return primitiveAlign(field.type ?? "u8", field.size);
}

/** Max member alignment of a struct/union def (with a recursion guard). */
function defAlign(def: NvmStructDef, catalog: NvmStructCatalog, depth: number): number {
	if (depth > 32 || def.layout !== "c") {
		return 1;
	}
	let a = 1;
	for (const f of def.fields) {
		a = Math.max(a, fieldAlign(f, catalog, depth));
	}
	return a;
}

/** Read an unsigned integer of `width` (<=6) bytes as a JS number. */
function readUintBytes(bytes: Uint8Array, off: number, width: number, little: boolean): number {
	let value = 0;
	if (little) {
		for (let i = width - 1; i >= 0; i--) {
			value = value * 256 + (bytes[off + i] ?? 0);
		}
	} else {
		for (let i = 0; i < width; i++) {
			value = value * 256 + (bytes[off + i] ?? 0);
		}
	}
	return value;
}

/** Read an unsigned 64-bit integer as a BigInt. */
function readUint64(bytes: Uint8Array, off: number, little: boolean): bigint {
	let value = 0n;
	if (little) {
		for (let i = 7; i >= 0; i--) {
			value = (value << 8n) | BigInt(bytes[off + i] ?? 0);
		}
	} else {
		for (let i = 0; i < 8; i++) {
			value = (value << 8n) | BigInt(bytes[off + i] ?? 0);
		}
	}
	return value;
}

/** Sign-extend an unsigned `bits`-wide value. */
function signExtend(value: number, bits: number): number {
	const signBit = 1 << (bits - 1);
	return (value & signBit) !== 0 ? value - (1 << bits) : value;
}

/** Hex render of a non-negative integer to `width` bytes. */
function hexOf(value: number | bigint, width: number): string {
	const digits = Math.max(2, width * 2);
	if (typeof value === "bigint") {
		const v = value < 0n ? value + (1n << BigInt(width * 8)) : value;
		return "0x" + v.toString(16).toUpperCase().padStart(digits, "0");
	}
	const v = value < 0 ? value >>> 0 : value;
	return "0x" + v.toString(16).toUpperCase().padStart(digits, "0");
}

/** Result of decoding a single primitive value. */
interface PrimValue {
	raw: number | string;
	/** Numeric raw for compu/enum (NaN when not applicable). */
	rawNum: number;
	value: number | string | boolean;
	hex?: string;
}

/** Decode one primitive (no compu applied) at an absolute byte offset. */
function decodePrimitive(
	bytes: Uint8Array,
	off: number,
	type: RichPrimitive,
	little: boolean,
	size?: number,
): PrimValue {
	switch (type) {
		case "bool": {
			const b = bytes[off] ?? 0;
			return { raw: b, rawNum: b, value: b !== 0, hex: hexOf(b, 1) };
		}
		case "ascii": {
			const width = primitiveWidth(type, size);
			let s = "";
			for (let i = 0; i < width; i++) {
				const c = bytes[off + i] ?? 0;
				s += c === 0 ? "" : String.fromCharCode(c);
			}
			return { raw: s, rawNum: NaN, value: s };
		}
		case "bytes": {
			const width = primitiveWidth(type, size);
			let hex = "";
			for (let i = 0; i < width; i++) {
				hex += (bytes[off + i] ?? 0).toString(16).toUpperCase().padStart(2, "0");
			}
			const h = hex.length ? "0x" + hex : "0x";
			return { raw: h, rawNum: NaN, value: h, hex: h };
		}
		case "f32":
		case "f64": {
			const width = type === "f32" ? 4 : 8;
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const canRead = off + width <= bytes.length;
			const raw = !canRead
				? 0
				: type === "f32"
					? view.getFloat32(off, little)
					: view.getFloat64(off, little);
			return { raw, rawNum: raw, value: raw };
		}
		case "u64":
		case "i64": {
			let big = readUint64(bytes, off, little);
			if (type === "i64" && big >= 1n << 63n) {
				big -= 1n << 64n;
			}
			return { raw: big.toString(), rawNum: Number(big), value: big.toString(), hex: hexOf(big, 8) };
		}
		default: {
			const width = primitiveWidth(type, size);
			const unsigned = readUintBytes(bytes, off, width, little);
			const raw = type.startsWith("i") ? signExtend(unsigned, width * 8) : unsigned;
			return { raw, rawNum: raw, value: raw, hex: hexOf(unsigned, width) };
		}
	}
}

/** Apply a field's compu to a raw numeric value; resolve enum label. */
function applyCompu(
	rawNum: number,
	compu: RichCompu | undefined,
	catalog: NvmStructCatalog,
): { value: number; enumLabel?: string } {
	let value = rawNum;
	let enumLabel: string | undefined;
	if (compu) {
		if (compu.factor !== undefined || compu.offset !== undefined) {
			value = value * (compu.factor ?? 1) + (compu.offset ?? 0);
		}
		if (compu.opers) {
			value = applyOpers(value, compu.opers);
		}
		const table = compu.enumInline ?? (compu.enum ? catalog.enums[compu.enum]?.values : undefined);
		if (table) {
			const key = String(Math.trunc(rawNum));
			enumLabel = table[key];
		}
	}
	return { value, enumLabel };
}

/** Mutable walk state shared across the recursion. */
interface Walk {
	bytes: Uint8Array;
	base: number;
	catalog: NvmStructCatalog;
	maxNodes: number;
	nodeCount: number;
	truncated: boolean;
	/** Guards against runaway/cyclic nested struct references. */
	depth: number;
}

/** An in-progress bitfield group sharing one backing scalar. */
interface BitGroup {
	startByte: number;
	widthBytes: number;
	backing: number;
	bitConsumed: number;
	little: boolean;
}

/** Align `rel` up to a multiple of `align`. */
function alignUp(rel: number, align: number): number {
	if (align <= 1) {
		return rel;
	}
	return Math.ceil(rel / align) * align;
}

/** Resolve a dims list, substituting sibling-driven counts. */
function resolveDims(
	dims: (number | string)[] | undefined,
	siblings: Map<string, number>,
): number[] {
	if (!dims || dims.length === 0) {
		return [];
	}
	return dims.map(d => {
		if (typeof d === "number") {
			return d > 0 ? Math.floor(d) : 0;
		}
		const v = siblings.get(d);
		return typeof v === "number" && v > 0 ? Math.floor(v) : 0;
	});
}

/**
 * Apply a field's rich {@link NvmFormat} to an already-decoded node, mutating it
 * in place. The raw bytes come from the node's absolute offset/length. No-op
 * when the field has no `format`.
 */
function applyFormat(
	node: NvmDecodedNode,
	field: NvmStructField,
	rawNum: number,
	walk: Walk,
	siblings: Map<string, number>,
): void {
	if (!field.format) {
		return;
	}
	const localStart = node.offset - walk.base;
	const slice = walk.bytes.subarray(localStart, localStart + Math.max(0, node.length));
	const scope: Record<string, number> = {};
	for (const [k, v] of siblings) {
		scope[k] = v;
	}
	const result = formatValue({
		format: field.format,
		rawNum,
		bytes: slice,
		baseOffset: node.offset,
		catalog: walk.catalog,
		scope,
	});
	if (result.value !== undefined) {
		node.value = result.value;
	}
	if (result.hex !== undefined) {
		node.hex = result.hex;
	}
	if (result.enumLabel !== undefined) {
		node.enumLabel = result.enumLabel;
	}
	if (result.unit !== undefined) {
		node.unit = result.unit;
	}
	if (result.children !== undefined) {
		node.children = result.children;
	}
}

/** Decode the fields of a struct starting at `startByte`. Returns end cursor. */
function runFields(
	def: NvmStructDef,
	walk: Walk,
	startByte: number,
	inheritedEndian: RichEndian,
): { children: NvmDecodedNode[]; endByte: number } {
	const fields = def.fields;
	const isC = def.layout === "c";
	const isUnion = def.union === true;
	const children: NvmDecodedNode[] = [];
	const siblings = new Map<string, number>();
	let cursor = startByte;
	let maxEnd = startByte; // for unions: widest member end
	let bitGroup: BitGroup | undefined;

	const closeBitGroup = () => {
		if (bitGroup) {
			cursor = bitGroup.startByte + bitGroup.widthBytes;
			bitGroup = undefined;
		}
	};

	for (const field of fields) {
		if (walk.nodeCount >= walk.maxNodes) {
			walk.truncated = true;
			break;
		}
		// Every union member overlays the union start.
		if (isUnion) {
			cursor = startByte;
		}
		const little = (field.endian ?? inheritedEndian) === "little";
		const isBits =
			!!field.bits &&
			field.bits > 0 &&
			!!field.type &&
			!field.struct &&
			(!field.dims || field.dims.length === 0);

		if (isBits && field.type) {
			// Continue or (re)start a backing scalar for consecutive bitfields.
			const widthBytes = primitiveWidth(field.type);
			const backingBits = widthBytes * 8;
			if (
				!bitGroup ||
				bitGroup.little !== little ||
				bitGroup.bitConsumed + field.bits! > bitGroup.widthBytes * 8
			) {
				closeBitGroup();
				bitGroup = {
					startByte: cursor,
					widthBytes,
					backing: readUintBytes(walk.bytes, cursor, widthBytes, little),
					bitConsumed: 0,
					little,
				};
			}
			const bg = bitGroup;
			const width = field.bits!;
			const shift = bg.little
				? bg.bitConsumed
				: backingBits - bg.bitConsumed - width;
			const mask = width >= 31 ? 0xffffffff : (1 << width) - 1;
			let unsigned = (bg.backing >>> Math.max(0, shift)) & mask;
			const rawNum = field.type.startsWith("i") ? signExtend(unsigned, width) : unsigned;
			const { value, enumLabel } = applyCompu(rawNum, field.compu, walk.catalog);
			const node: NvmDecodedNode = {
				name: field.name,
				type: field.type,
				offset: walk.base + bg.startByte,
				length: bg.widthBytes,
				raw: rawNum,
				value,
				unit: field.unit,
				enumLabel,
				hex: hexOf(unsigned >>> 0, Math.ceil(width / 8)),
				bits: { width, offset: bg.bitConsumed },
			};
			applyFormat(node, field, rawNum, walk, siblings);
			children.push(node);
			walk.nodeCount++;
			siblings.set(field.name, rawNum);
			bg.bitConsumed += width;
			if (bg.bitConsumed >= bg.widthBytes * 8) {
				closeBitGroup();
			}
			maxEnd = Math.max(maxEnd, cursor + bg.widthBytes);
			continue;
		}

		// Non-bitfield: close any pending bit group, then apply placement.
		closeBitGroup();
		if (isUnion) {
			cursor = startByte;
		}
		if (field.offset !== undefined) {
			cursor = startByte + field.offset;
		} else {
			if (field.padding) {
				cursor += field.padding;
			}
			// Natural C alignment for the field's element (arrays align to element).
			if (isC && !isUnion) {
				const a = fieldAlign(field, walk.catalog, walk.depth);
				cursor = startByte + alignUp(cursor - startByte, a);
			}
			if (field.align) {
				cursor = startByte + alignUp(cursor - startByte, field.align);
			}
		}

		const dims = resolveDims(field.dims, siblings);
		const { node, endByte } = decodeFieldValue(field, walk, cursor, little, dims, 0, siblings);
		// Scalars carry rawNum; byte arrays with a bytes-oriented format (ascii/hex)
		// are formatted over their whole span (rawNum = NaN, formatter uses bytes).
		if (field.format) {
			const rawForFmt = typeof node.raw === "number" ? node.raw : NaN;
			applyFormat(node, field, rawForFmt, walk, siblings);
		}
		children.push(node);
		walk.nodeCount++;
		// Only plain scalars can drive a sibling-length; record their numeric raw.
		if (dims.length === 0 && typeof node.raw === "number") {
			siblings.set(field.name, node.raw);
		}
		maxEnd = Math.max(maxEnd, endByte);
		if (!isUnion) {
			cursor = endByte;
		}
	}

	closeBitGroup();
	// A union occupies its widest member; a struct ends at the cursor. Under C
	// layout, pad the struct's end up to its own alignment (array stride / parent).
	let endByte = isUnion ? maxEnd : cursor;
	if (isC) {
		const a = defAlign(def, walk.catalog, walk.depth);
		endByte = startByte + alignUp(endByte - startByte, a);
	}
	return { children, endByte };
}

/** Decode one element of a nested struct at `atByte`. */
function decodeStructElement(
	def: NvmStructDef,
	walk: Walk,
	atByte: number,
	inheritedEndian: RichEndian,
	name: string,
): { node: NvmDecodedNode; endByte: number } {
	if (walk.depth >= 32) {
		// Cyclic / pathological nesting guard.
		return {
			node: { name, type: def.name, offset: walk.base + atByte, length: 0 },
			endByte: atByte,
		};
	}
	walk.depth++;
	const endian = def.endian ?? inheritedEndian;
	const { children, endByte } = runFields(def, walk, atByte, endian);
	walk.depth--;
	return {
		node: {
			name,
			type: def.name,
			offset: walk.base + atByte,
			length: endByte - atByte,
			children,
		},
		endByte,
	};
}

/**
 * Decode a `union`-typed field: pick the active member via the discriminator +
 * cases, decode only that member (overlaid at the union start), and advance by
 * the union's full width (its widest member). Unknown/missing selection decodes
 * `cases.default` if present, else emits an empty note.
 */
function decodeUnionElement(
	def: NvmStructDef,
	field: NvmStructField,
	walk: Walk,
	atByte: number,
	inheritedEndian: RichEndian,
	siblings: Map<string, number>,
): { node: NvmDecodedNode; endByte: number } {
	// Full union width = widest member (decode all members' sizes without emitting).
	const unionWidth = unionByteWidth(def, walk, atByte, inheritedEndian);
	// Choose the active member.
	let memberName: string | undefined;
	if (field.discriminator !== undefined && field.cases) {
		const sel = siblings.get(field.discriminator);
		if (sel !== undefined) {
			memberName = field.cases[String(sel)] ?? field.cases.default;
		} else {
			memberName = field.cases.default;
		}
	}
	const member = memberName ? def.fields.find(f => f.name === memberName) : undefined;
	if (!member) {
		return {
			node: {
				name: field.name,
				type: def.name,
				offset: walk.base + atByte,
				length: unionWidth,
				value: memberName ? `<union member ${memberName} not found>` : "<no union case matched>",
			},
			endByte: atByte + unionWidth,
		};
	}
	// Decode just the selected member at the union start.
	const little = (member.endian ?? inheritedEndian) === "little";
	const { node } = decodeFieldValue(member, walk, atByte, little, resolveDims(member.dims, siblings), 0, siblings);
	return {
		node: {
			name: field.name,
			type: def.name,
			offset: walk.base + atByte,
			length: unionWidth,
			children: [node],
		},
		endByte: atByte + unionWidth,
	};
}

/** Compute a union's byte width = widest member (no nodes emitted). */
function unionByteWidth(
	def: NvmStructDef,
	walk: Walk,
	atByte: number,
	inheritedEndian: RichEndian,
): number {
	let width = 0;
	for (const f of def.fields) {
		width = Math.max(width, memberByteWidth(f, walk, atByte, inheritedEndian));
	}
	if (def.layout === "c") {
		width = alignUp(width, defAlign(def, walk.catalog, walk.depth));
	}
	return width;
}

/** Byte width a single (possibly array/struct) member occupies. */
function memberByteWidth(
	field: NvmStructField,
	walk: Walk,
	atByte: number,
	inheritedEndian: RichEndian,
): number {
	let count = 1;
	if (field.dims && field.dims.length) {
		for (const d of field.dims) {
			count *= typeof d === "number" ? Math.max(0, d) : 0;
		}
	}
	let elemWidth: number;
	if (field.struct) {
		const sub = walk.catalog.structs[field.struct];
		if (!sub || walk.depth > 32) {
			elemWidth = 0;
		} else if (sub.union) {
			walk.depth++;
			elemWidth = unionByteWidth(sub, walk, atByte, inheritedEndian);
			walk.depth--;
		} else {
			walk.depth++;
			// Measure via a dry run of runFields size (endByte - start).
			const saved = { nodeCount: walk.nodeCount };
			const { endByte } = runFields(sub, walk, atByte, sub.endian ?? inheritedEndian);
			walk.nodeCount = saved.nodeCount; // don't count measurement nodes
			elemWidth = endByte - atByte;
			walk.depth--;
		}
	} else {
		elemWidth = primitiveWidth(field.type ?? "u8", field.size);
	}
	return elemWidth * count;
}

/**
 * Decode a field value at `cursor`, honoring array `dims` (recursively). Returns
 * the produced node and the cursor after consuming it.
 */
function decodeFieldValue(
	field: NvmStructField,
	walk: Walk,
	cursor: number,
	little: boolean,
	dims: number[],
	dimIndex: number,
	siblings: Map<string, number>,
): { node: NvmDecodedNode; endByte: number } {
	// Array dimension: wrap N sub-elements in an "array" node.
	if (dimIndex < dims.length) {
		const count = dims[dimIndex];
		const elements: NvmDecodedNode[] = [];
		let c = cursor;
		for (let i = 0; i < count; i++) {
			if (walk.nodeCount >= walk.maxNodes) {
				walk.truncated = true;
				break;
			}
			const { node, endByte } = decodeFieldValue(field, walk, c, little, dims, dimIndex + 1, siblings);
			node.name = `${field.name}[${i}]`;
			elements.push(node);
			walk.nodeCount++;
			c = endByte;
		}
		return {
			node: {
				name: field.name,
				type: "array",
				offset: walk.base + cursor,
				length: c - cursor,
				children: elements,
			},
			endByte: c,
		};
	}

	// Leaf element: nested struct/union or primitive.
	if (field.struct) {
		const def = walk.catalog.structs[field.struct];
		if (!def) {
			return {
				node: {
					name: field.name,
					type: field.struct,
					offset: walk.base + cursor,
					length: 0,
					value: `<unknown struct ${field.struct}>`,
				},
				endByte: cursor,
			};
		}
		const endian: RichEndian = field.endian ?? def.endian ?? (little ? "little" : "big");
		if (def.union) {
			return decodeUnionElement(def, field, walk, cursor, endian, siblings);
		}
		return decodeStructElement(def, walk, cursor, endian, field.name);
	}

	const type = field.type ?? "u8";
	const width = primitiveWidth(type, field.size);
	const prim = decodePrimitive(walk.bytes, cursor, type, little, field.size);
	// Only run compu when one is configured AND the raw is numeric; otherwise keep
	// the primitive's own value (preserves u64/i64 decimal strings, ascii, bytes).
	const { value, enumLabel } =
		field.compu && !Number.isNaN(prim.rawNum)
			? applyCompu(prim.rawNum, field.compu, walk.catalog)
			: { value: prim.value, enumLabel: undefined as string | undefined };
	// Clamp reported length to the available bytes so reveal never runs past EOF.
	const avail = Math.max(0, walk.bytes.length - cursor);
	const length = Math.min(width, avail);
	return {
		node: {
			name: field.name,
			type,
			offset: walk.base + cursor,
			length,
			raw: prim.raw,
			value,
			unit: field.unit,
			enumLabel,
			hex: prim.hex,
		},
		endByte: cursor + width,
	};
}

/**
 * Decode `bytes` into a tree of physical values per a rich struct definition.
 * Node offsets are absolute editor offsets (`baseOffset + in-struct offset`).
 * Total: malformed defs / short reads yield partial nodes, never throw.
 */
export function decodeStructRich(
	bytes: Uint8Array,
	def: NvmStructDef,
	opts: DecodeRichOpts,
): NvmDecodedNode[] {
	const walk: Walk = {
		bytes,
		base: opts.baseOffset,
		catalog: opts.catalog ?? { structs: {}, enums: {} },
		maxNodes: opts.maxNodes ?? 20000,
		nodeCount: 0,
		truncated: false,
		depth: 0,
	};
	const endian = def.endian ?? "little";
	const { children } = runFields(def, walk, 0, endian);
	if (walk.truncated) {
		children.push({
			name: "…",
			type: "note",
			offset: opts.baseOffset,
			length: 0,
			value: `output truncated at ${walk.maxNodes} nodes`,
		});
	}
	return children;
}

/**
 * Compile a legacy flat `.blk` {@link StructDef} into the rich model, so every
 * existing `.blk` decodes identically through {@link decodeStructRich}.
 */
export function compileBlkToRich(def: StructDef): NvmStructDef {
	const fields: NvmStructField[] = def.fields.map(f => {
		const endian: RichEndian = f.endian === "lsb" ? "little" : "big";
		const compu: RichCompu | undefined = f.opers ? { opers: f.opers } : undefined;
		const type = f.type;
		// Byte-aligned width → a plain primitive; sub-byte → a bitfield.
		if (f.bits % 8 === 0) {
			const richType = normalizeBlkType(type, f.bits);
			return { name: f.title, type: richType, endian, unit: f.unit, compu };
		}
		// Sub-byte bitfield: back it with the smallest scalar that holds the bits.
		const widthBytes = Math.max(1, Math.ceil(f.bits / 8));
		const backing: RichPrimitive =
			type.startsWith("i") || type.startsWith("s")
				? ((widthBytes <= 1 ? "i8" : widthBytes <= 2 ? "i16" : "i32") as RichPrimitive)
				: ((widthBytes <= 1 ? "u8" : widthBytes <= 2 ? "u16" : "u32") as RichPrimitive);
		return { name: f.title, type: backing, bits: f.bits, endian, unit: f.unit, compu };
	});
	return { name: def.name, fields };
}

/** Map a legacy `.blk` type token + bit width to a rich primitive. */
function normalizeBlkType(type: string, bits: number): RichPrimitive {
	const t = type.toLowerCase();
	if (t === "f32" || t === "float") {
		return "f32";
	}
	if (t === "f64" || t === "double") {
		return "f64";
	}
	if (t === "bool") {
		return "bool";
	}
	if (t === "raw" || t === "bytes") {
		return "bytes";
	}
	const signed = t.startsWith("i") || t.startsWith("s");
	const bytes = Math.max(1, Math.round(bits / 8));
	const width = bytes <= 1 ? 8 : bytes <= 2 ? 16 : bytes <= 3 ? 24 : bytes <= 4 ? 32 : 64;
	return `${signed ? "i" : "u"}${width}` as RichPrimitive;
}

/** Coerce untrusted JSON into a {@link NvmStructCatalog} (lenient, total). */
export function parseStructCatalog(json: unknown): NvmStructCatalog {
	const out: NvmStructCatalog = { structs: {}, enums: {} };
	if (!json || typeof json !== "object") {
		return out;
	}
	const obj = json as Record<string, unknown>;
	const structs = obj.structs;
	if (structs && typeof structs === "object") {
		for (const [key, val] of Object.entries(structs as Record<string, unknown>)) {
			if (val && typeof val === "object" && Array.isArray((val as NvmStructDef).fields)) {
				const def = val as NvmStructDef;
				out.structs[key] = { ...def, name: def.name ?? key };
			}
		}
	}
	const enums = obj.enums;
	if (enums && typeof enums === "object") {
		for (const [key, val] of Object.entries(enums as Record<string, unknown>)) {
			if (val && typeof val === "object") {
				const def = val as Partial<NvmEnumDef>;
				const values = def.values && typeof def.values === "object" ? def.values : {};
				out.enums[key] = { name: def.name ?? key, values: values as Record<string, string> };
			}
		}
	}
	return out;
}

/** Merge catalogs; later arguments win on key conflicts. */
export function mergeCatalogs(...catalogs: NvmStructCatalog[]): NvmStructCatalog {
	const out: NvmStructCatalog = { structs: {}, enums: {} };
	for (const cat of catalogs) {
		if (!cat) {
			continue;
		}
		Object.assign(out.structs, cat.structs);
		Object.assign(out.enums, cat.enums);
	}
	return out;
}
