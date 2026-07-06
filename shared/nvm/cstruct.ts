// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parse generated AUTOSAR / C source headers into a {@link NvmStructCatalog}.
 *
 * This is the "C source" struct-source adapter. It is a lenient, brace-aware
 * scanner — NOT a full C compiler — tuned for the machine-generated headers used
 * by AUTOSAR stacks (Vector MICROSAR, Continental FS/DEM, …). It recovers:
 *
 * - `typedef struct/union [tag] { … } Name;` → an {@link NvmStructDef}
 *   (structs marked `layout: "c"` so the decoder applies natural C alignment)
 * - primitive fields, arrays `T x[N]` / `T x[N][M]`, arrays with `#define`/
 *   `sizeof` size EXPRESSIONS (`x[SIZE/sizeof(uint32)]`)
 * - C bitfields `T x : N`, anonymous nested `struct/union { … } x[N]`
 * - enum-typed fields (emitted as a `u32` + `compu.enum`; C enums are int-wide)
 * - `typedef enum { A, B=5 } E;` → an {@link NvmEnumDef}, including values that
 *   are FUNCTION-MACRO expressions (`RESET_REASON(16u,1)` → 0x4010, evaluated)
 * - object/`#define` and function macros, resolved cross-file when several
 *   headers are concatenated before parsing
 * - AUTOSAR memory-class wrappers `P2VAR/P2CONST/VAR/CONST(type,…)` (stripped)
 *
 * What it cannot resolve (a missing `#include`'d size macro, a macro-computed
 * enum it can't evaluate) is reported via {@link parseCStructsEx} diagnostics so
 * the caller can supply the gap as inline JSON — it never throws.
 */

import { evaluateExpression } from "./expr";
import { NvmEnumDef, NvmStructCatalog, NvmStructDef, NvmStructField, RichPrimitive } from "./structRich";

/** Map a C base type token (possibly multi-word) to a rich primitive. */
function mapCType(token: string): RichPrimitive | undefined {
	switch (token.replace(/\s+/g, " ").trim()) {
		case "uint8":
		case "uint8_t":
		case "u8":
		case "unsigned char":
		case "byte":
			return "u8";
		case "boolean":
		case "bool":
			return "bool";
		case "sint8":
		case "int8":
		case "int8_t":
		case "s8":
		case "signed char":
			return "i8";
		case "char":
			return "ascii";
		case "uint16":
		case "uint16_t":
		case "u16":
		case "unsigned short":
			return "u16";
		case "sint16":
		case "int16":
		case "int16_t":
		case "s16":
		case "short":
			return "i16";
		case "uint32":
		case "uint32_t":
		case "u32":
		case "unsigned int":
		case "unsigned long":
		case "unsigned":
			return "u32";
		case "sint32":
		case "int32":
		case "int32_t":
		case "s32":
		case "int":
		case "long":
			return "i32";
		case "uint64":
		case "uint64_t":
		case "u64":
		case "unsigned long long":
			return "u64";
		case "sint64":
		case "int64":
		case "int64_t":
		case "s64":
		case "long long":
			return "i64";
		case "float32":
		case "float":
		case "float32_t":
			return "f32";
		case "float64":
		case "double":
		case "float64_t":
			return "f64";
		default:
			return undefined;
	}
}

/** Byte width of a primitive (for `sizeof`). */
function primitiveWidthOf(prim: RichPrimitive): number {
	switch (prim) {
		case "u8":
		case "i8":
		case "bool":
		case "ascii":
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
		default:
			return 1;
	}
}

/** Strip block + line comments. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Unwrap AUTOSAR memory-class macros: `P2VAR(type, mem, cls)` → `type`,
 * `VAR(type, cls)` → `type`, etc. Also drop `volatile`. Applied before parsing.
 */
function stripMemClassMacros(src: string): string {
	let out = src;
	const wrappers = ["CONSTP2VAR", "CONSTP2CONST", "P2VAR", "P2CONST", "P2FUNC", "VAR", "CONST"];
	for (const w of wrappers) {
		// w(  type , … )  → type    (type is the first comma-separated argument)
		const re = new RegExp(w + "\\s*\\(\\s*([A-Za-z_][\\w ]*?)\\s*,[^()]*\\)", "g");
		out = out.replace(re, "$1");
	}
	return out.replace(/\bvolatile\b/g, " ");
}

/** Strip C integer suffixes and simple casts so an expr is evaluator-ready. */
function normalizeExpr(expr: string): string {
	let e = expr;
	// integer suffixes: 8u / 0x10UL / 3L → 8 / 0x10 / 3
	e = e.replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+/g, "$1");
	// C casts: (uint16) / (unsigned int) / (sint8) … → removed
	e = e.replace(
		/\(\s*(?:unsigned\s+|signed\s+)?(?:u?int(?:8|16|32|64)(?:_t)?|uint\d+|sint\d+|char|short|long|int|boolean|byte|float\d*)\s*\)/g,
		" ",
	);
	return e;
}

