// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-dump custom-view store. For a dump `foo.mot` it keeps a single
 * `foo.mot.nvmviews.json` next to the dump — portable and shareable, so the
 * views travel with the dump when committed. Mirrors the annotations
 * {@link ../../annotations/store/sidecarStore.SidecarStore} convention.
 */

import * as vscode from "vscode";
import { coerceViewSet, emptyViewSet, NvmCustomViewSet } from "../model";
import { CustomViewStore } from "./customViewStore";

const enc = new TextEncoder();
const dec = new TextDecoder("utf8");

export class SidecarViewStore implements CustomViewStore {
	private sidecarUri(docUri: vscode.Uri): vscode.Uri {
		return docUri.with({ path: `${docUri.path}.nvmviews.json` });
	}

	public async load(docUri: vscode.Uri): Promise<NvmCustomViewSet> {
		try {
			const buf = await vscode.workspace.fs.readFile(this.sidecarUri(docUri));
			return coerceViewSet(JSON.parse(dec.decode(buf)));
		} catch {
			return emptyViewSet();
		}
	}

	public async save(docUri: vscode.Uri, set: NvmCustomViewSet): Promise<void> {
		await vscode.workspace.fs.writeFile(
			this.sidecarUri(docUri),
			enc.encode(JSON.stringify(set, null, 2)),
		);
	}
}
