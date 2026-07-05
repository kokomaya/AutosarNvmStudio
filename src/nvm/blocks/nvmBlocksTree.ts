// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "Blocks" view — a native tree of the active dump's parsed NVM blocks. It is
 * strictly vendor-blind: it reads only the generic {@link NvmBlockInfo} shape
 * (offset/length/name plus the neutral `group`/`sequence`/`identity`/
 * `attributes` fields) and delegates layout to a swappable
 * {@link BlockArrangement}. Selecting a block jumps the hex editor to it
 * (reusing the shared `hexEditor.nvm.jumpTo` command).
 */

import * as vscode from "vscode";
import { NvmBlockInfo } from "../../../shared/protocol";
import { HexDocument } from "../../hexDocument";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { arrangementById } from "./blockArrangement";
import { blockDescription, blockLabel, BlockNode, hexOffset } from "./blockTreeModel";
import { BlockViewConfig } from "./columnConfig";

export class NvmBlocksTree implements vscode.TreeDataProvider<BlockNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<BlockNode | undefined>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly registry: HexEditorRegistry,
		private readonly config: BlockViewConfig,
	) {
		registry.onDidChangeActiveDocument(() => this.refresh());
		registry.onDidChangeNvmBlocks(doc => {
			if (doc === this.activeDoc) {
				this.refresh();
			}
		});
		config.onDidChange(() => this.refresh());
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	private get activeDoc(): HexDocument | undefined {
		return this.registry.activeDocument;
	}

	/** The active document's blocks (typed to the neutral protocol shape). */
	public blocks(): NvmBlockInfo[] {
		const doc = this.activeDoc;
		return doc ? (this.registry.getNvmBlocks(doc) as NvmBlockInfo[]) : [];
	}

	public getTreeItem(node: BlockNode): vscode.TreeItem {
		if (node.kind === "group") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.description = node.description;
			item.contextValue = "nvmBlockGroup";
			item.iconPath = new vscode.ThemeIcon("folder");
			return item;
		}
		const block = node.block;
		const item = new vscode.TreeItem(
			blockLabel(block),
			vscode.TreeItemCollapsibleState.None,
		);
		const selected = this.config.effectiveColumns(
			(block.attributes ?? []).map(a => a.key),
		);
		item.description = blockDescription(block, selected);
		item.tooltip = this.tooltip(block);
		item.contextValue = "nvmBlock";
		item.iconPath = new vscode.ThemeIcon(block.isLatest ? "circle-filled" : "circle-outline");
		item.command = {
			command: "hexEditor.nvm.jumpTo",
			title: vscode.l10n.t("Jump"),
			arguments: [block.offset],
		};
		return item;
	}

	public getChildren(node?: BlockNode): BlockNode[] {
		if (!node) {
			const arrangement = arrangementById(this.config.arrangementId);
			return arrangement.arrange(this.blocks());
		}
		return node.kind === "group" ? node.children : [];
	}

	private tooltip(block: NvmBlockInfo): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${blockLabel(block)}**\n\n`);
		md.appendMarkdown(`- Offset: \`${hexOffset(block.offset)}\`\n`);
		md.appendMarkdown(`- Length: \`${block.length}\` (\`${hexOffset(block.length)}\`)\n`);
		for (const attr of block.attributes ?? []) {
			md.appendMarkdown(`- ${attr.label}: \`${String(attr.value)}\`\n`);
		}
		return md;
	}
}