/** Collected preprocessor macros. */
interface Macros {
	obj: Map<string, string>;
	func: Map<string, { params: string[]; body: string }>;
}

/** Collect object + function `#define`s from the raw source. */
function collectMacros(raw: string): Macros {
	const obj = new Map<string, string>();
	const func = new Map<string, { params: string[]; body: string }>();
	// Join line continuations.
	const src = raw.replace(/\\\r?\n/g, " ");
	const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\([^)]*\))?[ \t]+(.+?)[ \t]*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const [, name, paramList, body] = m;
		// Strip a trailing comment from the body if any survived.
		const clean = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/, "").trim();
		if (paramList) {
			const params = paramList
				.slice(1, -1)
				.split(",")
				.map(p => p.trim())
				.filter(Boolean);
			func.set(name, { params, body: clean });
		} else if (clean.length) {
			obj.set(name, clean);
		}
	}
	return obj.size || func.size ? { obj, func } : { obj, func };
}

/** Parse-time context shared across the passes. */
interface Ctx {
	macros: Macros;
	enums: Set<string>;
	aggregates: Set<string>;
	/** Scalar/array typedef aliases: name → a field template to merge. */
	typedefs: Map<string, { type?: RichPrimitive; struct?: string; enumName?: string; dims?: number[] }>;
	structs: Record<string, NvmStructDef>;
	enumDefs: Record<string, NvmEnumDef>;
	diagnostics: string[];
}

/** Resolve a type token to a byte width, for `sizeof(T)`. */
function typeWidth(token: string, ctx: Ctx): number | undefined {
	const prim = mapCType(token);
	if (prim) {
		return primitiveWidthOf(prim);
	}
	if (ctx.enums.has(token)) {
		return 4;
	}
	const alias = ctx.typedefs.get(token);
	if (alias?.type) {
		return primitiveWidthOf(alias.type);
	}
	return undefined;
}

/** Evaluate an array-dimension expression (macros + `sizeof` substituted). */
function evalDim(expr: string, ctx: Ctx): number {
	let e = expr.trim();
	if (!e) {
		return 0;
	}
	// sizeof(T) → width
	e = e.replace(/sizeof\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (whole, t: string) => {
		const w = typeWidth(t, ctx);
		return w !== undefined ? String(w) : "sizeof_unresolved";
	});
	// Substitute object macros (a few fixed-point passes).
	for (let pass = 0; pass < 6; pass++) {
		let changed = false;
		e = e.replace(/[A-Za-z_]\w*/g, id => {
			if (id === "sizeof_unresolved") {
				return id;
			}
			const v = ctx.macros.obj.get(id);
			if (v !== undefined) {
				changed = true;
				return `(${v})`;
			}
			return id;
		});
		if (!changed) {
			break;
		}
	}
	e = normalizeExpr(e);
	try {
		const v = evaluateExpression(e);
		return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
	} catch {
		ctx.diagnostics.push(`array size "${expr.trim()}" could not be resolved (missing #define/sizeof?)`);
		return 0;
	}
}

