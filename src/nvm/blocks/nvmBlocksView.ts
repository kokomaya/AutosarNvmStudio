// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Wires up the "Blocks" tree view and its commands (switch arrangement, choose
 * displayed columns, refresh). All vendor-neutral: the arrangement picker lists
 * generic strategies and the column picker is populated from whatever attribute
 * keys the active blocks happen to expose.
 */

import * as vscode from "vscode";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { ARRANGEMENTS, arrangementById } from "./blockArrangement";
import { discoverAttributeKeys } from "./blockTreeModel";
import { BlockViewConfig } from "./columnConfig";
import { NvmBlocksTree } from "./nvmBlocksTree";

/** Register the Blocks tree view + its commands. Returns disposables. */
export function registerNvmBlocksView(
	registry: HexEditorRegistry,
	workspaceState: vscode.Memento,
): vscode.Disposable[] {
	const config = new BlockViewConfig(workspaceState);
	const provider = new NvmBlocksTree(registry, config);
	const view = vscode.window.createTreeView("hexEditor.nvmBlocks", {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	const setArrangement = vscode.commands.registerCommand(
		"hexEditor.nvm.blocks.setArrangement",
		async () => {
			const current = arrangementById(config.arrangementId).id;
			const pick = await vscode.window.showQuickPick(
				ARRANGEMENTS.map(a => ({
					label: `$(${a.icon}) ${a.label}`,
					description: a.id === current ? vscode.l10n.t("current") : undefined,
					id: a.id,
				})),
				{ title: vscode.l10n.t("Arrange blocks by…") },
			);
			if (pick) {
				await config.setArrangementId(pick.id);
			}
		},
	);

	const configureColumns = vscode.commands.registerCommand(
		"hexEditor.nvm.blocks.configureColumns",
		async () => {
			const available = discoverAttributeKeys(provider.blocks());
			if (available.length === 0) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t("The active dump has no block attributes to display."),
				);
				return;
			}
			const selected = new Set(config.effectiveColumns(available.map(a => a.key)));
			const picks = await vscode.window.showQuickPick(
				available.map(a => ({
					label: a.label,
					description: a.key,
					picked: selected.has(a.key),
					key: a.key,
				})),
				{
					title: vscode.l10n.t("Choose block columns"),
					canPickMany: true,
				},
			);
			if (picks) {
				await config.setSelectedColumns(picks.map(p => p.key));
			}
		},
	);

	const refresh = vscode.commands.registerCommand("hexEditor.nvm.blocks.refresh", () =>
		provider.refresh(),
	);

	return [view, config, setArrangement, configureColumns, refresh];
}
