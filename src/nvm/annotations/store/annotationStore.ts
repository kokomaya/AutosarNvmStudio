// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage backend abstraction for annotations. Two implementations exist:
 * {@link SidecarStore} (default — portable files next to the dump) and
 * {@link WorkspaceStateStore}. The active backend is chosen by the
 * `nvmstudio.nvm.annotationStorage` setting.
 */

import * as vscode from "vscode";
import { AnnotationSet } from "../model";

export interface AnnotationStore {
	/** Load the annotation set for a dump (empty set if none). */
	load(docUri: vscode.Uri): Promise<AnnotationSet>;
	/** Persist the annotation set for a dump. */
	save(docUri: vscode.Uri, set: AnnotationSet): Promise<void>;
	/** Read a note's markdown body. */
	readNote(docUri: vscode.Uri, noteId: string): Promise<string>;
	/** Write a note's markdown body; returns the reference to store on the note. */
	writeNote(docUri: vscode.Uri, noteId: string, body: string): Promise<{ file?: string; body?: string }>;
	/** Resolve a note to an openable/editable URI, when the backend has one. */
	noteUri?(docUri: vscode.Uri, noteId: string): vscode.Uri | undefined;
}
