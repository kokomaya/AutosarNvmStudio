// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared "Add block to a custom view" flow, used by every entry point (Blocks
 * Table row "+", Blocks tree context menu, Data Inspector button). Since VS Code
 * does not allow dragging into a sidebar webview, adding is selection/command
 * driven: pick a target view (or create one), then add the block — its
 * structural fingerprint pulls in all matching sibling blocks automatically.
 *
 * Vendor-blind: it only forwards a generic block to the service, which computes
 * the fingerprint from the decoded tree. No view/use-case knowledge lives here.
 */

import * as vscode from "vscode";
import { NvmBlockInfo } from "../../../shared/protocol";
import { CustomViewService } from "./customViewService";

/** Prompt for a target custom view (existing or new); returns its id or undefined. */
async function promptForView(
	service: CustomViewService,
	docUri: vscode.Uri,
	blocks: readonly NvmBlockInfo[],
): Promise<string | undefined> {
	const views = await service.listForEditor(docUri, blocks);
	const CREATE = "$(add) New view…";
	const pick = await vscode.window.showQuickPick([CREATE, ...views.map(v => v.name)], {
		title: vscode.l10n.t("Add block to custom view"),
		placeHolder: vscode.l10n.t("Choose a view or create a new one (e.g. Reset, DEM)"),
	});
	if (!pick) {
		return undefined;
	}
	if (pick === CREATE) {
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t("New custom view"),
			prompt: vscode.l10n.t("View name (e.g. Reset, DEM)"),
		});
		if (!name) {
			return undefined;
		}
		return (await service.createView(docUri, name)).id;
	}
	return views.find(v => v.name === pick)?.id;
}

/**
 * Prompt whether to add the block as a new group or merge it into an existing
 * one. Merging is how the user asserts that blocks the plugin can NOT prove are
 * related (differently-named / un-decoded) belong in the same comparison table.
 * Returns the target group key to merge into, or undefined to add a new group.
 */
async function promptForGroupPlacement(
	service: CustomViewService,
	docUri: vscode.Uri,
	viewId: string,
	blocks: readonly NvmBlockInfo[],
): Promise<{ merge: boolean; groupKey?: string }> {
	const groups = await service.listGroups(docUri, viewId, blocks);
	if (groups.length === 0) {
		return { merge: false };
	}
	const NEW = "$(add) Add as a new group";
	const items: vscode.QuickPickItem[] = [
		{ label: NEW },
		{ label: "", kind: vscode.QuickPickItemKind.Separator },
		...groups.map(g => ({
			label: `$(merge) Merge into “${g.label}”`,
			description: vscode.l10n.t("{0} block(s)", g.matchedBlocks),
		})),
	];
	const pick = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t("Add block to custom view"),
		placeHolder: vscode.l10n.t("Add as a new group, or merge into an existing comparison table"),
	});
	if (!pick || pick.label === NEW) {
		return { merge: false };
	}
	const idx = items.filter(i => i.kind !== vscode.QuickPickItemKind.Separator).indexOf(pick) - 1;
	const group = groups[idx];
	return group ? { merge: true, groupKey: group.key } : { merge: false };
}

/**
 * Run the full add-to-view flow for a block: resolve the target view (prompting
 * if `viewId` is "__new__" or undefined), optionally merge into an existing
 * group, add the block, and notify the user. Returns true if a block was added.
 */
export async function addBlockToCustomView(
	service: CustomViewService,
	docUri: vscode.Uri,
	blocks: readonly NvmBlockInfo[],
	block: NvmBlockInfo,
	viewId?: string,
	by: "fingerprint" | "identity" | "id" = "fingerprint",
	groupKey?: string,
): Promise<boolean> {
	const wasExisting = !!(viewId && viewId !== "__new__");
	let target = wasExisting ? viewId : undefined;
	if (!target) {
		target = await promptForView(service, docUri, blocks);
	}
	if (!target) {
		return false;
	}
	// If a group key wasn't pre-chosen, and the target view already has groups,
	// let the user place this block as a new group or merge into an existing one.
	let mergeKey = groupKey;
	if (mergeKey === undefined) {
		const placement = await promptForGroupPlacement(service, docUri, target, blocks);
		mergeKey = placement.merge ? placement.groupKey : undefined;
	}
	await service.addBlock(docUri, target, block, by, mergeKey);
	void vscode.window.showInformationMessage(
		mergeKey
			? vscode.l10n.t("Merged “{0}” into the custom view group.", block.name ?? block.id)
			: vscode.l10n.t(
					"Added “{0}” (and matching blocks) to the custom view.",
					block.name ?? block.id,
				),
	);
	return true;
}