/** Expand function macros + object macros in an enum initializer, then eval. */
function evalEnumInit(rhs: string, ctx: Ctx, scope: Record<string, number>): number | undefined {
	let e = rhs.trim();
	for (let pass = 0; pass < 6; pass++) {
		let changed = false;
		// Function-macro calls: NAME( args )
		e = e.replace(/([A-Za-z_]\w*)\s*\(([^()]*)\)/g, (whole, name: string, args: string) => {
			const fm = ctx.macros.func.get(name);
			if (!fm) {
				return whole;
			}
			changed = true;
			const actuals = args.split(",").map(a => a.trim());
			let body = fm.body;
			fm.params.forEach((p, i) => {
				body = body.replace(new RegExp(`\\b${p}\\b`, "g"), `(${actuals[i] ?? "0"})`);
			});
			return `(${body})`;
		});
		// Object macros
		e = e.replace(/[A-Za-z_]\w*/g, id => {
			const v = ctx.macros.obj.get(id);
			if (v !== undefined) {
				changed = true;
				return `(${v})`;
			}
			return id;
		});
		if (!changed) {
			break;
		}
	}
	e = normalizeExpr(e);
	try {
		return evaluateExpression(e, scope);
	} catch {
		return undefined;
	}
}

/** Find the index of the `}` matching the `{` at `open`. */
function matchBrace(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") {
			depth++;
		} else if (src[i] === "}") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return src.length - 1;
}

/** Split a struct/union body into top-level member declarations (by `;`). */
function splitMembers(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
		} else if (c === ";" && depth === 0) {
			const m = body.slice(start, i).trim();
			if (m) {
				out.push(m);
			}
			start = i + 1;
		}
	}
	const tail = body.slice(start).trim();
	if (tail) {
		out.push(tail);
	}
	return out;
}

