// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Engine pack manager — install / download / resolve external NVM engines.
 *
 * The extension core ships no vendor layout. Engines are **packs** the user
 * installs (from a local folder/file) or downloads (from a URL) into the
 * extension's global storage. A `*.nvmlayout.json` references an installed pack
 * by id (`"engine": "vector-fee-v3"`); the manager resolves that id to the
 * pack's entry script, which the (gated) loader then runs.
 *
 * Installing / running workspace or downloaded JavaScript is code execution and
 * stays gated by Workspace Trust + `hexeditor.nvm.allowExternalEngines` + a
 * per-file confirmation (enforced in `hexEditorProvider.ts`).
 */

import * as vscode from "vscode";

/** An engine pack manifest (`engine.json`). */
export interface EngineManifest {
	/** Stable pack id, referenced by descriptors via `"engine"`. */
	id: string;
	/** Semver-ish version string. */
	version?: string;
	displayName?: string;
	description?: string;
	/** Entry script file name, relative to the pack folder. */
	entry: string;
	publisher?: string;
	/** Where the pack came from (e.g. "bundled", a URL, a folder path). */
	source?: string;
	/** SDK contract version the pack was written against. */
	sdkVersion?: number;
	capabilities?: {
		sources?: Record<string, string>;
		options?: string[];
	};
}

/** A pack installed under global storage. */
export interface InstalledEngine {
	manifest: EngineManifest;
	/** The pack folder. */
	dir: vscode.Uri;
	/** The resolved entry script. */
	entryUri: vscode.Uri;
}

function isManifest(value: unknown): value is EngineManifest {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as EngineManifest).id === "string" &&
		typeof (value as EngineManifest).entry === "string"
	);
}

