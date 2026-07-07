// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Recursive dependency-file discovery.
 *
 * The core's built-in lookup only searches the dump folder + `./conf` + `../conf`.
 * When a declared source (e.g. `Fee_Lcfg.c`, `Dem_Lcfg.h`) lives elsewhere under a
 * large project tree, this resolver finds it by recursively indexing the user's
 * configured **workspace roots** (`nvmstudio.nvm.workspaceRoots`). When a base
 * name matches several files, the user disambiguates once and the choice is
 * persisted (see {@link DependencyStore}) and reused.
 *
 * Vendor-blind: it only matches by base file name; it never interprets a file's
 * meaning. It performs NO downloads — remote files must be fetched by the user
 * into a root beforehand.
 */

import * as vscode from "vscode";
import { DependencyStore } from "./dependencyStore";

/** File extensions worth indexing (config / source / descriptor / engine). */
const INDEX_GLOB =
	"**/*.{arxml,xml,nvmlayout.json,h,c,json,blk,engine.js,engine.cjs,engine.mjs}";
/** Directories never worth walking. */
const EXCLUDE_GLOB = "**/{node_modules,.git,out,dist,.vscode-test,build}/**";
/** Safety cap so a huge tree can't hang discovery. */
const MAX_RESULTS = 20000;

export class DependencyResolver {
	/** base name (lower) → absolute fsPaths found across the roots. */
	private index: Map<string, string[]> | undefined;

	constructor(
		private readonly store: DependencyStore,
		private readonly roots: () => string[],
	) {}

	/** Drop the cached index (e.g. after roots change). */
	public invalidate(): void {
		this.index = undefined;
	}

	/** Expand `${workspaceFolder}` and resolve the configured roots to fsPaths. */
	private resolvedRoots(): string[] {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const first = folders[0]?.uri.fsPath ?? "";
		const out: string[] = [];
		for (const raw of this.roots()) {
			if (!raw) {
				continue;
			}
			let p = raw.replace(/\$\{workspaceFolder\}/g, first);
			// Also support ${workspaceFolder:Name} for multi-root workspaces.
			p = p.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_m, name: string) => {
				const f = folders.find(w => w.name === name);
				return f ? f.uri.fsPath : "";
			});
			if (p) {
				out.push(p);
			}
		}
		return out;
	}

	/** Build (once) the base-name → paths index across the configured roots. */
	private async buildIndex(): Promise<Map<string, string[]>> {
		if (this.index) {
			return this.index;
		}
		const index = new Map<string, string[]>();
		for (const root of this.resolvedRoots()) {
			try {
				const pattern = new vscode.RelativePattern(vscode.Uri.file(root), INDEX_GLOB);
				const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, MAX_RESULTS);
				for (const uri of uris) {
					const base = uri.fsPath.replace(/^.*[\\/]/, "").toLowerCase();
					const list = index.get(base) ?? [];
					if (!list.includes(uri.fsPath)) {
						list.push(uri.fsPath);
					}
					index.set(base, list);
				}
			} catch {
				// A missing/invalid root is skipped rather than aborting discovery.
			}
		}
		this.index = index;
		return index;
	}

	/** True when the user configured at least one workspace root. */
	public hasRoots(): boolean {
		return this.resolvedRoots().length > 0;
	}

	/**
	 * Resolve one file by base name across the roots, honoring a persisted choice,
	 * prompting to disambiguate duplicates, and persisting the pick. Returns the
	 * absolute fsPath, or undefined if not found / the prompt was dismissed.
	 */
	public async resolve(fileName: string): Promise<string | undefined> {
		const base = fileName.replace(/^.*[\\/]/, "");
		const key = base.toLowerCase();

		// 1) A remembered machine-local absolute path that still exists wins.
		const remembered = this.store.get(base);
		if (remembered?.absPath && (await exists(remembered.absPath))) {
			return remembered.absPath;
		}
		// 2) A remembered portable relative path re-resolved under a current root.
		if (remembered?.relPath) {
			for (const root of this.resolvedRoots()) {
				const abs = joinPath(root, remembered.relPath);
				if (await exists(abs)) {
					// Refresh the machine-local cache for next time.
					await this.store.set(base, abs, { relPath: remembered.relPath, root });
					return abs;
				}
			}
		}

		// 3) Index the roots and look up by base name.
		const index = await this.buildIndex();
		const candidates = index.get(key) ?? [];
		if (candidates.length === 0) {
			return undefined;
		}
		let chosen: string | undefined;
		if (candidates.length === 1) {
			chosen = candidates[0];
		} else {
			chosen = await this.promptDisambiguate(base, candidates);
			if (!chosen) {
				return undefined;
			}
		}
		await this.remember(base, chosen);
		return chosen;
	}

	/** Persist a chosen absolute path with a best-effort portable relative form. */
	private async remember(base: string, absPath: string): Promise<void> {
		const portable = this.toPortable(absPath);
		await this.store.set(base, absPath, portable);
	}

	/** Express an absolute path as { relPath, root } under a configured root, if any. */
	private toPortable(absPath: string): { relPath: string; root: string } | undefined {
		const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
		const a = norm(absPath);
		for (const root of this.resolvedRoots()) {
			const r = norm(root);
			if (a.toLowerCase().startsWith(r.toLowerCase() + "/")) {
				return { relPath: a.slice(r.length + 1), root };
			}
		}
		return undefined;
	}

	/** Ask the user which duplicate to use, showing paths relative to their root. */
	private async promptDisambiguate(
		base: string,
		candidates: string[],
	): Promise<string | undefined> {
		const items = candidates.map(fsPath => {
			const portable = this.toPortable(fsPath);
			return {
				label: base,
				description: portable ? portable.relPath : fsPath,
				detail: fsPath,
				fsPath,
			};
		});
		const pick = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Multiple files named “{0}” found", base),
			placeHolder: vscode.l10n.t("Choose which one to use (remembered for next time)"),
			matchOnDetail: true,
		});
		return (pick as { fsPath?: string } | undefined)?.fsPath;
	}
}