/** Parse one member declaration into a field (may register anonymous types). */
function parseMember(decl: string, ctx: Ctx, parentName: string): NvmStructField | undefined {
	let s = decl.trim();
	if (!s) {
		return undefined;
	}
	s = s.replace(/^\s*(?:const|static|extern)\s+/g, "");

	// Anonymous nested struct/union member: `struct { … } name[dims]`.
	const anon = /^(struct|union)(?:\s+[A-Za-z_]\w*)?\s*\{/.exec(s);
	if (anon) {
		const openIdx = s.indexOf("{");
		const closeIdx = matchBrace(s, openIdx);
		const innerBody = s.slice(openIdx + 1, closeIdx);
		const after = s.slice(closeIdx + 1).trim(); // `name[dims]`
		const nm = /^([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)$/.exec(after);
		if (!nm) {
			return undefined;
		}
		const [, name, arrayPart] = nm;
		const synthName = `${parentName}__${name}`;
		const fields = parseMembers(innerBody, ctx, synthName);
		ctx.structs[synthName] = {
			name: synthName,
			layout: "c",
			union: anon[1] === "union",
			fields,
		};
		const field: NvmStructField = { name, struct: synthName };
		const dims = parseDims(arrayPart, ctx);
		if (dims.length) {
			field.dims = dims;
		}
		return field;
	}

	// Scalar / array / bitfield: `Type… name [dims] [: bits]`.
	let bits: number | undefined;
	const colon = s.indexOf(":");
	if (colon >= 0) {
		const b = parseInt(s.slice(colon + 1).trim(), 10);
		if (!Number.isNaN(b)) {
			bits = b;
		}
		s = s.slice(0, colon).trim();
	}
	let arrayPart = "";
	const arr = /((?:\[[^\]]*\])+)\s*$/.exec(s);
	if (arr) {
		arrayPart = arr[1];
		s = s.slice(0, arr.index).trim();
	}
	// Now that the (possibly `sizeof(...)`-bearing) array part is removed, reject
	// only genuine function-pointer / pointer members on the remaining `type name`.
	if (s.includes("(") || s.includes("*")) {
		return undefined;
	}
	const tokens = s.split(/\s+/).filter(Boolean);
	if (tokens.length < 2) {
		return undefined;
	}
	const name = tokens[tokens.length - 1];
	const typeToken = tokens.slice(0, -1).join(" ");
	const dims = parseDims(arrayPart, ctx);

	const field = resolveTypedField(typeToken, name, ctx);
	if (!field) {
		ctx.diagnostics.push(`unresolved type "${typeToken}" for field "${name}" in ${parentName}`);
		// Emit a struct-ref so the name is visible; the decoder may resolve it if
		// the user supplies the type via inline JSON (struct OR enum fallback).
		const ref: NvmStructField = { name, struct: typeToken };
		if (dims.length) {
			ref.dims = dims;
		}
		return ref;
	}
	if (bits !== undefined) {
		field.bits = bits;
	}
	// Merge field dims with any typedef-alias dims (alias dims are outermost).
	if (dims.length || field.dims) {
		field.dims = [...dims, ...(field.dims ?? [])];
	}
	field.name = name;
	return field;
}

/** Resolve a type token to a field template (primitive/enum/struct/typedef). */
function resolveTypedField(typeToken: string, name: string, ctx: Ctx): NvmStructField | undefined {
	// char[] arrays are handled as ascii at the caller via type "ascii".
	const prim = mapCType(typeToken);
	if (prim) {
		return { name, type: prim };
	}
	if (ctx.enums.has(typeToken)) {
		return { name, type: "u32", compu: { enum: typeToken } };
	}
	if (ctx.aggregates.has(typeToken)) {
		return { name, struct: typeToken };
	}
	const alias = ctx.typedefs.get(typeToken);
	if (alias) {
		const f: NvmStructField = { name };
		if (alias.type) {
			f.type = alias.type;
		}
		if (alias.struct) {
			f.struct = alias.struct;
		}
		if (alias.enumName) {
			f.type = "u32";
			f.compu = { enum: alias.enumName };
		}
		if (alias.dims) {
			f.dims = [...alias.dims];
		}
		return f;
	}
	return undefined;
}

/** Parse `[a][b]` into resolved numeric dimensions. */
function parseDims(arrayPart: string, ctx: Ctx): number[] {
	const dims: number[] = [];
	const re = /\[([^\]]*)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(arrayPart))) {
		dims.push(evalDim(m[1], ctx));
	}
	return dims;
}

/** Parse a struct/union body into fields (char[] → ascii applied here). */
function parseMembers(body: string, ctx: Ctx, parentName: string): NvmStructField[] {
	const fields: NvmStructField[] = [];
	for (const decl of splitMembers(body)) {
		const field = parseMember(decl, ctx, parentName);
		if (!field) {
			continue;
		}
		// `char name[N]` → an ascii string of N bytes (not an array of i8).
		if (field.type === "ascii" && field.dims && field.dims.length === 1) {
			const n = field.dims[0];
			field.size = typeof n === "number" ? n : undefined;
			delete field.dims;
		}
		fields.push(field);
	}
	return fields;
}

/** Split an enum body by top-level commas (commas inside `()` stay together). */
function splitEnumItems(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === "(") {
			depth++;
		} else if (c === ")") {
			depth--;
		} else if (c === "," && depth === 0) {
			out.push(body.slice(start, i));
			start = i + 1;
		}
	}
	out.push(body.slice(start));
	return out;
}

/** Parse one enum body into a value→name table. */
function parseEnumBody(body: string, ctx: Ctx): Record<string, string> {
	const values: Record<string, string> = {};
	const scope: Record<string, number> = {};
	let next = 0;
	for (const rawItem of splitEnumItems(body)) {
		const item = rawItem.trim();
		if (!item) {
			continue;
		}
		const eq = item.indexOf("=");
		let ident: string;
		let value: number | undefined;
		if (eq >= 0) {
			ident = item.slice(0, eq).trim();
			value = evalEnumInit(item.slice(eq + 1), ctx, scope);
			if (value === undefined) {
				ctx.diagnostics.push(`enum "${ident}" has an unresolvable value; skipped`);
				continue;
			}
		} else {
			ident = item;
			value = next;
		}
		if (/^[A-Za-z_]\w*$/.test(ident) && value !== undefined) {
			values[String(value)] = ident;
			scope[ident] = value;
			next = value + 1;
		}
	}
	return values;
}

