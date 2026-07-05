// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `symbols` capability adapter backed by AUTOSAR ECUC configuration.
 *
 * It reads the nearby AUTOSAR config (standard NvM / Fee ECUC containers) and
 * emits a vendor-blind {@link SymbolTable} of `id -> { name, length }`. The core
 * never learns this came from AUTOSAR — it only asks for `symbols` and uses the
 * result to give layout blocks their business names. Other symbol sources
 * (source files, map files, debug info) can register their own adapter.
 */

import { importNvmCatalog, SymbolEntry, SymbolTable, symbolTableFrom } from "../../../shared/nvm";
import { SymbolContext, SymbolProvider } from "./context";

export const arxmlSymbolProvider: SymbolProvider = {
	id: "autosar-ecuc-symbols",
	detect(ctx: SymbolContext): boolean {
		return !!ctx.arxml && /NvMBlockDescriptor|ECUC-MODULE-CONFIGURATION-VALUES/.test(ctx.arxml);
	},
	provide(ctx: SymbolContext): SymbolTable | undefined {
		if (!ctx.arxml) {
			return undefined;
		}
		let catalog: ReturnType<typeof importNvmCatalog>;
		try {
			// The nearby config may hold every module; parse the same text for each.
			catalog = importNvmCatalog({ nvm: ctx.arxml, fee: ctx.arxml, fls: ctx.arxml });
		} catch {
			return undefined;
		}

		const entries: SymbolEntry[] = [];
		for (const block of catalog.blocks) {
			const primary = block.feeBlockNumber ?? block.nvmId ?? block.name;
			entries.push({ id: primary, name: block.name, length: block.payloadLength });
			// Also index by the NvM id when distinct, so either logical id a layout
			// happens to expose can resolve to this business name.
			if (block.nvmId !== undefined && block.nvmId !== primary) {
				entries.push({ id: block.nvmId, name: block.name, length: block.payloadLength });
			}
		}
		return entries.length > 0 ? symbolTableFrom(entries) : undefined;
	},
};
