// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Business-struct binding + decoding for the Vector FEE V3 engine.
 *
 * This is where the engine — NOT the plugin core — decides how to turn a bound
 * block's payload into a decoded value tree. It:
 *
 * 1. builds a struct/enum catalog from the sources the descriptor declared
 *    (generated C headers, ARXML, or inline JSON), via the injected SDK, and
 * 2. resolves each block↔struct binding (by name / glob / tag / identity) and
 *    decodes the matched block's business payload.
 *
 * Everything vendor-specific about "which block means what" lives in config
 * here; the SDK primitives it calls are generic. Requires SDK v3
 * (`sdk.decodeStructRich`); on an older SDK this module is a no-op.
 */

import { EngineSdk, NvmDecodedNode, NvmStructCatalog } from "./types";

/** One block↔struct binding from `options.blockStructs`. */
export interface BlockStructBinding {
	match: {
		/** Exact block name (as resolved from Fee_Lcfg / the tag fallback). */
		name?: string;
		/** Case-insensitive `*` glob on the block name. */
		nameGlob?: string;
		/** FEE block tag (== Fee_Lcfg BlkIdx). */
		tag?: number;
		/** Logical identity key, e.g. "tag:0x31". */
		identity?: string;
	};
	/** Struct name to decode the payload with (must exist in the catalog). */
	struct: string;
	/** Optional cap on decoded nodes for this binding. */
	maxNodes?: number;
}

/** Struct-decoding configuration carried in the descriptor `options`. */
export interface FeeV3StructOptions {
	/** Inline struct + enum catalog (JSON). */
	structCatalog?: unknown;
	/** Logical source names (declared in `sources`) to parse into the catalog. */
	structs?: { fromSources?: string[] };
	/** Block↔struct bindings; the engine's decision on business meaning. */
	blockStructs?: BlockStructBinding[];
	/**
	 * Also decode historical (stale) copies of bound blocks, not just the current
	 * version. Defaults to `false` — decoding only the latest keeps the payload
	 * lean. Set `true` for history analysis (compare a block across its versions).
	 */
	decodeStale?: boolean;
}

/** Compiled matcher + catalog, or `undefined` when nothing is configured. */
export interface FeeV3StructResolver {
	catalog: NvmStructCatalog;
	bindings: BlockStructBinding[];
	sdk: EngineSdk;
	/** When false, only current (non-stale) bound blocks are decoded. */
	decodeStale: boolean;
}

/** Turn a `*` glob into a case-insensitive anchored RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/** Detect an ARXML/XML source by a cheap content sniff. */
function looksLikeXml(content: string): boolean {
	const head = content.slice(0, 512);
	return head.includes("<AUTOSAR") || head.includes("<?xml") || head.includes("<ARXML");
}

/**
 * Build a resolver from the struct options + the declared sources. Returns
 * `undefined` when struct decoding is not configured or the SDK is too old.
 */
export function buildStructResolver(
	sdk: EngineSdk,
	sources: Record<string, string>,
	options: FeeV3StructOptions,
): FeeV3StructResolver | undefined {
	const bindings = options.blockStructs;
	if (!bindings || bindings.length === 0) {
		return undefined;
	}
	// Requires the v3 struct-decoding surface.
	if (
		typeof sdk.version !== "number" ||
		sdk.version < 3 ||
		typeof sdk.decodeStructRich !== "function" ||
		typeof sdk.mergeCatalogs !== "function"
	) {
		return undefined;
	}

	const parts: NvmStructCatalog[] = [];
	// Inline JSON catalog first (lowest precedence — later parts fill/override).
	if (options.structCatalog && typeof sdk.parseStructCatalog === "function") {
		parts.push(sdk.parseStructCatalog(options.structCatalog));
	}
	// C headers are CONCATENATED and parsed together so #define / typedef / enum
	// definitions in one header resolve references in another (e.g. the size
	// macros in FS_SafeSection_Prv.h feed the arrays in FS_SafeSection_Types.h).
	// ARXML sources are parsed individually.
	const fromSources = options.structs?.fromSources ?? [];
	const cHeaders: string[] = [];
	for (const logical of fromSources) {
		const content = sources[logical];
		if (!content) {
			continue;
		}
		if (looksLikeXml(content)) {
			if (typeof sdk.arxmlStructs === "function") {
				parts.push(sdk.arxmlStructs(content));
			}
		} else {
			cHeaders.push(content);
		}
	}
	if (cHeaders.length) {
		const merged = cHeaders.join("\n");
		if (typeof sdk.parseCStructsEx === "function") {
			const { catalog, diagnostics } = sdk.parseCStructsEx(merged);
			parts.push(catalog);
			if (diagnostics.length && typeof console !== "undefined") {
				// Surface unresolved macros / types so the user can supply them as
				// inline JSON. Cap to avoid flooding the console.
				console.warn(
					`[vector-fee-v3] struct source diagnostics (${diagnostics.length}); first few:`,
					diagnostics.slice(0, 8),
				);
			}
		} else if (typeof sdk.parseCStructs === "function") {
			parts.push(sdk.parseCStructs(merged));
		}
	}

	// The inline JSON catalog is applied LAST as well, so explicit user overrides
	// (union discriminators, format bindings, gap-fill enums) win over parsed C.
	let overlay: NvmStructCatalog | undefined;
	if (options.structCatalog && typeof sdk.parseStructCatalog === "function") {
		overlay = sdk.parseStructCatalog(options.structCatalog);
	}
	const catalog = overlay
		? mergeCatalogsDeep(sdk, sdk.mergeCatalogs(...parts), overlay)
		: sdk.mergeCatalogs(...parts);
	return { catalog, bindings, sdk, decodeStale: options.decodeStale === true };
}

