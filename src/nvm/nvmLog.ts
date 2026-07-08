// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A single, user-visible **NVM Studio** log channel.
 *
 * The core previously only used `console.warn`, which lands in the hidden
 * Extension Host DevTools console. Layout loading is a user-facing concern —
 * which descriptors matched, which declared source files resolved, which are
 * missing — so it belongs in an Output channel the user can open on demand
 * ("View > Output > NVM Studio").
 *
 * This is vendor-blind: it only reports the generic capability/descriptor
 * resolution the core performs, never anything a specific vendor's files mean.
 */

import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** Lazily create (once) the shared NVM Studio log channel. */
export function getNvmLog(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel("NVM Studio", { log: true });
	}
	return channel;
}

/** Dispose the channel (call from the extension's deactivate/dispose path). */
export function disposeNvmLog(): void {
	channel?.dispose();
	channel = undefined;
}
