// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NVM layout engine registry. All rendering is **config-driven**: no format is
 * auto-applied to a bare file. The core ships ZERO vendor layout logic — the
 * only built-in engine is the generic, declarative config-layout adapter.
 * Vendor formats (e.g. Vector FEE V3) are external engine packs loaded at
 * runtime (see `externalEngine.ts` + `../engines/`).
 *
 * To add a generic built-in adapter, implement {@link NvmLayoutProvider} in its
 * own file and call {@link registerLayoutProvider} here.
 */

import { arxmlSymbolProvider } from "./arxmlSymbols";
import { configLayoutProvider } from "./configLayout";
import { registerImageProvider, registerSymbolProvider } from "./context";
import { defineSymbolProvider } from "./defineSymbols";
import { registerLayoutProvider } from "./provider";
import { srecordImageProvider } from "./srecordImage";
import { structuredLayoutProvider } from "./structuredLayout";

export * from "./context";
export * from "./provider";

// The config-layout adapter is inert until a `*.nvmlayout.json` with `blocks`
// opts in, so it never applies a format automatically.
registerLayoutProvider(configLayoutProvider);

// The structured adapter is inert until a descriptor carries a `profile`
// (T1 declarative parser). Registered after the positional one so a descriptor
// that mixes both sections still resolves; each is gated by `effectiveStrategy`.
registerLayoutProvider(structuredLayoutProvider);

// `image` capability: decode S-record / Intel HEX into a flat image. The core
// resolves the image once and hands it to every layout provider.
registerImageProvider(srecordImageProvider);

// `symbols` capability: derive business names from nearby AUTOSAR config. Inert
// unless such config is present; layout blocks are named from it when ids match.
registerSymbolProvider(arxmlSymbolProvider);

// `symbols` capability: derive business names from `#define <prefix><NAME> <int>`
// tables a descriptor declares via `symbols.fromDefines` (e.g. the DEM event-id
// list). Inert unless a descriptor opts in. Merged with the ARXML adapter.
registerSymbolProvider(defineSymbolProvider);
