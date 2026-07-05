// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "NVM Studio" sidebar: a tree of the active dump's bookmarks, tag instances and
 * notes (à la vscode-bookmarks). Selecting a bookmark / tagged range / note jumps
 * the hex editor to it; context actions delete/open. Tag *definitions* (create /
 * rename / recolor / delete) are managed in the data inspector; this view lists
 * where each tag is *applied*. Add actions live in the editor's right-click menu,
 * keyboard shortcuts, and the command palette.
 */

import * as vscode from "vscode";
import { MessageType } from "../../../shared/protocol";
import { HexDocument } from "../../hexDocument";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "../annotations/annotationService";

type NodeKind = "group" | "bookmark" | "tag" | "tagAssignment" | "note";

interface StudioNode {
	kind: NodeKind;
	label: string;
	description?: string;
	/** Editor offset to jump to (bookmarks / notes / assignments). */
	offset?: number;
	/** Backing id for delete/open actions. */
	id?: string;
	/** Group key for expandable roots. */
	group?: "bookmarks" | "tags" | "notes";
	/** Child nodes for tags/groups. */
	children?: StudioNode[];
	color?: string;
}

export class NvmStudioTree implements vscode.TreeDataProvider<StudioNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StudioNode | undefined>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly registry: HexEditorRegistry,
		private readonly annotations: AnnotationService,
	) {
		registry.onDidChangeActiveDocument(() => this.refresh());
		annotations.onDidChange(() => this.refresh());
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	private get activeDoc(): HexDocument | undefined {
		return this.registry.activeDocument;
	}

	public getTreeItem(node: StudioNode): vscode.TreeItem {
		const collapsible =
			node.kind === "group" || (node.kind === "tag" && (node.children?.length ?? 0) > 0)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(node.label, collapsible);
		item.description = node.description;
		item.contextValue = node.kind;
		switch (node.kind) {
			case "bookmark":
				item.iconPath = new vscode.ThemeIcon("bookmark");
				break;
			case "note":
				item.iconPath = new vscode.ThemeIcon("note");
				break;
			case "tag":
				item.iconPath = new vscode.ThemeIcon("tag");
				break;
			case "tagAssignment":
				item.iconPath = new vscode.ThemeIcon("symbol-numeric");
				break;
		}
		if (node.offset !== undefined && (node.kind === "bookmark" || node.kind === "tagAssignment")) {
			item.command = {
				command: "hexEditor.nvm.jumpTo",
				title: "Jump",
				arguments: [node.offset],
			};
		}
		if (node.kind === "note") {
			item.command = { command: "hexEditor.nvm.openNoteNode", title: "Open note", arguments: [node] };
		}
		return item;
	}

	public async getChildren(node?: StudioNode): Promise<StudioNode[]> {
		const doc = this.activeDoc;
		if (!doc) {
			return [];
		}
		if (!node) {
			const set = await this.annotations.get(doc.uri);
			return [
				{ kind: "group", group: "bookmarks", label: "Bookmarks", description: `${set.bookmarks.length}` },
				{ kind: "group", group: "tags", label: "Tags", description: `${set.tagAssignments.length}` },
				{ kind: "group", group: "notes", label: "Notes", description: `${set.notes.length}` },
			];
		}
		if (node.kind === "group") {
			return this.groupChildren(doc, node.group!);
		}
		if (node.kind === "tag") {
			return node.children ?? [];
		}
		return [];
	}

	private async groupChildren(
		doc: HexDocument,
		group: "bookmarks" | "tags" | "notes",
	): Promise<StudioNode[]> {
		const set = await this.annotations.get(doc.uri);
		if (group === "bookmarks") {
			return set.bookmarks.map(b => ({
				kind: "bookmark" as const,
				id: b.id,
				offset: b.anchor.offset,
				label: b.label ?? `0x${b.anchor.offset.toString(16).toUpperCase()}`,
				description: `0x${b.anchor.offset.toString(16).toUpperCase()}`,
			}));
		}
		if (group === "notes") {
			return set.notes.map(n => ({
				kind: "note" as const,
				id: n.id,
				offset: n.anchor.offset,
				label: n.title ?? "Note",
				description: `0x${n.anchor.offset.toString(16).toUpperCase()}`,
			}));
		}
		// tags: each tag with its assignments as children
		return set.tags.map(t => {
			const assignments = set.tagAssignments.filter(a => a.tagId === t.id);
			return {
				kind: "tag" as const,
				id: t.id,
				label: t.label,
				description: `${assignments.length}`,
				color: t.color,
				children: assignments.map(a => ({
					kind: "tagAssignment" as const,
					id: a.id,
					offset: a.anchor.offset,
					label: `0x${a.anchor.offset.toString(16).toUpperCase()}${
						a.anchor.endOffset ? `–0x${a.anchor.endOffset.toString(16).toUpperCase()}` : ""
					}`,
				})),
			};
		});
	}
}

/** Register the NVM Studio tree view + its commands. Returns disposables. */
export function registerNvmStudioView(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
	const provider = new NvmStudioTree(registry, annotations);
	const view = vscode.window.createTreeView("hexEditor.nvmStudio", {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	// After a mutation, re-push annotations to the active dump's webview so the
	// grid badges/notes update in lockstep with the tree.
	const pushToActive = async () => {
		const doc = registry.activeDocument;
		if (!doc) {
			return;
		}
		const annotationsView = await annotations.toView(doc.uri);
		for (const messaging of registry.getMessagingByUri(doc.uri)) {
			messaging.sendEvent({ type: MessageType.SetNvmAnnotations, annotations: annotationsView });
		}
	};

	const jumpTo = vscode.commands.registerCommand("hexEditor.nvm.jumpTo", (offset: number) => {
		const doc = registry.activeDocument;
		if (!doc || typeof offset !== "number") {
			return;
		}
		for (const messaging of registry.getMessagingByUri(doc.uri)) {
			messaging.sendEvent({ type: MessageType.GoToOffset, offset });
		}
	});

	const openNote = vscode.commands.registerCommand(
		"hexEditor.nvm.openNoteNode",
		async (node: StudioNode) => {
			const doc = registry.activeDocument;
			if (!doc || !node?.id) {
				return;
			}
			const uri = annotations.noteUri(doc.uri, node.id);
			if (uri) {
				await vscode.window.showTextDocument(uri, { preview: false });
			}
		},
	);

	const deleteNode = vscode.commands.registerCommand(
		"hexEditor.nvm.deleteAnnotation",
		async (node: StudioNode) => {
			const doc = registry.activeDocument;
			if (!doc || !node?.id) {
				return;
			}
			if (node.kind === "bookmark") {
				await annotations.apply(doc.uri, { kind: "removeBookmark", id: node.id });
			} else if (node.kind === "note") {
				await annotations.apply(doc.uri, { kind: "deleteNote", id: node.id });
			} else if (node.kind === "tagAssignment") {
				await annotations.apply(doc.uri, { kind: "unassignTag", assignmentId: node.id });
			}
			await pushToActive();
		},
	);

	return [view, jumpTo, openNote, deleteNode];
}
