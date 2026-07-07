// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified NVM Studio user home. Both engine packs and layout descriptors are
 * installed under a single per-user folder so they live together and outside the
 * extension's storage:
 *
 *   <home>/engines/<id>/     engine packs (resolved by id)
 *   <home>/conf/             layout descriptors (*.nvmlayout.json)
 *
 * `<home>` defaults to `<os home>/nvmstudio` and can be overridden with the
 * `NVMSTUDIO_HOME` environment variable.
 */

import * as vscode from "vscode";

/** OS home directory without the node `os` module (keeps the web bundle happy). */
function osHome(): string {
	if (typeof process !== "undefined" && process.env) {
		return process.env.USERPROFILE || process.env.HOME || "";
	}
	return "";
}

/** Absolute fsPath of the NVM Studio user home. */
export function nvmStudioHome(): string {
	const override = process.env.NVMSTUDIO_HOME;
	if (override && override.trim().length > 0) {
		return override.trim();
	}
	return `${osHome()}/nvmstudio`;
}

/** `<home>` as a Uri. */
export function nvmStudioHomeUri(): vscode.Uri {
	return vscode.Uri.file(nvmStudioHome());
}

/** `<home>/engines` as a Uri (engine pack install root). */
export function nvmStudioEnginesUri(): vscode.Uri {
	return vscode.Uri.joinPath(nvmStudioHomeUri(), "engines");
}

/** `<home>/conf` as a Uri (layout descriptor install root). */
export function nvmStudioConfUri(): vscode.Uri {
	return vscode.Uri.joinPath(nvmStudioHomeUri(), "conf");
}
