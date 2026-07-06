// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `symbols` capability adapter backed by C `#define` tables.
 *
 * Driven entirely by config: a descriptor declares
 * `symbols.fromDefines: [{ source, prefix }]` and this adapter scrapes each
 * declared source for `#define <prefix><NAME> <int>` lines, emitting a
 * vendor-blind {@link SymbolTable} of `id -> { name }` (e.g. the AUTOSAR DEM
 * event-id list `DemConf_DemEventParameter_<NAME> <id>u`). The core never learns
 * what the ids mean — it only runs the generic scrape recipe the config asked
 * for and uses the result to name blocks whose `raw.logicalId` matches (via
 * {@link applySymbolNames}). It merges with any other symbol adapter (e.g.
 * ARXML) through `resolveSymbols`.
 */

import { parseDefineEnumByName, SymbolEntry, SymbolTable, symbolTableFrom } from "../../../shared/nvm";
import { SymbolContext, SymbolProvider } from "./context";
import { LayoutConfig } from "./provider";

/** Collect all `symbols.fromDefines` recipes across the active descriptors. */
function defineRecipes(configs: LayoutConfig[]): { source: string; prefix: string }[] {
	const out: { source: string; prefix: string }[] = [];
	for (const c of configs) {
		for (const r of c.symbols?.fromDefines ?? []) {
			if (r && typeof r.source === "string" && typeof r.prefix === "string" && r.prefix) {
				out.push({ source: r.source, prefix: r.prefix });
			}
		}
	}
	return out;
}

export const defineSymbolProvider: SymbolProvider = {
	id: "define-table-symbols",
	detect(ctx: SymbolContext): boolean {
		return defineRecipes(ctx.configs as LayoutConfig[]).length > 0;
	},
	provide(ctx: SymbolContext): SymbolTable | undefined {
		const recipes = defineRecipes(ctx.configs as LayoutConfig[]);
		if (recipes.length === 0) {
			return undefined;
		}
		const entries: SymbolEntry[] = [];
		for (const { source, prefix } of recipes) {
			const content = ctx.sources[source];
			if (!content) {
				continue;
			}
			const byName = parseDefineEnumByName(content, prefix);
			for (const [name, value] of byName) {
				// Key by the numeric id so a block/field carrying that id resolves to
				// the symbolic name. First name wins per id (merge is id-first anyway).
				entries.push({ id: value, name });
			}
		}
		return entries.length > 0 ? symbolTableFrom(entries) : undefined;
	},
};
