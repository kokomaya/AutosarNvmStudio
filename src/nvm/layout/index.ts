// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NVM layout engine registry. All rendering is **config-driven**: no format is
 * auto-applied to a bare file. Each engine only runs when a `*.nvmlayout.json`
 * descriptor opts in — either a config-defined block layout, or one that selects
 * a code engine (e.g. `"provider": "vector-fee-v3"`) with `options`.
 *
 * To add an engine, implement {@link NvmLayoutProvider} in its own file and
 * call {@link registerLayoutProvider} here.
 */

import { configLayoutProvider } from "./configLayout";
import { registerLayoutProvider } from "./provider";
import { vectorFeeV3Provider } from "./vectorFeeV3";

export * from "./provider";

// Registration order: last registered is tried first. Both engines are inert
// until a descriptor opts in, so order only affects which config wins if a file
// somehow matches both a block layout and an engine selector.
registerLayoutProvider(vectorFeeV3Provider);
registerLayoutProvider(configLayoutProvider);
