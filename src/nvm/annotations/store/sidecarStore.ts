// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Sidecar annotation store (default). For a dump `foo.mot` it keeps:
 *   - `foo.mot.nvmstudio.json`   — the annotation set (metadata)
 *   - `foo.mot.nvmstudio/`       — a folder of note markdown files + images
 *
 * Portable and shareable: commit the sidecar alongside the dump and the notes
 * travel with it.
 */

import * as vscode from "vscode";
import { AnnotationSet, coerceAnnotationSet, emptyAnnotationSet } from "../model";
import { AnnotationStore } from "./annotationStore";

const enc = new TextEncoder();
const dec = new TextDecoder("utf8");

export class SidecarStore implements AnnotationStore {
	private sidecarUri(docUri: vscode.Uri): vscode.Uri {
		return docUri.with({ path: `${docUri.path}.nvmstudio.json` });
	}

	private folderUri(docUri: vscode.Uri): vscode.Uri {
		return docUri.with({ path: `${docUri.path}.nvmstudio` });
	}

	public async load(docUri: vscode.Uri): Promise<AnnotationSet> {
		try {
			const buf = await vscode.workspace.fs.readFile(this.sidecarUri(docUri));
			return coerceAnnotationSet(JSON.parse(dec.decode(buf)));
		} catch {
			return emptyAnnotationSet();
		}
	}

	public async save(docUri: vscode.Uri, set: AnnotationSet): Promise<void> {
		await vscode.workspace.fs.writeFile(
			this.sidecarUri(docUri),
			enc.encode(JSON.stringify(set, null, 2)),
		);
	}

	public noteUri(docUri: vscode.Uri, noteId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.folderUri(docUri), `${noteId}.md`);
	}

	public async readNote(docUri: vscode.Uri, noteId: string): Promise<string> {
		try {
			return dec.decode(await vscode.workspace.fs.readFile(this.noteUri(docUri, noteId)));
		} catch {
			return "";
		}
	}

	public async writeNote(
		docUri: vscode.Uri,
		noteId: string,
		body: string,
	): Promise<{ file?: string }> {
		await vscode.workspace.fs.createDirectory(this.folderUri(docUri));
		await vscode.workspace.fs.writeFile(this.noteUri(docUri, noteId), enc.encode(body));
		return { file: `${noteId}.md` };
	}
}