/** Sanitize an id into a safe folder name. */
function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class EngineManager {
	/** Root folder for user-installed / downloaded packs: `<globalStorage>/engines`. */
	private readonly root: vscode.Uri;
	/** Read-only packs shipped with the extension: `<extension>/dist/engines`. */
	private readonly bundledRoot: vscode.Uri;
	/** Only resolve bundled packs in the F5 dev host, never in a shipped build. */
	private readonly allowBundled: boolean;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.root = vscode.Uri.joinPath(context.globalStorageUri, "engines");
		this.bundledRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "engines");
		this.allowBundled = context.extensionMode === vscode.ExtensionMode.Development;
	}

	private async ensureRoot(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.root);
	}

	/** List every installed pack (skips folders without a valid manifest). */
	public async list(): Promise<InstalledEngine[]> {
		const out: InstalledEngine[] = [];
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(this.root);
		} catch {
			return out;
		}
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) {
				continue;
			}
			const dir = vscode.Uri.joinPath(this.root, name);
			const engine = await this.readPack(dir);
			if (engine) {
				out.push(engine);
			}
		}
		return out;
	}

	/** Resolve a pack by id (an optional `@version` suffix is ignored). */
	public async resolve(ref: string): Promise<InstalledEngine | undefined> {
		const id = ref.split("@")[0].trim();
		// 1. A user-installed / downloaded pack in global storage wins (lets a user
		//    override a bundled engine by installing their own with the same id).
		const dir = vscode.Uri.joinPath(this.root, safeId(id));
		const direct = await this.readPack(dir);
		if (direct?.manifest.id === id) {
			return direct;
		}
		const scanned = (await this.list()).find(e => e.manifest.id === id);
		if (scanned) {
			return scanned;
		}
		// 2. DEBUG ONLY: fall back to a pack the extension ships under
		//    `dist/engines/*`, loaded in place — `npm run compile` writes it there,
		//    so there is nothing to install: rebuild + reload the window and the new
		//    code is picked up. Disabled in shipped builds, where production must use
		//    a real global install or a project-local `engineScript`.
		if (!this.allowBundled) {
			return undefined;
		}
		return this.resolveBundled(id);
	}

	/** Find a bundled pack (`<extension>/dist/engines/*`) by id, read in place. */
	private async resolveBundled(id: string): Promise<InstalledEngine | undefined> {
		const guess = await this.readPack(vscode.Uri.joinPath(this.bundledRoot, safeId(id)));
		if (guess?.manifest.id === id) {
			return guess;
		}
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(this.bundledRoot);
		} catch {
			return undefined;
		}
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) {
				continue;
			}
			const pack = await this.readPack(vscode.Uri.joinPath(this.bundledRoot, name));
			if (pack?.manifest.id === id) {
				return pack;
			}
		}
		return undefined;
	}

	/** Read + validate a pack folder's manifest and entry. */
	private async readPack(dir: vscode.Uri): Promise<InstalledEngine | undefined> {
		try {
			const manifestUri = vscode.Uri.joinPath(dir, "engine.json");
			const buf = await vscode.workspace.fs.readFile(manifestUri);
			const manifest = JSON.parse(new TextDecoder("utf8").decode(buf));
			if (!isManifest(manifest)) {
				return undefined;
			}
			const entryUri = vscode.Uri.joinPath(dir, manifest.entry);
			await vscode.workspace.fs.stat(entryUri);
			return { manifest, dir, entryUri };
		} catch {
			return undefined;
		}
	}

	/**
	 * Install a pack from a local folder containing an `engine.json`. Copies the
	 * whole folder into global storage under the pack id.
	 */
	public async installFromFolder(src: vscode.Uri): Promise<InstalledEngine> {
		const pack = await this.readPack(src);
		if (!pack) {
			throw new Error(`No valid engine.json found in ${src.fsPath}`);
		}
		await this.ensureRoot();
		const dest = vscode.Uri.joinPath(this.root, safeId(pack.manifest.id));
		await this.copyRecursive(src, dest);
		const installed = await this.readPack(dest);
		if (!installed) {
			throw new Error("Engine pack failed to install (copy incomplete).");
		}
		return installed;
	}

	/**
	 * Install a pack from a single `.engine.js` file. Synthesizes a manifest with
	 * the given id (defaults to the file's base name).
	 */
	public async installFromFile(src: vscode.Uri, id?: string): Promise<InstalledEngine> {
		const base = src.path.replace(/^.*\//, "");
		const packId = safeId(id || base.replace(/\.engine\.js$/i, "").replace(/\.js$/i, ""));
		await this.ensureRoot();
		const dest = vscode.Uri.joinPath(this.root, packId);
		await vscode.workspace.fs.createDirectory(dest);
		const entryName = "engine.js";
		await vscode.workspace.fs.copy(src, vscode.Uri.joinPath(dest, entryName), { overwrite: true });
		await this.writeManifest(dest, {
			id: packId,
			entry: entryName,
			displayName: packId,
			source: src.fsPath,
		});
		return (await this.readPack(dest))!;
	}

	/**
	 * Download a single-file engine from a URL into a new pack. The caller must
	 * have already confirmed trust in the source (see the install command).
	 */
	public async installFromUrl(url: string, id?: string): Promise<InstalledEngine> {
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`Download failed: ${res.status} ${res.statusText}`);
		}
		const text = await res.text();
		const base = url.replace(/[?#].*$/, "").replace(/^.*\//, "");
		const packId = safeId(id || base.replace(/\.engine\.js$/i, "").replace(/\.js$/i, "") || "engine");
		await this.ensureRoot();
		const dest = vscode.Uri.joinPath(this.root, packId);
		await vscode.workspace.fs.createDirectory(dest);
		const entryName = "engine.js";
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dest, entryName),
			new TextEncoder().encode(text),
		);
		await this.writeManifest(dest, {
			id: packId,
			entry: entryName,
			displayName: packId,
			source: url,
		});
		return (await this.readPack(dest))!;
	}

	/** Remove an installed pack by id. */
	public async remove(id: string): Promise<void> {
		const dir = vscode.Uri.joinPath(this.root, safeId(id));
		try {
			await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
		} catch {
			// already gone
		}
	}

	private async writeManifest(dir: vscode.Uri, manifest: EngineManifest): Promise<void> {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, "engine.json"),
			new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
		);
	}

	private async copyRecursive(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
		await vscode.workspace.fs.createDirectory(dest);
		for (const [name, type] of await vscode.workspace.fs.readDirectory(src)) {
			const s = vscode.Uri.joinPath(src, name);
			const d = vscode.Uri.joinPath(dest, name);
			if (type === vscode.FileType.Directory) {
				await this.copyRecursive(s, d);
			} else {
				await vscode.workspace.fs.copy(s, d, { overwrite: true });
			}
		}
	}
}
