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

/** One NVM block returned to the editor. */
export interface NvmBlock {
	id: string;
	name?: string;
	offset: number;
	length: number;
	raw?: unknown;
	fields?: NvmField[];
}

/** The generic bundle the editor gathers and hands to `parse`. */
export interface LayoutInput {
	fileName: string;
	ext: string;
	text: string;
	sources: Record<string, string>;
	arxml?: string;
	configs: unknown[];
}

/** The stable, versioned primitive API the editor injects. */
export interface EngineSdk {
	readonly version: number;
	loadHexImage(text: string): HexImage;
	resolveFieldLink?: unknown;
	[key: string]: unknown;
}

/** The object `createEngine(sdk)` must return. */
export interface Engine {
	id: string;
	parse(input: LayoutInput, options?: Record<string, unknown>): NvmBlock[];
}
