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

	// Reflect the active arrangement (and filter) in the view's subtitle so the
	// current mode is always visible without opening a menu.
	const updateMeta = () => {
		const arrangement = arrangementById(config.arrangementId);
		view.description = provider.filter
			? `${arrangement.label} · "${provider.filter}"`
			: arrangement.label;
	};
	config.onDidChange(updateMeta);
	updateMeta();

	// One command per arrangement so they can populate a real dropdown submenu
	// (view-title) instead of a command-palette-style quick pick.
	const arrangeCommands = ARRANGEMENTS.map(a =>
		vscode.commands.registerCommand(`hexEditor.nvm.blocks.arrange.${a.id}`, async () => {
			await config.setArrangementId(a.id);
		}),
	);

	const filter = vscode.commands.registerCommand("hexEditor.nvm.blocks.filter", async () => {
		const value = await vscode.window.showInputBox({
			title: vscode.l10n.t("Filter blocks"),
			prompt: vscode.l10n.t("Match block name, id or attribute (leave empty to clear)"),
			value: provider.filter,
			placeHolder: vscode.l10n.t("e.g. sector 1, 0x0047, DemAdmin…"),
		});
		if (value !== undefined) {
			provider.setFilter(value);
			updateMeta();
		}
	});

	const clearFilter = vscode.commands.registerCommand(
		"hexEditor.nvm.blocks.clearFilter",
		() => {
			provider.setFilter("");
			updateMeta();
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

	return [view, config, ...arrangeCommands, filter, clearFilter, configureColumns, refresh];
}
