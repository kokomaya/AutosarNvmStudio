// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage backend abstraction for custom views. Two implementations exist:
 * {@link SidecarViewStore} (per-dump, portable — rides next to the dump) and
 * {@link TemplateViewStore} (workspace-wide reusable templates). The service
 * uses both simultaneously (a view's `scope` decides which backend owns it),
 * so unlike annotations there is no single-backend setting.
 */

import * as vscode from "vscode";
import { NvmCustomViewSet } from "../model";

export interface CustomViewStore {
	/** Load the view set (empty set if none). */
	load(docUri: vscode.Uri): Promise<NvmCustomViewSet>;
	/** Persist the view set. */
	save(docUri: vscode.Uri, set: NvmCustomViewSet): Promise<void>;
}
