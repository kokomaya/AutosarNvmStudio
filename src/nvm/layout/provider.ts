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

import { FieldLinkSpec, NvmProfile, SymbolTable } from "../../../shared/nvm";
import { NvmBlockInfo } from "../../../shared/protocol";
import { FileRef, ResolveContext } from "./context";

/** A vendor layout descriptor, typically loaded from a `*.nvmlayout.json`. */
export interface LayoutConfig {
	/** Human-readable vendor / format name. */
	vendor: string;
	/**
	 * Explicit capability tier this descriptor uses. Optional — inferred when
	 * omitted:
	 * - `engineScript`/`engine` present  => `"engine"`   (T2, arbitrary code),
	 * - `profile` present                => `"structured"` (T1, declarative parser),
	 * - otherwise                        => `"positional"` (T0, static `blocks`).
	 *
	 * Set it to document intent, or to disambiguate a descriptor that happens to
	 * carry more than one section. This is the single "escalating power" knob:
	 * T0 static → T1 header/length/CRC/iteration → T2 full engine.
	 */
	strategy?: "positional" | "structured" | "engine";
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
	/**
	 * Id of an **installed engine pack** (see `src/nvm/engines/`), e.g.
	 * `"vector-fee-v3"` or `"vector-fee-v3@1.0.0"`. Resolved by the engine
	 * manager to the pack's entry script. Same trust gate as `engineScript`.
	 */
	engine?: string;
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
	 * T1 structured parser spec: describe a header + payload-length + optional
	 * CRC + iteration strategy, and the core walks the image itself — no `blocks`
	 * table, no engine code. Uses the vendor-neutral {@link NvmProfile} model
	 * (header fields, roles, whitelisted transform expressions, CRC presets,
	 * sequential / fixed-count iteration, end markers). See shared/nvm/profile.ts.
	 */
	profile?: NvmProfile;
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
 * LEGACY input bundle for the **external-engine boundary only**. Engine packs
 * (see `engines/`) declare a matching shape and consume `text` + `sources`, so
 * this stays stable for backward compatibility. Built-in providers use the
 * vendor-blind {@link ResolveContext} instead.
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
	/** Cheap check whether this provider might handle the context. */
	detect(ctx: ResolveContext): boolean;
	/** Produce blocks; return an empty array when it turns out not to apply. */
	parse(ctx: ResolveContext): NvmBlockInfo[];
}

/**
 * Resolve the capability tier a descriptor uses. Explicit `strategy` wins;
 * otherwise it is inferred from which section is present so existing
 * descriptors keep working without the field.
 */
export function effectiveStrategy(config: LayoutConfig): "positional" | "structured" | "engine" {
	if (config.strategy) {
		return config.strategy;
	}
	if (config.engineScript || config.engine) {
		return "engine";
	}
	if (config.profile) {
		return "structured";
	}
	return "positional";
}

/** Whether a descriptor's `match` gate applies to the given file. */
export function matchesConfig(config: LayoutConfig, target: FileRef): boolean {
	const m = config.match;
	if (!m) {
		return true;
	}
	// Empty arrays are treated as "no constraint" (common placeholder value).
	if (m.ext?.length && !m.ext.map(e => e.toLowerCase()).includes(target.ext)) {
		return false;
	}
	if (
		m.fileNameIncludes?.length &&
		!m.fileNameIncludes.some(s => target.fileName.includes(s.toLowerCase()))
	) {
		return false;
	}
	return true;
}

/**
 * Rank how *specific* a descriptor's `match` gate is, so that when several
 * descriptors match the same file the most narrowly-targeted one wins. This is
 * vendor-blind: it looks only at the generic `match` gate (extension +
 * file-name substrings), never at the descriptor's engine `options`. A gate
 * that names the file by substring is more intentional than one that only
 * constrains the extension, which in turn beats a gate-less catch-all.
 */
export function matchSpecificity(config: LayoutConfig): number {
	const m = config.match;
	if (!m) {
		return 0;
	}
	let score = 0;
	if (m.fileNameIncludes?.length) {
		score += 2;
	}
	if (m.ext?.length) {
		score += 1;
	}
	return score;
}

/**
 * Fill in each block's `name` from a resolved {@link SymbolTable} when the
 * block's numeric logical id matches a symbol. Vendor-blind business naming:
 * a no-op unless a `symbols` adapter contributed a matching entry.
 */
export function applySymbolNames(blocks: NvmBlockInfo[], symbols: SymbolTable | undefined): void {
	if (!symbols || symbols.byId.size === 0) {
		return;
	}
	for (const block of blocks) {
		const id = (block.raw as { logicalId?: number | string } | undefined)?.logicalId;
		if (id === undefined) {
			continue;
		}
		const symbol = symbols.byId.get(id);
		if (symbol?.name) {
			block.name = symbol.name;
		}
	}
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
 * Run the registered providers against the context and return the first that
 * yields at least one block. Providers are isolated: a throwing provider is
 * skipped rather than aborting the whole resolution. Resolved blocks are then
 * enriched with business names from the `symbols` capability, when available.
 */
export function resolveNvmBlocks(ctx: ResolveContext): ResolvedLayout | undefined {
	for (const provider of providers) {
		try {
			if (!provider.detect(ctx)) {
				continue;
			}
			const blocks = provider.parse(ctx);
			if (blocks.length > 0) {
				applySymbolNames(blocks, ctx.symbols());
				return { providerId: provider.id, blocks };
			}
		} catch {
			// Isolate provider failures so one bad vendor plug-in can't break others.
		}
	}
	return undefined;
}
