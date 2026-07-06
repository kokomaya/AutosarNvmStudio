// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "Custom Views" — a webview sidebar view that renders the active dump's
 * user-composed custom views (a per-view table/list projected from decoded
 * block fields). The extension resolves the vendor-neutral view model and posts
 * it to the dumb webview renderer; the webview asks the host to jump to a byte
 * range or to mutate a view (rename / delete / toggle layout / promote / remove
 * field). Views are created from the editor's decoded-tree "+" affordance.
 */

import * as vscode from "vscode";
import { MessageType, NvmBlockInfo } from "../../../shared/protocol";
import { ResolvedView } from "../../../shared/nvm/customView";
import { Disposable } from "../../dispose";
import { HexDocument } from "../../hexDocument";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { CustomViewService } from "./customViewService";
import { addBlockToCustomView } from "./addToView";

/** Messages the webview posts back to the host. */
type FromPanel =
	| { type: "ready" }
	| { type: "jump"; offset: number }
	| { type: "select"; viewId: string }
	| { type: "rename"; viewId: string }
	| { type: "delete"; viewId: string }
	| { type: "deleteGroup"; viewId: string; groupKey: string }
	| { type: "promote"; viewId: string };

function randomNonce(): string {
	let s = "";
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		s += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return s;
}

export class NvmCustomViewsPanel extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = "hexEditor.nvmCustomViews";
	private view?: vscode.WebviewView;
	/** Remembered active view id per dump, so re-pushes keep the selection. */
	private readonly activeByDoc = new Map<string, string>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly registry: HexEditorRegistry,
		private readonly service: CustomViewService,
	) {
		super();
		this._register(registry.onDidChangeActiveDocument(() => this.push()));
		this._register(
			registry.onDidChangeNvmBlocks(doc => {
				if (doc === this.registry.activeDocument) {
					this.push();
				}
			}),
		);
		this._register(
			service.onDidChange(uri => {
				if (uri.toString() === this.registry.activeDocument?.uri.toString()) {
					this.push();
				}
			}),
		);
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.html(webviewView.webview);
		this._register(
			webviewView.webview.onDidReceiveMessage((msg: FromPanel) => this.onMessage(msg)),
		);
		webviewView.onDidDispose(() => (this.view = undefined));
	}

	private get activeDoc(): HexDocument | undefined {
		return this.registry.activeDocument;
	}

	private blocks(doc: HexDocument): NvmBlockInfo[] {
		return this.registry.getNvmBlocks(doc);
	}

	private onMessage(msg: FromPanel): void {
		const doc = this.activeDoc;
		if (!doc) {
			return;
		}
		switch (msg.type) {
			case "ready":
				this.push();
				return;
			case "jump":
				this.jump(msg.offset);
				return;
			case "select":
				this.activeByDoc.set(doc.uri.toString(), msg.viewId);
				this.push();
				return;
			case "rename":
				void this.promptRename(doc.uri, msg.viewId);
				return;
			case "delete":
				void this.service.deleteView(doc.uri, msg.viewId);
				return;
			case "deleteGroup":
				void this.service.deleteGroup(doc.uri, msg.viewId, msg.groupKey);
				return;
			case "promote":
				void this.promote(doc.uri, msg.viewId);
				return;
		}
	}

	private async promptRename(docUri: vscode.Uri, viewId: string): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t("Rename custom view"),
			prompt: vscode.l10n.t("New view name"),
		});
		if (name !== undefined) {
			await this.service.renameView(docUri, viewId, name);
		}
	}

	private async promote(docUri: vscode.Uri, viewId: string): Promise<void> {
		await this.service.promoteToTemplate(docUri, viewId);
		void vscode.window.showInformationMessage(
			vscode.l10n.t("View saved as a reusable template for this workspace."),
		);
	}

	private jump(offset: number): void {
		const doc = this.activeDoc;
		if (!doc) {
			return;
		}
		for (const messaging of this.registry.getMessagingByUri(doc.uri)) {
			messaging.sendEvent({ type: MessageType.GoToOffset, offset });
		}
	}

	/** Resolve the active dump's views and post them to the webview. */
	private async push(): Promise<void> {
		if (!this.view) {
			return;
		}
		const doc = this.activeDoc;
		if (!doc) {
			void this.view.webview.postMessage({ type: "model", views: [], activeId: undefined });
			return;
		}
		const views: ResolvedView[] = await this.service.toResolvedViews(doc.uri, this.blocks(doc));
		const key = doc.uri.toString();
		let activeId = this.activeByDoc.get(key);
		if (!activeId || !views.some(v => v.id === activeId)) {
			activeId = views[0]?.id;
			if (activeId) {
				this.activeByDoc.set(key, activeId);
			}
		}
		void this.view.webview.postMessage({ type: "model", views, activeId });
	}

	private html(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "dist", "nvmCustomViews.js"),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "dist", "nvmCustomViews.css"),
		);
		const nonce = randomNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Custom Views</title>
</head>
<body>
	<div id="root">
		<div class="toolbar">
			<select id="view-select" aria-label="Choose custom view"></select>
			<div class="spacer"></div>
			<button id="btn-rename" class="icon-btn" title="Rename view">✎</button>
			<button id="btn-promote" class="icon-btn" title="Save as reusable template">★</button>
			<button id="btn-delete" class="icon-btn" title="Delete view">🗑</button>
		</div>
		<div id="status" class="status"></div>
		<div id="table-wrap"></div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** Register the Custom Views webview view + the "add block" command. */
export function registerNvmCustomViewsPanel(
	extensionUri: vscode.Uri,
	registry: HexEditorRegistry,
	service: CustomViewService,
): vscode.Disposable[] {
	const provider = new NvmCustomViewsPanel(extensionUri, registry, service);

	// Blocks-tree context-menu entry: add the right-clicked block (and its
	// structural family) to a custom view. The node is the tree's BlockNode.
	const addBlock = vscode.commands.registerCommand(
		"hexEditor.nvm.customViews.addBlock",
		async (node?: { kind?: string; block?: NvmBlockInfo }) => {
			const doc = registry.activeDocument;
			if (!doc || node?.kind !== "block" || !node.block) {
				return;
			}
			const blocks = registry.getNvmBlocks(doc) as NvmBlockInfo[];
			await addBlockToCustomView(service, doc.uri, blocks, node.block);
		},
	);

	return [
		vscode.window.registerWebviewViewProvider(NvmCustomViewsPanel.viewType, provider),
		provider,
		addBlock,
	];
}