/** Read the configured workspace roots from settings. */
export function configuredRoots(): string[] {
	const cfg = vscode.workspace.getConfiguration();
	const next = cfg.get<string[]>("nvmstudio.nvm.workspaceRoots", []);
	if (Array.isArray(next) && next.length > 0) {
		return next;
	}
	// Backward compatibility with the previous setting id.
	return cfg.get<string[]>("hexeditor.nvm.workspaceRoots", []) ?? [];
}

/** Expand `${workspaceFolder}` / `${workspaceFolder:Name}` in a configured path. */
function expandWorkspaceVars(raw: string): string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const first = folders[0]?.uri.fsPath ?? "";
	let p = raw.replace(/\$\{workspaceFolder\}/g, first);
	p = p.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_m, name: string) => {
		const f = folders.find(w => w.name === name);
		return f ? f.uri.fsPath : "";
	});
	return p;
}

/**
 * Read the configured global layout-descriptor roots (`nvmstudio.nvm.layoutRoots`),
 * expanded to fsPaths. These folders are scanned directly for `*.nvmlayout.json`
 * so descriptors can live in a shared location instead of next to each dump.
 */
export function configuredLayoutRoots(): string[] {
	const raw = vscode.workspace.getConfiguration().get<string[]>("nvmstudio.nvm.layoutRoots", []) ?? [];
	const out: string[] = [];
	for (const r of raw) {
		if (!r) {
			continue;
		}
		const p = expandWorkspaceVars(r);
		if (p) {
			out.push(p);
		}
	}
	return out;
}

/**
 * The process-wide dependency resolver, shared by the editor provider (for
 * fallback file lookup) and the "reselect dependency" command. Created on first
 * use; invalidated when the roots setting changes.
 */
let sharedResolver: DependencyResolver | undefined;
let sharedStore: DependencyStore | undefined;

export function getDependencyResolver(context: vscode.ExtensionContext): DependencyResolver {
	if (!sharedResolver) {
		sharedStore = new DependencyStore(context);
		sharedResolver = new DependencyResolver(sharedStore, configuredRoots);
	}
	return sharedResolver;
}

export function getDependencyStore(context: vscode.ExtensionContext): DependencyStore {
	getDependencyResolver(context);
	return sharedStore!;
}

/** Invalidate the shared resolver's cached index (e.g. on settings change). */
export function invalidateDependencyResolver(): void {
	sharedResolver?.invalidate();
}

/** Join a root and a relative path with forward slashes (works for fs.stat). */
function joinPath(root: string, rel: string): string {
	return `${root.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

/** Whether a file exists at the given fsPath. */
async function exists(fsPath: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
		return true;
	} catch {
		return false;
	}
}
