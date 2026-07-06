// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "NVM: Reselect Dependency File" command — lets the user change or clear a
 * remembered dependency-file disambiguation choice. Clearing means the next time
 * that file is needed, discovery re-prompts (and re-persists) the pick.
 */

import * as vscode from "vscode";
import {
	getDependencyResolver,
	getDependencyStore,
	invalidateDependencyResolver,
} from "./fileIndex";

export function registerReselectDependency(context: vscode.ExtensionContext): vscode.Disposable {
	return vscode.commands.registerCommand("hexEditor.nvm.reselectDependency", async () => {
		const store = getDependencyStore(context);
		const keys = store.keys();
		if (keys.length === 0) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t(
					"No remembered dependency-file choices yet. They're recorded when you pick among duplicate files during layout loading.",
				),
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			keys.map(k => {
				const choice = store.get(k);
				return {
					label: k,
					description: choice?.relPath ?? choice?.absPath ?? "",
					key: k,
				};
			}),
			{
				title: vscode.l10n.t("Reselect dependency file"),
				placeHolder: vscode.l10n.t("Choose a remembered file to clear and reselect"),
			},
		);
		const key = (pick as { key?: string } | undefined)?.key;
		if (!key) {
			return;
		}
		await store.clear(key);
		invalidateDependencyResolver();
		// Re-resolve immediately so the user can pick the new file now.
		const resolver = getDependencyResolver(context);
		if (resolver.hasRoots()) {
			const chosen = await resolver.resolve(key);
			void vscode.window.showInformationMessage(
				chosen
					? vscode.l10n.t("Now using: {0}", chosen)
					: vscode.l10n.t(
							"Cleared “{0}”. It will be reselected next time it's needed. Reload the dump to apply.",
							key,
						),
			);
		} else {
			void vscode.window.showInformationMessage(
				vscode.l10n.t("Cleared “{0}”. It will be reselected next time it's needed.", key),
			);
		}
	});
}
