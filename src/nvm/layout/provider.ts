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

import { FieldLinkSpec } from "../../../shared/nvm";
import { NvmBlockInfo } from "../../../shared/protocol";

/** A vendor layout descriptor, typically loaded from a `*.nvmlayout.json`. */
export interface LayoutConfig {
	/** Human-readable vendor / format name. */
	vendor: string;
	/**
	 * Selects a built-in code provider to run with `options` instead of using the
	 * config's own `blocks`. E.g. `"vector-fee-v3"` to tune the Vector parser.
	 */
	provider?: string;
	/**
	 * Path to an **external engine script** (relative to the descriptor / dump),
	 * e.g. `"./vectorFeeV3.engine.js"`. Desktop-only and gated behind Workspace
	 * Trust + the `hexeditor.nvm.allowExternalEngines` setting + a per-file
	 * confirmation, because it executes workspace JavaScript. See
	 * `src/nvm/layout/externalEngine.ts`.
	 */
	engineScript?: string;
	/** Free-form options passed to the selected built-in `provider` (engine). */
	options?: Record<string, unknown>;
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
	/** Explicit block layout (required unless a built-in `provider` is selected). */
	blocks?: LayoutBlockDef[];
	/**
	 * Auxiliary source/config files this descriptor's adapter needs, as
	 * `logicalName -> fileName`. The core resolves each file (searching the dump
	 * folder, `./conf/`, `../conf/`) and exposes the content on
	 * {@link LayoutInput.sources} keyed by the same logical name. This keeps the
	 * core vendor-agnostic — e.g. Vector declares `{ "feeLcfg": "Fee_Lcfg.c" }`.
	 */
	sources?: Record<string, string>;
	/**
	 * Color style, config-driven: maps a field `kind` to any CSS color. Fields
	 * without an explicit `color` inherit `palette[kind]`; anything still unset
	 * gets a deterministic auto color in the webview.
	 */
	palette?: Record<string, string>;
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
	/** Explicit background color (any CSS color); overrides `palette[kind]`. */
	color?: string;
	/**
	 * When present, the field's bytes hold an in-file address. The adapter
	 * decodes them, applies `transform` and range-checks the result, turning the
	 * field into a clickable jump. See {@link FieldLinkSpec}.
	 */
	link?: FieldLinkSpec;
}

/**
 * The generic input bundle handed to every adapter. The core gathers these
 * uniformly — it has no vendor knowledge; adapters pick what they need.
 */
export interface LayoutInput {
	/** Lower-cased base file name (e.g. `nvm_test.mot`). */
	fileName: string;
	/** Lower-cased extension including the dot (e.g. `.mot`). */
	ext: string;
	/** Raw dump text for S-record / Intel HEX inputs. */
	text: string;
	/** Layout descriptors (`*.nvmlayout.json`) discovered near the file. */
	configs: LayoutConfig[];
	/** Nearby AUTOSAR config content (first `*.arxml`/`*.xml`), when present. */
	arxml?: string;
	/**
	 * Resolved auxiliary source files, keyed by the logical name each descriptor
	 * declared in `LayoutConfig.sources` (e.g. `sources.feeLcfg` = `Fee_Lcfg.c`).
	 */
	sources: Record<string, string>;
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

/** Whether a descriptor's `match` gate applies to the given input. */
export function matchesConfig(config: LayoutConfig, input: LayoutInput): boolean {
	const m = config.match;
	if (!m) {
		return true;
	}
	// Empty arrays are treated as "no constraint" (common placeholder value).
	if (m.ext?.length && !m.ext.map(e => e.toLowerCase()).includes(input.ext)) {
		return false;
	}
	if (
		m.fileNameIncludes?.length &&
		!m.fileNameIncludes.some(s => input.fileName.includes(s.toLowerCase()))
	) {
		return false;
	}
	return true;
}

/**
 * Fill in each field's `color` from the descriptor `palette[kind]` where the
 * field did not already specify one. Keeps color styling in config, not code.
 */
export function applyPalette(blocks: NvmBlockInfo[], palette?: Record<string, string>): void {
	if (!palette) {
		return;
	}
	for (const block of blocks) {
		for (const field of block.fields ?? []) {
			if (field.color === undefined && palette[field.kind] !== undefined) {
				field.color = palette[field.kind];
			}
		}
	}
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
