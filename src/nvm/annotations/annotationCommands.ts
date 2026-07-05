// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Command-driven annotation input (right-click menu + keyboard shortcuts).
 *
 * These commands act on the *active* hex editor's current focus/selection so a
 * user can bookmark, note or tag a byte range without going through the hover
 * tooltip. After each mutation the updated annotation view is pushed back to the
 * webview(s) showing the dump.
 */

import * as vscode from "vscode";
import { MessageType } from "../../../shared/protocol";
import { HexDocument } from "../../hexDocument";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "./annotationService";

/** Focused byte + selected span for the active dump, if any. */
interface ActiveTarget {
	document: HexDocument;
	/** Focused byte offset (defaults to 0 when nothing is focused). */
	focused: number;
	/** Inclusive-exclusive range covering the current selection or focused byte. */
	start: number;
	end: number;
}

const resolveTarget = (registry: HexEditorRegistry): ActiveTarget | undefined => {
	const document = registry.activeDocument;
	if (!document) {
		void vscode.window.showInformationMessage("No active hex editor.");
		return undefined;
	}
	const { focused, selected } = document.selectionState;
	const start = focused ?? 0;
	const end = start + Math.max(1, selected || 1);
	return { document, focused: start, start, end };
};

const pushAnnotations = async (
	registry: HexEditorRegistry,
	annotations: AnnotationService,
	document: HexDocument,
): Promise<void> => {
	const view = await annotations.toView(document.uri);
	for (const messaging of registry.getMessaging(document)) {
		messaging.sendEvent({ type: MessageType.SetNvmAnnotations, annotations: view });
	}
};

/** Pick an existing tag or create a new one; returns its id. */
const promptForTag = async (
	annotations: AnnotationService,
	document: HexDocument,
): Promise<string | undefined> => {
	const set = await annotations.get(document.uri);
	const CREATE = "$(add) Create new tag…";
	const pick = await vscode.window.showQuickPick([CREATE, ...set.tags.map(t => t.label)], {
		title: "Assign NVM tag",
		placeHolder: "Pick a tag or create one",
	});
	if (!pick) {
		return undefined;
	}
	if (pick !== CREATE) {
		return set.tags.find(t => t.label === pick)?.id;
	}
	const label = await vscode.window.showInputBox({ title: "New tag", prompt: "Tag name" });
	if (!label) {
		return undefined;
	}
	const updated = await annotations.apply(document.uri, { kind: "createTag", label });
	return updated.tags.find(t => t.label === label)?.id;
};

export function registerAnnotationCommands(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
	const addBookmark = vscode.commands.registerCommand("hexEditor.nvm.addBookmarkHere", async () => {
		const t = resolveTarget(registry);
		if (!t) {
			return;
		}
		const label = await vscode.window.showInputBox({
			title: "New bookmark",
			prompt: "Bookmark label (optional)",
			value: `0x${t.focused.toString(16).toUpperCase()}`,
		});
		await annotations.apply(t.document.uri, {
			kind: "addBookmark",
			offset: t.focused,
			label: label || undefined,
		});
		await pushAnnotations(registry, annotations, t.document);
	});

	const addNote = vscode.commands.registerCommand("hexEditor.nvm.addNoteHere", async () => {
		const t = resolveTarget(registry);
		if (!t) {
			return;
		}
		const title = await vscode.window.showInputBox({
			title: "New note",
			prompt: "Note title",
			value: `Note @ 0x${t.start.toString(16).toUpperCase()}`,
		});
		if (title === undefined) {
			return;
		}
		await annotations.apply(t.document.uri, {
			kind: "addNote",
			start: t.start,
			end: t.end,
			title: title || undefined,
		});
		await pushAnnotations(registry, annotations, t.document);
	});

	const tagSelection = vscode.commands.registerCommand(
		"hexEditor.nvm.tagSelectionHere",
		async () => {
			const t = resolveTarget(registry);
			if (!t) {
				return;
			}
			const tagId = await promptForTag(annotations, t.document);
			if (!tagId) {
				return;
			}
			await annotations.apply(t.document.uri, {
				kind: "assignTag",
				tagId,
				start: t.start,
				end: t.end,
			});
			await pushAnnotations(registry, annotations, t.document);
		},
	);

	const removeTag = vscode.commands.registerCommand("hexEditor.nvm.removeTagHere", async () => {
		const t = resolveTarget(registry);
		if (!t) {
			return;
		}
		const set = await annotations.get(t.document.uri);
		const covering = set.tagAssignments.filter(a => {
			const s = a.anchor.offset;
			const e = a.anchor.endOffset ?? a.anchor.offset + 1;
			return t.focused >= s && t.focused < e;
		});
		if (covering.length === 0) {
			void vscode.window.showInformationMessage("No tag at the focused byte.");
			return;
		}
		for (const a of covering) {
			await annotations.apply(t.document.uri, { kind: "unassignTag", assignmentId: a.id });
		}
		await pushAnnotations(registry, annotations, t.document);
	});

	return [addBookmark, addNote, tagSelection, removeTag];
}
