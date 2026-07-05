// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * User commands for managing external NVM engine packs (install / download /
 * list / remove). Running an engine remains gated at parse time; these commands
 * only manage what is available to run.
 */

import * as vscode from "vscode";
import { EngineManager, InstalledEngine } from "./engineManager";

const SECURITY_NOTE =
	"Engine packs run JavaScript in the desktop extension host. Only install engines you trust.";

async function pickInstallSource(
	manager: EngineManager,
): Promise<InstalledEngine | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: true,
		canSelectMany: false,
		title: "Select an engine pack folder (with engine.json) or a single *.engine.js",
		openLabel: "Install engine",
	});
	if (!picked || picked.length === 0) {
		return undefined;
	}
	const src = picked[0];
	const stat = await vscode.workspace.fs.stat(src);
	if (stat.type === vscode.FileType.Directory) {
		return manager.installFromFolder(src);
	}
	return manager.installFromFile(src);
}

/** Register all engine-management commands. Returns disposables. */
export function registerEngineCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
	const manager = new EngineManager(context);

	const install = vscode.commands.registerCommand("hexEditor.nvm.installEngine", async () => {
		const ok = await vscode.window.showWarningMessage(
			SECURITY_NOTE,
			{ modal: true },
			"Choose engine…",
		);
		if (ok !== "Choose engine…") {
			return;
		}
		try {
			const installed = await pickInstallSource(manager);
			if (installed) {
				void vscode.window.showInformationMessage(
					`Installed NVM engine "${installed.manifest.displayName ?? installed.manifest.id}".`,
				);
			}
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Engine install failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	});

	const installUrl = vscode.commands.registerCommand(
		"hexEditor.nvm.installEngineFromUrl",
		async () => {
			const url = await vscode.window.showInputBox({
				title: "Download NVM engine pack",
				prompt: "URL of a single *.engine.js file",
				placeHolder: "https://…/my-engine.js",
				validateInput: v => (/^https?:\/\/.+/.test(v) ? undefined : "Enter an http(s) URL"),
			});
			if (!url) {
				return;
			}
			const ok = await vscode.window.showWarningMessage(
				`${SECURITY_NOTE}\n\nDownload and install from:\n${url}`,
				{ modal: true },
				"Download & install",
			);
			if (ok !== "Download & install") {
				return;
			}
			try {
				const installed = await manager.installFromUrl(url);
				void vscode.window.showInformationMessage(
					`Installed NVM engine "${installed.manifest.id}" from URL.`,
				);
			} catch (e) {
				void vscode.window.showErrorMessage(
					`Engine download failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	);

	const manage = vscode.commands.registerCommand("hexEditor.nvm.manageEngines", async () => {
		const engines = await manager.list();
		if (engines.length === 0) {
			void vscode.window.showInformationMessage(
				"No NVM engine packs installed. Use “NVM: Install Engine…”.",
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			engines.map(e => ({
				label: e.manifest.displayName ?? e.manifest.id,
				description: `${e.manifest.id}${e.manifest.version ? "@" + e.manifest.version : ""}`,
				detail: e.manifest.description ?? e.manifest.source,
				engine: e,
			})),
			{ title: "Installed NVM engines — pick one to remove", canPickMany: false },
		);
		if (!pick) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Remove engine "${pick.engine.manifest.id}"?`,
			{ modal: true },
			"Remove",
		);
		if (confirm === "Remove") {
			await manager.remove(pick.engine.manifest.id);
			void vscode.window.showInformationMessage(`Removed engine "${pick.engine.manifest.id}".`);
		}
	});

	return [install, installUrl, manage];
}
