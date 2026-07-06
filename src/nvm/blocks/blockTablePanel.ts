// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "Blocks Table" — a webview sidebar view showing the active dump's NVM blocks
 * as a multi-column, sortable, searchable table. The extension computes a
 * vendor-neutral column/row model (reusing the same attribute discovery as the
 * tree) and posts it to the dumb webview renderer; a row click asks the editor
 * to jump to that block's offset.
 */

import * as vscode from "vscode";
import { MessageType, NvmBlockInfo } from "../../../shared/protocol";
import { Disposable } from "../../dispose";
import { HexDocument } from "../../hexDocument";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { blockLabel, discoverAttributeKeys, formatAttributeValue, hexOffset } from "./blockTreeModel";
import { CustomViewService } from "../customViews/customViewService";
import { addBlockToCustomView } from "../customViews/addToView";

interface TableColumn {
	key: string;
	label: string;
	numeric?: boolean;
}

interface TableRow {
	offset: number;
	isLatest?: boolean;
	cells: Record<string, string | number>;
}

/** Fixed leading columns present for every block, before engine attributes. */
const BASE_COLUMNS: TableColumn[] = [
	{ key: "__name", label: "Name" },
	{ key: "__offset", label: "Offset", numeric: true },
	{ key: "__length", label: "Length", numeric: true },
];

function randomNonce(): string {
	let s = "";
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		s += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return s;
}

export class NvmBlocksTablePanel extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = "hexEditor.nvmBlocksTable";
	private view?: vscode.WebviewView;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly registry: HexEditorRegistry,
		private readonly customViews: CustomViewService,
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
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.html(webviewView.webview);
		this._register(
			webviewView.webview.onDidReceiveMessage((msg: { type: string; offset?: number }) => {
				if (msg.type === "ready") {
					this.push();
				} else if (msg.type === "jump" && typeof msg.offset === "number") {
					this.jump(msg.offset);
				} else if (msg.type === "addToView" && typeof msg.offset === "number") {
					void this.addToView(msg.offset);
				}
			}),
		);
		webviewView.onDidDispose(() => (this.view = undefined));
	}

	/** Add the block at `offset` (and its structural family) to a custom view. */
	private async addToView(offset: number): Promise<void> {
		const doc = this.activeDoc;
		if (!doc) {
			return;
		}
		const blocks = this.blocks();
		const block = blocks.find(b => b.offset === offset);
		if (block) {
			await addBlockToCustomView(this.customViews, doc.uri, blocks, block);
		}
	}

	private get activeDoc(): HexDocument | undefined {
		return this.registry.activeDocument;
	}

	private blocks(): NvmBlockInfo[] {
		const doc = this.activeDoc;
		return doc ? (this.registry.getNvmBlocks(doc) as NvmBlockInfo[]) : [];
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

	/** Build the vendor-neutral column/row model and post it to the webview. */
	private push(): void {
		if (!this.view) {
			return;
		}
		const blocks = this.blocks();
		const attrs = discoverAttributeKeys(blocks);
		const columns: TableColumn[] = [
			...BASE_COLUMNS,
			...attrs.map(a => ({
				key: a.key,
				label: a.label,
				numeric: typeof a.value === "number",
			})),
		];
		// Default order follows the active "flat by address" arrangement so the
		// initial table matches the hex layout; the webview lets the user re-sort.
		const ordered = [...blocks].sort((a, b) => a.offset - b.offset);
		const rows: TableRow[] = ordered.map(block => {
			const cells: Record<string, string | number> = {
				__name: blockLabel(block),
				__offset: hexOffset(block.offset),
				__length: block.length,
			};
			for (const attr of block.attributes ?? []) {
				cells[attr.key] =
					typeof attr.value === "number" ? attr.value : formatAttributeValue(attr);
			}
			return { offset: block.offset, isLatest: block.isLatest, cells };
		});
		void this.view.webview.postMessage({ type: "model", columns, rows });
	}

	private html(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "dist", "nvmBlocksTable.js"),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "dist", "nvmBlocksTable.css"),
		);
		const nonce = randomNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Blocks Table</title>
</head>
<body>
	<div id="root">
		<div class="toolbar">
			<input id="search" type="text" placeholder="Search blocks…" aria-label="Search blocks" />
		</div>
		<div id="status" class="status"></div>
		<div id="table-wrap"></div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** Register the Blocks Table webview view. Returns disposables. */
export function registerNvmBlocksTable(
	extensionUri: vscode.Uri,
	registry: HexEditorRegistry,
	customViews: CustomViewService,
): vscode.Disposable[] {
	const provider = new NvmBlocksTablePanel(extensionUri, registry, customViews);
	return [
		vscode.window.registerWebviewViewProvider(NvmBlocksTablePanel.viewType, provider),
		provider,
	];
}