/** A located brace-bodied declaration. */
interface Decl {
	kind: "struct" | "union" | "enum";
	tag?: string;
	body: string;
	/** Trailing text between `}` and `;` — the typedef Name (aggregates). */
	name: string;
	isTypedef: boolean;
}

/** Scan top-level `[typedef] struct/union/enum [tag] { … } Name;` decls. */
function scanDecls(src: string): Decl[] {
	const decls: Decl[] = [];
	const opener = /(typedef\s+)?(struct|union|enum)(?:\s+([A-Za-z_]\w*))?\s*\{/g;
	let m: RegExpExecArray | null;
	let from = 0;
	while ((m = opener.exec(src)) && from <= src.length) {
		if (m.index < from) {
			continue;
		}
		const openIdx = src.indexOf("{", m.index);
		const closeIdx = matchBrace(src, openIdx);
		const semi = src.indexOf(";", closeIdx);
		const name = src.slice(closeIdx + 1, semi === -1 ? undefined : semi).trim();
		decls.push({
			kind: m[2] as Decl["kind"],
			tag: m[3],
			body: src.slice(openIdx + 1, closeIdx),
			name,
			isTypedef: !!m[1],
		});
		from = (semi === -1 ? closeIdx : semi) + 1;
		opener.lastIndex = from;
	}
	return decls;
}

/** Collect scalar/array typedef aliases: `typedef Base Name[dims];`. */
function collectScalarTypedefs(src: string, ctx: Ctx): void {
	// Exclude the struct/union/enum forms (those have braces, handled elsewhere).
	const re = /typedef\s+((?:unsigned\s+|signed\s+)?[A-Za-z_][\w ]*?)\s+([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)\s*;/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const base = m[1].trim();
		const name = m[2];
		const arrayPart = m[3];
		if (/\b(struct|union|enum)\b/.test(base)) {
			continue;
		}
		const dims = parseDims(arrayPart, ctx);
		const prim = mapCType(base);
		if (prim) {
			ctx.typedefs.set(name, { type: prim, dims: dims.length ? dims : undefined });
		} else if (ctx.enums.has(base)) {
			ctx.typedefs.set(name, { enumName: base, dims: dims.length ? dims : undefined });
		} else if (ctx.aggregates.has(base)) {
			ctx.typedefs.set(name, { struct: base, dims: dims.length ? dims : undefined });
		} else {
			// Alias to another (possibly not-yet-seen) alias — chain-resolve later.
			const chain = ctx.typedefs.get(base);
			if (chain) {
				ctx.typedefs.set(name, { ...chain, dims: dims.length ? dims : chain.dims });
			}
		}
	}
}

/**
 * AUTOSAR type names use both `_t_` and `_te_` infixes inconsistently (a known
 * generator quirk — e.g. a field typed `FS_Reset_te_ResetReason` referencing an
 * enum typedef'd `FS_Reset_t_ResetReason`). Register/resolve enums under both
 * spellings so such fields still bind.
 */
function enumSpellings(name: string): string[] {
	const out = [name];
	if (name.includes("_te_")) {
		out.push(name.replace("_te_", "_t_"));
	} else if (name.includes("_t_")) {
		out.push(name.replace("_t_", "_te_"));
	}
	return out;
}

/** Result of {@link parseCStructsEx}. */
export interface ParseCStructsResult {
	catalog: NvmStructCatalog;
	diagnostics: string[];
}

/**
 * Parse generated C source into a struct + enum catalog, with diagnostics for
 * anything that could not be resolved (missing size macros, unevaluable enum
 * values, unknown field types). Never throws.
 */
export function parseCStructsEx(source: string): ParseCStructsResult {
	if (!source) {
		return { catalog: { structs: {}, enums: {} }, diagnostics: [] };
	}
	const macros = collectMacros(source);
	const clean = stripMemClassMacros(stripComments(source));
	const decls = scanDecls(clean);

	const ctx: Ctx = {
		macros,
		enums: new Set(),
		aggregates: new Set(),
		typedefs: new Map(),
		structs: {},
		enumDefs: {},
		diagnostics: [],
	};

	// Pass 1: register all names so field-type classification can see forward refs.
	for (const d of decls) {
		if (d.kind === "enum" && d.name) {
			for (const alias of enumSpellings(d.name)) {
				ctx.enums.add(alias);
			}
			if (d.tag) {
				ctx.enums.add(d.tag);
			}
		} else if ((d.kind === "struct" || d.kind === "union") && d.name) {
			ctx.aggregates.add(d.name);
			if (d.tag) {
				ctx.aggregates.add(d.tag);
			}
		}
	}
	collectScalarTypedefs(clean, ctx);
	// Scalar typedef targets that are themselves enums/aggregates registered above.

	// Pass 2: enums (may be referenced by struct fields).
	for (const d of decls) {
		if (d.kind !== "enum" || !d.name) {
			continue;
		}
		const values = parseEnumBody(d.body, ctx);
		if (Object.keys(values).length) {
			for (const alias of enumSpellings(d.name)) {
				ctx.enumDefs[alias] = { name: alias, values, width: 4 };
			}
			if (d.tag) {
				ctx.enumDefs[d.tag] = { name: d.tag, values, width: 4 };
			}
		}
	}

	// Pass 3: structs / unions.
	for (const d of decls) {
		if (d.kind === "enum" || !d.name) {
			continue;
		}
		const fields = parseMembers(d.body, ctx, d.name);
		if (!fields.length) {
			continue;
		}
		const def: NvmStructDef = {
			name: d.name,
			layout: "c",
			union: d.kind === "union",
			fields,
		};
		ctx.structs[d.name] = def;
		if (d.tag && !ctx.structs[d.tag]) {
			ctx.structs[d.tag] = { ...def, name: d.tag };
		}
	}

	// Grouped `#define NAME <int>` runs → enums (fallback naming tables).
	for (const [k, v] of Object.entries(parseDefineEnums(source))) {
		if (!ctx.enumDefs[k]) {
			ctx.enumDefs[k] = v;
		}
	}

	return {
		catalog: { structs: ctx.structs, enums: ctx.enumDefs },
		diagnostics: ctx.diagnostics,
	};
}

/** Parse generated C source into a struct + enum catalog (back-compat wrapper). */
export function parseCStructs(source: string): NvmStructCatalog {
	return parseCStructsEx(source).catalog;
}

/**
 * Group `#define NAME <int>` runs that share a prefix (up to the last `_`) into
 * one enum keyed by that prefix. Values that are not plain integer literals are
 * ignored (they are not scrapeable — supply them via inline JSON instead).
 */
function parseDefineEnums(rawSrc: string): Record<string, NvmEnumDef> {
	const groups = new Map<string, Record<string, string>>();
	const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([^\s/]+)/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rawSrc))) {
		const name = m[1];
		const t = m[2].trim().replace(/[uUlL]+$/, "");
		const value = /^0[xX][0-9a-fA-F]+$/.test(t)
			? parseInt(t, 16)
			: /^-?\d+$/.test(t)
				? parseInt(t, 10)
				: undefined;
		if (value === undefined) {
			continue;
		}
		const us = name.lastIndexOf("_");
		if (us <= 0) {
			continue;
		}
		const prefix = name.slice(0, us);
		let g = groups.get(prefix);
		if (!g) {
			g = {};
			groups.set(prefix, g);
		}
		g[String(value)] = name;
	}
	const out: Record<string, NvmEnumDef> = {};
	for (const [prefix, values] of groups) {
		if (Object.keys(values).length >= 2) {
			out[prefix] = { name: prefix, values, width: 4 };
		}
	}
	return out;
}
