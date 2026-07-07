// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The "NVM: Show Capabilities" command — a grouped quick pick that lists what the
 * current NVM Studio build can do (its version, AI tools, views, annotations, and
 * layout/config docs). Selecting an entry runs its command or opens its doc.
 *
 * The list comes entirely from {@link CAPABILITY_CATALOG} (one source of truth),
 * so this file only turns catalog entries into quick-pick items and dispatches
 * the chosen one. Vendor-blind: it shows generic capabilities, never vendor data.
 */

import * as vscode from "vscode";
import { CAPABILITY_CATALOG, CapabilityEntry, CapabilityGroup } from "./capabilityCatalog";

interface CapabilityPickItem extends vscode.QuickPickItem {
	entry?: CapabilityEntry;
}

/** Register the show-capabilities command. */
export function registerShowCapabilities(context: vscode.ExtensionContext): vscode.Disposable {
	return vscode.commands.registerCommand("nvmStudio.nvm.showCapabilities", async () => {
		const version =
			(context.extension.packageJSON as { version?: string } | undefined)?.version ?? "?";

		const items: CapabilityPickItem[] = [];
		let currentGroup: CapabilityGroup | undefined;
		for (const entry of CAPABILITY_CATALOG) {
			if (entry.group !== currentGroup) {
				currentGroup = entry.group;
				items.push({ label: entry.group, kind: vscode.QuickPickItemKind.Separator });
			}
			items.push({
				label: entry.toolRef ? `${entry.label}  ·  ${entry.toolRef}` : entry.label,
				detail: entry.detail,
				entry,
			});
		}

		const pick = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("NVM Studio capabilities (v{0})", version),
			placeHolder: vscode.l10n.t("Select a capability to run it or open its documentation"),
			matchOnDetail: true,
		});
		const entry = (pick as CapabilityPickItem | undefined)?.entry;
		if (!entry) {
			return;
		}
		if (entry.commandId) {
			await vscode.commands.executeCommand(entry.commandId);
		} else if (entry.docPath) {
			const uri = vscode.Uri.joinPath(context.extensionUri, ...entry.docPath.split("/"));
			await vscode.commands.executeCommand("markdown.showPreview", uri);
		} else if (entry.toolRef) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t(
					"Reference {0} in a Copilot Chat prompt to use this capability.",
					entry.toolRef,
				),
			);
		}
	});
}
