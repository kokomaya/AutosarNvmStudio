// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Two-tier persistence for a user's dependency-file disambiguation choices.
 *
 * When auto-discovery finds several files with the same base name, the user picks
 * one. That choice is remembered so they aren't asked again — but the two natural
 * places to store it have opposite trade-offs, so we use BOTH:
 *
 *  - **Portable layer** — a *root-relative* path saved to the workspace settings
 *    (`hexeditor.nvm.fileChoices`). It can be committed and shared; on another
 *    machine it still resolves as long as the workspace root maps to the same
 *    tree, even though the absolute path differs per user.
 *  - **Machine-local cache** — the resolved *absolute* path in `workspaceState`
 *    (mirrors the `approvedEngines` pattern). Fast, and tolerant of a different
 *    root layout. When the portable relative path does NOT resolve on this
 *    machine, discovery re-prompts and both layers are refreshed.
 *
 * The store is vendor-blind: keys are plain base file names; it never interprets
 * what a file is.
 */

import * as vscode from "vscode";

const STATE_KEY = "hexeditor.nvm.fileChoices";
const SETTING_SECTION = "hexeditor";
const SETTING_KEY = "nvm.fileChoices";

/** A remembered choice for one base file name. */
export interface DependencyChoice {
	/** Absolute path resolved on THIS machine (machine-local cache). */
	absPath?: string;
	/** Path relative to the matched workspace root (portable, shareable). */
	relPath?: string;
	/** The root the relative path is relative to (a folder name or fsPath). */
	root?: string;
}

export class DependencyStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	/** All machine-local choices (base name → absolute path). */
	private localMap(): Record<string, string> {
		return this.context.workspaceState.get<Record<string, string>>(STATE_KEY, {});
	}

	/** All portable choices (base name → { relPath, root }). */
	private portableMap(): Record<string, { relPath: string; root: string }> {
		return (
			vscode.workspace
				.getConfiguration(SETTING_SECTION)
				.get<Record<string, { relPath: string; root: string }>>(SETTING_KEY, {}) ?? {}
		);
	}

	/** The remembered choice for a base name, merging both layers. */
	public get(baseName: string): DependencyChoice | undefined {
		const key = baseName.toLowerCase();
		const abs = this.localMap()[key];
		const portable = this.portableMap()[key];
		if (!abs && !portable) {
			return undefined;
		}
		return { absPath: abs, relPath: portable?.relPath, root: portable?.root };
	}

	/** Remember a choice in both layers. `root`/`relPath` are optional (portable). */
	public async set(
		baseName: string,
		absPath: string,
		portable?: { relPath: string; root: string },
	): Promise<void> {
		const key = baseName.toLowerCase();
		const local = { ...this.localMap(), [key]: absPath };
		await this.context.workspaceState.update(STATE_KEY, local);
		if (portable) {
			const shared = { ...this.portableMap(), [key]: portable };
			await vscode.workspace
				.getConfiguration(SETTING_SECTION)
				.update(SETTING_KEY, shared, vscode.ConfigurationTarget.Workspace);
		}
	}

	/** Forget a choice in both layers (used by the "reselect dependency" command). */
	public async clear(baseName: string): Promise<void> {
		const key = baseName.toLowerCase();
		const local = { ...this.localMap() };
		delete local[key];
		await this.context.workspaceState.update(STATE_KEY, local);
		const shared = { ...this.portableMap() };
		if (shared[key]) {
			delete shared[key];
			await vscode.workspace
				.getConfiguration(SETTING_SECTION)
				.update(SETTING_KEY, shared, vscode.ConfigurationTarget.Workspace);
		}
	}

	/** The base names of all remembered choices (either layer), for the reselect UI. */
	public keys(): string[] {
		return [...new Set([...Object.keys(this.localMap()), ...Object.keys(this.portableMap())])];
	}
}
