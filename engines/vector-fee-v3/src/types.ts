// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Local, self-contained type definitions for the Vector FEE V3 engine pack.
 *
 * This engine is loaded at runtime by the hex editor and receives a stable
 * {@link EngineSdk}. It deliberately imports NOTHING from the extension so the
 * pack is fully portable — generic primitives come from `sdk`, everything
 * Vector-specific lives in this folder.
 */

/** Decoded sparse image handed back by `sdk.loadHexImage`. */
export interface HexImage {
	/** Number of bytes spanned by the decoded image. */
	readonly span: number;
	/** Flatten to a contiguous buffer; `baseAddress` maps to editor offset 0. */
	toFlat(fill: number): { baseAddress: number; bytes: Uint8Array };
}

/** A colored sub-range (attribute) of a block, in editor byte space. */
export interface NvmField {
	name: string;
	kind: string;
	offset: number;
	length: number;
	color?: string;
	unit?: string;
	link?: { targetOffset: number; label?: string };
}

/** A vendor-neutral display attribute (one "column" in the editor's Blocks views). */
export interface NvmAttribute {
	key: string;
	label: string;
	value: string | number | boolean;
	kind?: string;
}

/**
 * One node of a business-decoded value tree (mirror of the editor's
 * `NvmDecodedNode`). Offsets are absolute editor byte offsets. The editor
 * renders this opaquely; the engine fills it via `sdk.decodeStructRich`.
 */
export interface NvmDecodedNode {
	name: string;
	type: string;
	offset: number;
	length: number;
	raw?: number | string;
	value?: number | string | boolean;
	unit?: string;
	enumLabel?: string;
	hex?: string;
	bits?: { width: number; offset: number };
	children?: NvmDecodedNode[];
}

/** One NVM block returned to the editor. */
export interface NvmBlock {
	id: string;
	name?: string;
	offset: number;
	length: number;
	raw?: unknown;
	fields?: NvmField[];
	/** Grouping bucket (e.g. a sector) for the editor's "group by sector" view. */
	group?: { key: string; label: string; order?: number };
	/** Best-effort write-order hint (higher = later); omit when not derivable. */
	sequence?: number;
	/** Logical identity shared with this block's other versions/copies. */
	identity?: { key: string; label: string };
	/** True when this is the newest instance of its {@link identity}. */
	isLatest?: boolean;
	/** Vendor-neutral display attributes (the editor's configurable columns). */
	attributes?: NvmAttribute[];
	/** Business-decoded value tree (set only for blocks bound to a struct). */
	decoded?: NvmDecodedNode[];
}

/** The generic bundle the editor gathers and hands to `parse`. */
export interface LayoutInput {
	fileName: string;
	ext: string;
	text: string;
	sources: Record<string, string>;
	arxml?: string;
	configs: unknown[];
	/**
	 * Opaque result of the descriptor's optional project-local `hookScript`
	 * (parsed by the core, shape known only to the engine). Undefined when no
	 * hook ran. Vendor-blind at the core boundary.
	 */
	hookData?: unknown;
}

/**
 * Minimal mirror of the editor's rich struct types (the pieces this engine
 * touches). The authoritative definitions live in `shared/nvm/structRich.ts`;
 * these are structural duplicates so the pack stays self-contained.
 */
export interface NvmStructCatalog {
	structs: Record<string, unknown>;
	enums: Record<string, unknown>;
}

export interface DecodeRichOpts {
	baseOffset: number;
	catalog: NvmStructCatalog;
	maxNodes?: number;
}

/** The stable, versioned primitive API the editor injects. */
export interface EngineSdk {
	readonly version: number;
	loadHexImage(text: string): HexImage;
	resolveFieldLink?: unknown;
	// --- rich business-struct decoding (SDK v3+; guarded by `version >= 3`) ---
	decodeStructRich?(
		bytes: Uint8Array,
		def: unknown,
		opts: DecodeRichOpts,
	): NvmDecodedNode[];
	parseStructCatalog?(json: unknown): NvmStructCatalog;
	mergeCatalogs?(...catalogs: NvmStructCatalog[]): NvmStructCatalog;
	parseCStructs?(source: string): NvmStructCatalog;
	parseCStructsEx?(source: string): { catalog: NvmStructCatalog; diagnostics: string[] };
	arxmlStructs?(xmlText: string): NvmStructCatalog;
	/** SDK v4+: scrape `#define <prefix><NAME> <int>` into a value→name map. */
	parseDefineEnum?(source: string, prefix: string): { values: Record<string, string> };
	[key: string]: unknown;
}

/** The object `createEngine(sdk)` must return. */
export interface Engine {
	id: string;
	parse(input: LayoutInput, options?: Record<string, unknown>): NvmBlock[];
}
