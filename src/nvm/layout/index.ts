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

import { configLayoutProvider } from "./configLayout";
import { registerLayoutProvider } from "./provider";

export * from "./provider";

// The config-layout adapter is inert until a `*.nvmlayout.json` with `blocks`
// opts in, so it never applies a format automatically.
registerLayoutProvider(configLayoutProvider);
