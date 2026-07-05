// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Column (display-attribute) selection for the Blocks views. The set of columns
 * a user can pick from is discovered dynamically from the current blocks'
 * {@link NvmAttribute} keys — the plugin never hard-codes vendor columns. The
 * chosen keys and the active arrangement are persisted in workspace state.
 */

import * as vscode from "vscode";

const SELECTED_KEY = "hexeditor.nvm.blocks.selectedColumns";
const ARRANGEMENT_KEY = "hexeditor.nvm.blocks.arrangement";

export class BlockViewConfig {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires when the selected columns or arrangement change. */
	public readonly onDidChange = this._onDidChange.event;

	constructor(private readonly state: vscode.Memento) {}

	/** The user-selected column keys, or `undefined` when defaults apply. */
	public get selectedColumns(): string[] | undefined {
		return this.state.get<string[]>(SELECTED_KEY);
	}

	public async setSelectedColumns(keys: string[]): Promise<void> {
		await this.state.update(SELECTED_KEY, keys);
		this._onDidChange.fire();
	}

	/** The active arrangement id (defaults to "flat" via the caller). */
	public get arrangementId(): string | undefined {
		return this.state.get<string>(ARRANGEMENT_KEY);
	}

	public async setArrangementId(id: string): Promise<void> {
		await this.state.update(ARRANGEMENT_KEY, id);
		this._onDidChange.fire();
	}

	/**
	 * Resolve the effective columns to render: the user's selection filtered to
	 * keys that still exist, else all available keys (default = show everything).
	 */
	public effectiveColumns(availableKeys: readonly string[]): string[] {
		const selected = this.selectedColumns;
		if (!selected) {
			return [...availableKeys];
		}
		const available = new Set(availableKeys);
		const kept = selected.filter(k => available.has(k));
		return kept.length > 0 ? kept : [...availableKeys];
	}

	public dispose(): void {
		this._onDidChange.dispose();
	}
}
