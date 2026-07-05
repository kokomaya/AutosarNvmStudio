// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace-state annotation store. Keeps everything (including note bodies,
 * inline) in VS Code workspace state, keyed by the dump URI. Not shareable but
 * requires no files next to the dump.
 */

import * as vscode from "vscode";
import { AnnotationSet, coerceAnnotationSet, emptyAnnotationSet } from "../model";
import { AnnotationStore } from "./annotationStore";

const KEY_PREFIX = "hexeditor.nvm.annotations:";

export class WorkspaceStateStore implements AnnotationStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	private key(docUri: vscode.Uri): string {
		return KEY_PREFIX + docUri.toString();
	}

	public async load(docUri: vscode.Uri): Promise<AnnotationSet> {
		const raw = this.context.workspaceState.get<AnnotationSet>(this.key(docUri));
		return raw ? coerceAnnotationSet(raw) : emptyAnnotationSet();
	}

	public async save(docUri: vscode.Uri, set: AnnotationSet): Promise<void> {
		await this.context.workspaceState.update(this.key(docUri), set);
	}

	public async readNote(docUri: vscode.Uri, noteId: string): Promise<string> {
		const set = await this.load(docUri);
		return set.notes.find(n => n.id === noteId)?.body ?? "";
	}

	public async writeNote(
		_docUri: vscode.Uri,
		_noteId: string,
		body: string,
	): Promise<{ body?: string }> {
		// Inline: the body is stored on the note itself by the service.
		return { body };
	}
}
