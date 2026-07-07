// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Install layout descriptors (`*.nvmlayout.json`) from an engine/config server
 * into the unified NVM Studio user home (`<home>/conf`), then register that
 * folder in `nvmstudio.nvm.layoutRoots` so descriptors are discovered without
 * copying them next to every dump.
 */

import * as vscode from "vscode";
import { nvmStudioConfUri } from "../paths";

interface RemoteConfigEntry {
	name?: string;
	downloadUrl?: string;
}

function baseOf(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Add a folder fsPath to `nvmstudio.nvm.layoutRoots` (global), avoiding dups. */
export async function ensureLayoutRoot(fsPath: string): Promise<void> {
	const config = vscode.workspace.getConfiguration("nvmstudio.nvm");
	const current = config.get<string[]>("layoutRoots", []) ?? [];
	const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
	if (current.some(r => r.replace(/\\/g, "/").toLowerCase() === normalized)) {
		return;
	}
	await config.update("layoutRoots", [...current, fsPath], vscode.ConfigurationTarget.Global);
}

/**
 * Download every `*.nvmlayout.json` the server advertises at `${base}/v1/configs`
 * into the unified NVM Studio conf home and register that folder in
 * `nvmstudio.nvm.layoutRoots`. Returns how many descriptors were written and the
 * target folder. Shared by the standalone config command and the combined
 * "install vendor pack" flow.
 */
export async function downloadConfigsFromBase(
	base: string,
): Promise<{ installed: number; confDir: vscode.Uri }> {
	const confDir = nvmStudioConfUri();
	const listRes = await fetch(`${base}/v1/configs`);
	if (!listRes.ok) {
		throw new Error(`List failed: ${listRes.status} ${listRes.statusText}`);
	}
	const payload = (await listRes.json()) as { configs?: RemoteConfigEntry[] };
	const entries = Array.isArray(payload.configs) ? payload.configs : [];
	if (entries.length === 0) {
		return { installed: 0, confDir };
	}

	await vscode.workspace.fs.createDirectory(confDir);
	let installed = 0;
	for (const entry of entries) {
		const name = typeof entry.name === "string" ? entry.name : "";
		if (!name.toLowerCase().endsWith(".nvmlayout.json")) {
			continue;
		}
		const safeName = name.replace(/^.*[\\/]/, "");
		const downloadUrl =
			typeof entry.downloadUrl === "string" && entry.downloadUrl.length > 0
				? new URL(entry.downloadUrl, `${base}/`).toString()
				: `${base}/v1/configs/${encodeURIComponent(safeName)}`;
		const fileRes = await fetch(downloadUrl);
		if (!fileRes.ok) {
			continue;
		}
		const content = await fileRes.text();
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(confDir, safeName),
			new TextEncoder().encode(content),
		);
		installed++;
	}
	if (installed > 0) {
		await ensureLayoutRoot(confDir.fsPath);
	}
	return { installed, confDir };
}

/** Register the "Install Layout Configs from URL" command. */
export function registerConfigInstallCommand(): vscode.Disposable {
	return vscode.commands.registerCommand("nvmStudio.nvm.installConfigsFromUrl", async () => {
		const input = await vscode.window.showInputBox({
			title: "Install layout configs from server",
			prompt: "Server base URL (the /v1/configs endpoint is used)",
			placeHolder: "http://127.0.0.1:7788",
			validateInput: v => (/^https?:\/\/.+/.test(v) ? undefined : "Enter an http(s) URL"),
		});
		if (!input) {
			return;
		}
		const base = baseOf(input);

		try {
			const { installed, confDir } = await downloadConfigsFromBase(base);
			if (installed === 0) {
				void vscode.window.showInformationMessage(
					"Server has no layout configs to install.",
				);
				return;
			}
			void vscode.window.showInformationMessage(
				`Installed ${installed} layout config(s) to:\n${confDir.fsPath}\nAdded to nvmstudio.nvm.layoutRoots.`,
			);
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Install layout configs failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	});
}
