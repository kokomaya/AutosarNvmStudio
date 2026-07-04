// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Vendor-neutral NVM layout provider framework.
 *
 * The core editor knows nothing about any specific vendor's on-flash layout.
 * Each layout (Vector FEE V3 linked-list, a top-down sequential dump, a
 * dual-ended ring, …) is implemented as an independent {@link NvmLayoutProvider}
 * and registered here. Providers may be code (a `.ts` file that implements the
 * interface) or driven entirely by a user-supplied JSON descriptor
 * (see `configLayout.ts`), so new vendors can be added without touching core.
 */

import { NvmBlockInfo } from "../../../shared/protocol";

/** A vendor layout descriptor, typically loaded from a `*.nvmlayout.json`. */
export interface LayoutConfig {
	/** Human-readable vendor / format name. */
	vendor: string;
	/** Optional gating so a descriptor only applies to matching files. */
	match?: {
		/** File extensions (with dot) this descriptor applies to. */
		ext?: string[];
		/** Substrings that must appear in the file name (case-insensitive). */
		fileNameIncludes?: string[];
	};
	/** Absolute base address that maps to editor offset 0 (default: image base). */
	baseAddress?: number;
	/** How auto-placed blocks are arranged when they omit an explicit offset. */
	arrangement?: "sequential" | "dualEnded";
	blocks: LayoutBlockDef[];
}

export interface LayoutBlockDef {
	name: string;
	length: number;
	/** Explicit editor byte offset; when omitted, placed per `arrangement`. */
	offset?: number;
	/** For `dualEnded`: grow from the top (default) or the bottom of the image. */
	from?: "top" | "bottom";
	fields?: LayoutFieldDef[];
}

export interface LayoutFieldDef {
	name: string;
	kind: string;
	/** Offset relative to the block start. */
	offset: number;
	length: number;
}

/** Everything a provider needs to decide on and parse an opened file. */
export interface LayoutInput {
	/** Lower-cased base file name (e.g. `nvm_test.mot`). */
	fileName: string;
	/** Lower-cased extension including the dot (e.g. `.mot`). */
	ext: string;
	/** Raw file text for S-record / Intel HEX inputs. */
	text: string;
	/** Generated `Fee_Lcfg.c` content, when found near the file. */
	feeLcfgSource?: string;
	/** Vendor descriptors discovered near the file. */
	configs: LayoutConfig[];
}

export interface NvmLayoutProvider {
	/** Stable id, e.g. `vector-fee-v3`. */
	id: string;
	/** Human-readable label. */
	label: string;
	/** Cheap check whether this provider might handle the input. */
	detect(input: LayoutInput): boolean;
	/** Produce blocks; return an empty array when it turns out not to apply. */
	parse(input: LayoutInput): NvmBlockInfo[];
}

const providers: NvmLayoutProvider[] = [];

/** Register a layout provider. Later-registered providers are tried first. */
export function registerLayoutProvider(provider: NvmLayoutProvider): void {
	if (!providers.some(p => p.id === provider.id)) {
		providers.unshift(provider);
	}
}

export function getLayoutProviders(): readonly NvmLayoutProvider[] {
	return providers;
}

export interface ResolvedLayout {
	providerId: string;
	blocks: NvmBlockInfo[];
}

/**
 * Run the registered providers against the input and return the first that
 * yields at least one block. Providers are isolated: a throwing provider is
 * skipped rather than aborting the whole resolution.
 */
export function resolveNvmBlocks(input: LayoutInput): ResolvedLayout | undefined {
	for (const provider of providers) {
		try {
			if (!provider.detect(input)) {
				continue;
			}
			const blocks = provider.parse(input);
			if (blocks.length > 0) {
				return { providerId: provider.id, blocks };
			}
		} catch {
			// Isolate provider failures so one bad vendor plug-in can't break others.
		}
	}
	return undefined;
}
