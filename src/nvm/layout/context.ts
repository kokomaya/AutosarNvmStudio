// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vendor-blind resolution context + capability registries.
 *
 * The core no longer speaks in terms of file formats (S-record, arxml, xdm) or
 * vendors. It resolves a small set of **capabilities** through pluggable
 * adapters and hands layout / struct providers a normalized {@link ResolveContext}:
 *
 *   raw dump  --(image adapter)-->  ImageData
 *   sources/configs/arxml  --(symbol adapter)-->  SymbolTable
 *   ImageData + configs  --(layout provider)-->  NvmBlockInfo[]
 *
 * Adapters carry all the "where did this come from" knowledge; the core only
 * knows the contracts (`shared/nvm/capabilities.ts`).
 */

import { ImageData, SymbolTable } from "../../../shared/nvm";
import { LayoutConfig } from "./provider";

/** The minimal identity of the opened file, used by `match` gates + adapters. */
export interface FileRef {
	/** Lower-cased base file name (e.g. `nvm_test.mot`). */
	fileName: string;
	/** Lower-cased extension including the dot (e.g. `.mot`). */
	ext: string;
}

/** The raw dump handed to `image` adapters before it is decoded. */
export interface RawDump extends FileRef {
	/** Raw dump text for text container formats (S-record / Intel HEX). */
	text: string;
}

/**
 * Everything a `symbols` adapter may look at to emit a {@link SymbolTable}. The
 * core does not know which of these an adapter uses (source files live in
 * `sources`, AUTOSAR config in `arxml`, …) — it just asks for symbols.
 */
export interface SymbolContext extends FileRef {
	image: ImageData;
	configs: LayoutConfig[];
	sources: Record<string, string>;
	/** Nearby AUTOSAR config content, for adapters that consume it. */
	arxml?: string;
}

/**
 * The normalized, vendor-blind bundle handed to every layout / struct provider.
 * There is no `text` and no `arxml` here: the image is already decoded and any
 * symbol knowledge is reached lazily through {@link symbols}.
 */
export interface ResolveContext extends FileRef {
	/** The decoded image (produced once by an `image` adapter). */
	image: ImageData;
	/** Layout descriptors (`*.nvmlayout.json`) discovered near the file. */
	configs: LayoutConfig[];
	/** Resolved auxiliary source files, keyed by the logical name declared. */
	sources: Record<string, string>;
	/** Lazily resolve (and cache) the `symbols` capability; undefined if none. */
	symbols(): SymbolTable | undefined;
}

// --- image capability -------------------------------------------------------

/** An adapter that decodes a raw dump into an {@link ImageData}. */
export interface ImageProvider {
	id: string;
	detect(dump: RawDump): boolean;
	provide(dump: RawDump): ImageData;
}

const imageProviders: ImageProvider[] = [];

/** Register an image adapter. Later-registered adapters are tried first. */
export function registerImageProvider(provider: ImageProvider): void {
	if (!imageProviders.some(p => p.id === provider.id)) {
		imageProviders.unshift(provider);
	}
}

/** Resolve the first image adapter that applies. Throwers are skipped. */
export function resolveImage(dump: RawDump): ImageData | undefined {
	for (const provider of imageProviders) {
		try {
			if (provider.detect(dump)) {
				return provider.provide(dump);
			}
		} catch {
			// Isolate adapter failures so one bad decoder can't break others.
		}
	}
	return undefined;
}

// --- symbols capability -----------------------------------------------------

/** An adapter that emits a {@link SymbolTable} from the available inputs. */
export interface SymbolProvider {
	id: string;
	detect(ctx: SymbolContext): boolean;
	provide(ctx: SymbolContext): SymbolTable | undefined;
}

const symbolProviders: SymbolProvider[] = [];

/** Register a symbol adapter. Later-registered adapters are tried first. */
export function registerSymbolProvider(provider: SymbolProvider): void {
	if (!symbolProviders.some(p => p.id === provider.id)) {
		symbolProviders.unshift(provider);
	}
}

/**
 * Resolve symbols by merging every adapter that applies: the first adapter to
 * define an id wins, later adapters only fill gaps. Returns undefined when no
 * adapter contributed anything.
 */
export function resolveSymbols(ctx: SymbolContext): SymbolTable | undefined {
	let merged: SymbolTable | undefined;
	for (const provider of symbolProviders) {
		try {
			if (!provider.detect(ctx)) {
				continue;
			}
			const table = provider.provide(ctx);
			if (!table || table.byId.size === 0) {
				continue;
			}
			if (!merged) {
				merged = { byId: new Map(table.byId) };
			} else {
				for (const [id, entry] of table.byId) {
					if (!merged.byId.has(id)) {
						merged.byId.set(id, entry);
					}
				}
			}
		} catch {
			// Isolate adapter failures.
		}
	}
	return merged;
}
