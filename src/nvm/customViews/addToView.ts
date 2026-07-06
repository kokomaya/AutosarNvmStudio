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
 * Run the full add-to-view flow for a block: resolve the target view (prompting
 * if `viewId` is "__new__" or undefined), add the block, and notify the user.
 * Returns true if a block was added.
 */
export async function addBlockToCustomView(
	service: CustomViewService,
	docUri: vscode.Uri,
	blocks: readonly NvmBlockInfo[],
	block: NvmBlockInfo,
	viewId?: string,
	by: "fingerprint" | "identity" | "id" = "fingerprint",
): Promise<boolean> {
	let target = viewId && viewId !== "__new__" ? viewId : undefined;
	if (!target) {
		target = await promptForView(service, docUri, blocks);
	}
	if (!target) {
		return false;
	}
	await service.addBlock(docUri, target, block, by);
	void vscode.window.showInformationMessage(
		vscode.l10n.t("Added “{0}” (and matching blocks) to the custom view.", block.name ?? block.id),
	);
	return true;
}
