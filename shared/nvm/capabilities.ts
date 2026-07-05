// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vendor-blind capability contracts.
 *
 * The plugin core understands only a small set of normalized "capabilities"
 * and waits for adapters to produce them. Nothing here names a file format
 * (S-record, arxml, xdm, …) or a vendor: those concepts live entirely in the
 * adapters that emit these contracts. See docs/nvm-capabilities.md.
 *
 * This module is pure data (no `src/` or Node imports) so it is safe in both
 * the desktop and web builds and in the shared engine SDK.
 */

/**
 * The raw memory image a dump decodes to. `baseAddress` is the absolute address
 * that maps to editor byte offset 0 (the flattened image the editor serves).
 * Produced by an `image` capability adapter from whatever container the dump
 * happens to be (S-record / Intel HEX / raw bin / …).
 */
export interface ImageData {
	bytes: Uint8Array;
	baseAddress: number;
}

/** One resolved symbol (a named, sized logical entity in the image). */
export interface SymbolEntry {
	/** Stable id used to correlate with layout blocks (e.g. a block index/tag). */
	id: number | string;
	name: string;
	/** Declared length in bytes, when known. */
	length?: number;
	/** Free-form type name, when known (e.g. an application data type). */
	type?: string;
	/** Dataset / instance index for multi-instance blocks, when known. */
	datasetIndex?: number;
}

/**
 * A normalized symbol table. Adapters that read source files, AUTOSAR config,
 * map files or debug info all emit this same shape; the core never learns where
 * it came from.
 */
export interface SymbolTable {
	byId: Map<number | string, SymbolEntry>;
}

/** The capabilities the core can ask an adapter to provide. */
export type CapabilityName = "image" | "symbols" | "layout" | "struct" | "annotations";

/** An empty, ready-to-fill symbol table. */
export function emptySymbolTable(): SymbolTable {
	return { byId: new Map() };
}

/** Build a symbol table from a flat list, keyed by `id`. */
export function symbolTableFrom(entries: readonly SymbolEntry[]): SymbolTable {
	const byId = new Map<number | string, SymbolEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}
	return { byId };
}