/**
 * Deep-merge the inline JSON overlay onto the parsed catalog: parsed structs are
 * the base (full field layout from C), and the overlay patches individual struct
 * fields by name (to attach `format` / `discriminator` / `cases` without
 * re-listing every field) and adds/overrides enums. A struct present ONLY in the
 * overlay is added whole.
 */
function mergeCatalogsDeep(
	sdk: EngineSdk,
	base: NvmStructCatalog,
	overlay: NvmStructCatalog,
): NvmStructCatalog {
	const out: NvmStructCatalog = {
		structs: { ...base.structs },
		enums: { ...base.enums, ...overlay.enums },
	};
	for (const [name, ov] of Object.entries(overlay.structs)) {
		const existing = out.structs[name];
		if (!existing) {
			out.structs[name] = ov as never;
			continue;
		}
		// Patch fields by name; append overlay-only fields.
		const merged = { ...(existing as Record<string, unknown>) } as {
			fields: { name: string }[];
		} & Record<string, unknown>;
		const fields = [...((existing as { fields: { name: string }[] }).fields ?? [])];
		const ovFields = (ov as { fields?: { name: string }[] }).fields ?? [];
		for (const of of ovFields) {
			const idx = fields.findIndex(f => f.name === of.name);
			if (idx >= 0) {
				fields[idx] = { ...fields[idx], ...of };
			} else {
				fields.push(of);
			}
		}
		merged.fields = fields;
		// Copy struct-level overlay keys (layout/union/endian) if present.
		for (const k of ["layout", "union", "endian"] as const) {
			if ((ov as Record<string, unknown>)[k] !== undefined) {
				merged[k] = (ov as Record<string, unknown>)[k];
			}
		}
		out.structs[name] = merged as never;
	}
	return out;
}

/** The block facts a binding can match against. */
export interface BlockMatchInfo {
	name: string;
	tag: number;
	identityKey: string;
}

/** Find the first binding that matches a block, or `undefined`. */
export function matchBinding(
	resolver: FeeV3StructResolver,
	info: BlockMatchInfo,
): BlockStructBinding | undefined {
	for (const b of resolver.bindings) {
		const m = b.match;
		if (m.tag !== undefined && m.tag === info.tag) {
			return b;
		}
		if (m.name !== undefined && m.name === info.name) {
			return b;
		}
		if (m.identity !== undefined && m.identity === info.identityKey) {
			return b;
		}
		if (m.nameGlob !== undefined && globToRegExp(m.nameGlob).test(info.name)) {
			return b;
		}
	}
	return undefined;
}

/**
 * Decode a bound block's payload into a value tree. `payloadBytes` is the flat
 * image slice `[payloadOffset, payloadOffset+netLength)`; `baseOffset` is the
 * absolute editor offset of that slice's first byte. Returns `undefined` when
 * the bound struct is unknown or decoding produces nothing.
 */
export function decodeBoundBlock(
	resolver: FeeV3StructResolver,
	binding: BlockStructBinding,
	payloadBytes: Uint8Array,
	baseOffset: number,
): NvmDecodedNode[] | undefined {
	const def = resolver.catalog.structs[binding.struct];
	if (!def) {
		return [
			{
				name: binding.struct,
				type: "note",
				offset: baseOffset,
				length: 0,
				value: `<struct "${binding.struct}" not found in catalog>`,
			},
		];
	}
	const nodes = resolver.sdk.decodeStructRich!(payloadBytes, def, {
		baseOffset,
		catalog: resolver.catalog,
		maxNodes: binding.maxNodes,
	});
	return nodes.length ? nodes : undefined;
}
