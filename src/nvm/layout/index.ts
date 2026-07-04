// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NVM layout provider registry. Importing this module registers the built-in
 * providers. To add a vendor, implement {@link NvmLayoutProvider} in its own
 * file and call {@link registerLayoutProvider} here (or ship a
 * `*.nvmlayout.json` descriptor for the config-driven provider).
 */

import { configLayoutProvider } from "./configLayout";
import { registerLayoutProvider } from "./provider";
import { vectorFeeV3Provider } from "./vectorFeeV3";

export * from "./provider";

// Registration order: last registered is tried first. Config descriptors
// express explicit user intent, so they take precedence over the built-in
// Vector detector.
registerLayoutProvider(vectorFeeV3Provider);
registerLayoutProvider(configLayoutProvider);
