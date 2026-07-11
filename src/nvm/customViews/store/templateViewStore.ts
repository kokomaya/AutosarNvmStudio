// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable-template custom-view store. Templates are workspace-wide (not tied to
 * a single dump): they live in `context.workspaceState` under one key, and the
 * service applies them to any dump whose blocks a template's selectors match. So
 * the `docUri` argument is ignored here — every dump sees the same template set.
 */

import * as vscode from "vscode";
import { coerceViewSet, emptyViewSet, NvmCustomViewSet } from "../model";
import { CustomViewStore } from "./customViewStore";

const KEY = "nvmstudio.nvm.customViews.templates";

export class TemplateViewStore implements CustomViewStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	public async load(_docUri: vscode.Uri): Promise<NvmCustomViewSet> {
		const raw = this.context.workspaceState.get<NvmCustomViewSet>(KEY);
		return raw ? coerceViewSet(raw) : emptyViewSet();
	}

	public async save(_docUri: vscode.Uri, set: NvmCustomViewSet): Promise<void> {
		await this.context.workspaceState.update(KEY, set);
	}
}
