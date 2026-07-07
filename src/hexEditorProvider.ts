// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TelemetryReporter } from "@vscode/extension-telemetry";
import * as vscode from "vscode";
import {
	HexDocumentEdit,
	HexDocumentEditOp,
	HexDocumentEditReference,
} from "../shared/hexDocumentModel";
import {
	CopyFormat,
	Endianness,
	ExtensionHostMessageHandler,
	FromWebviewMessage,
	ICodeSettings,
	IEditorSettings,
	InspectorLocation,
	MessageHandler,
	MessageType,
	NvmBlockInfo,
	PasteMode,
	ToWebviewMessage,
} from "../shared/protocol";
import { deserializeEdits, serializeEdits } from "../shared/serialization";
import { ILocalizedStrings, placeholder1 } from "../shared/strings";
import { copyAsFormats } from "./copyAs";
import { DataInspectorView } from "./dataInspectorView";
import { disposeAll } from "./dispose";
import { HexDocument } from "./hexDocument";
import { HexEditorRegistry } from "./hexEditorRegistry";
import { AnnotationService } from "./nvm/annotations/annotationService";
import { addBlockToCustomView } from "./nvm/customViews/addToView";
import { CustomViewService } from "./nvm/customViews/customViewService";
import {
	configuredLayoutRoots,
	getDependencyResolver,
	invalidateDependencyResolver,
} from "./nvm/discovery/fileIndex";
import { EngineManager } from "./nvm/engines/engineManager";
import {
	applyPalette,
	LayoutConfig,
	LayoutInput,
	matchesConfig,
	matchSpecificity,
	ResolveContext,
	ResolvedLayout,
	resolveImage,
	resolveNvmBlocks,
	resolveSymbols,
} from "./nvm/layout";
import { invalidateExternalEngine, isNodeHost, loadExternalEngine } from "./nvm/layout/externalEngine";
import { ISearchRequest, LiteralSearchRequest, RegexSearchRequest } from "./searchRequest";
import { flattenBuffers, getBaseName, getCorrectArrayBuffer, randomString } from "./util";

const defaultEditorSettings: Readonly<IEditorSettings> = {
	columnWidth: 16,
	copyType: CopyFormat.HexOctets,
	showDecodedText: true,
	defaultEndianness: Endianness.Little,
	inspectorType: InspectorLocation.Aside,
};

const editorSettingsKeys = Object.keys(defaultEditorSettings) as readonly (keyof IEditorSettings)[];

/** Result of NVM auto-detection, plus the engine script to watch for hot reload. */
interface NvmLoadResult {
	resolved: ResolvedLayout;
	/** Set when an external engine produced the blocks; watched for hot reload. */
	engineScriptUri?: vscode.Uri;
}

export class HexEditorProvider implements vscode.CustomEditorProvider<HexDocument> {
	public static register(
		context: vscode.ExtensionContext,
		telemetryReporter: TelemetryReporter,
		dataInspectorView: DataInspectorView,
		registry: HexEditorRegistry,
		annotations: AnnotationService,
		customViews: CustomViewService,
	): vscode.Disposable {
		const provider = new HexEditorProvider(
			context,
			telemetryReporter,
			dataInspectorView,
			registry,
			annotations,
			customViews,
		);
		const editor = vscode.window.registerCustomEditorProvider(
			HexEditorProvider.viewType,
			provider,
			{
				supportsMultipleEditorsPerDocument: false,
			},
		);
		// Manual "reparse the active dump" command — for when a layout descriptor,
		// declared source file or engine changed and the user wants fresh blocks
		// without closing and reopening the file.
		const reloadCmd = vscode.commands.registerCommand("nvmStudio.nvm.reloadLayout", () =>
			provider.reloadActiveNvmLayout(),
		);
		// When the discovery roots change, re-parse every open dump so newly found
		// descriptors / source files take effect without a reopen.
		const cfgWatch = vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration("nvmstudio.nvm.workspaceRoots") ||
				e.affectsConfiguration("nvmstudio.nvm.layoutRoots") ||
				e.affectsConfiguration("hexeditor.nvm.workspaceRoots")
			) {
				void provider.reloadAllNvmLayouts();
			}
		});
		return vscode.Disposable.from(editor, reloadCmd, cfgWatch);
	}

	private static readonly viewType = "hexEditor.hexedit";

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _telemetryReporter: TelemetryReporter,
		private readonly _dataInspectorView: DataInspectorView,
		private readonly _registry: HexEditorRegistry,
		private readonly _annotations: AnnotationService,
		private readonly _customViews: CustomViewService,
	) {}

	/** Lazily-created manager for installed external engine packs. */
	private _engineManager?: EngineManager;
	private get engineManager(): EngineManager {
		return (this._engineManager ??= new EngineManager(this._context));
	}

	/**
	 * Per-open-document callback that re-parses the dump and pushes fresh NVM
	 * blocks to its webview. Used by the manual reload command, the config-change
	 * watcher, and the descriptor/source/engine file watchers.
	 */
	private readonly _nvmReloaders = new Map<HexDocument, () => Promise<void>>();

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): Promise<HexDocument> {
		const diff = this._registry.getDiff(uri);

		const { document, accessor } = await HexDocument.create(
			uri,
			openContext,
			this._telemetryReporter,
			diff.builder,
		);
		const disposables: vscode.Disposable[] = [];
		disposables.push(diff);
		disposables.push(
			document.onDidRevert(async () => {
				const replaceFileSize = (await document.size()) ?? null;
				for (const messaging of this._registry.getMessaging(document)) {
					messaging.sendEvent({
						type: MessageType.SetEdits,
						edits: { edits: [], data: new Uint8Array() },
						replaceFileSize,
					});
					messaging.sendEvent({ type: MessageType.ReloadFromDisk });
				}
			}),

			document.onDidChangeEditMode(mode => {
				for (const messaging of this._registry.getMessaging(document)) {
					messaging.sendEvent({
						type: MessageType.SetEditMode,
						mode: mode,
					});
				}
			}),
		);

		const overwrite = vscode.l10n.t("Overwrite");
		const onDidChange = async () => {
			if (document.isSynced) {
				// If we executed a save recently the change was probably caused by us
				// we shouldn't trigger a revert to resync the document as it is already sync
				const recentlySaved = Date.now() - document.lastSave < 5_000;
				if (!recentlySaved) {
					document.revert();
				}
				return;
			}

			const message = vscode.l10n.t(
				"This file has changed on disk, but you have unsaved changes. Saving now will overwrite the file on disk with your changes.",
			);
			const revert = vscode.l10n.t("Revert");
			const selected = await vscode.window.showWarningMessage(message, overwrite, revert);
			if (selected === overwrite) {
				vscode.commands.executeCommand("workbench.action.files.save");
			} else if (selected === revert) {
				vscode.commands.executeCommand("workbench.action.files.revert");
			}
		};

		const onDidDelete = () => {
			for (const group of vscode.window.tabGroups.all) {
				for (const editor of group.tabs) {
					if (editor.input === document) {
						vscode.window.tabGroups.close(editor, true);
					}
				}
			}
		};

		disposables.push(accessor.watch(onDidChange, onDidDelete));

		document.onDidDispose(() => disposeAll(disposables));

		return document;
	}

	async resolveCustomEditor(
		document: HexDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const messageHandler: ExtensionHostMessageHandler = new MessageHandler(
			message => this.onMessage(messageHandler, document, message),
			message => webviewPanel.webview.postMessage(message),
		);

		// Add the webview to our internal set of active webviews
		const handle = this._registry.add(document, messageHandler);
		webviewPanel.onDidDispose(() => handle.dispose());

		// Auto-detect NVM structure for the opened binary. Layout comes ONLY from
		// `*.nvmlayout.json` descriptors (near the dump / in ./conf / ../conf):
		// the registered adapters run against them; nothing else produces a layout.
		this.setupNvmLayout(document, webviewPanel, messageHandler);

		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
		webviewPanel.webview.onDidReceiveMessage(e => messageHandler.handleMessage(e));
	}

	/**
	 * Wire up NVM layout detection for one opened dump: run an initial parse and
	 * push, register a reload callback (for the manual command + config watcher),
	 * and watch the layout descriptors / declared source files / engine script so
	 * edits refresh the blocks live without reopening the file.
	 */
	private setupNvmLayout(
		document: HexDocument,
		webviewPanel: vscode.WebviewPanel,
		messageHandler: ExtensionHostMessageHandler,
	): void {
		const fsPath = document.uri.fsPath;
		if (!fsPath) {
			return;
		}
		// compute directory using string-safe operations to avoid importing node 'path'
		const dir = fsPath.replace(/[\\/][^\\/]+$/, "");
		const disposables: vscode.Disposable[] = [];

		// The engine hot-reload watcher is (re)created whenever the resolved engine
		// script path changes across reloads.
		let engineWatcher: vscode.Disposable | undefined;
		let engineScript: string | undefined;

		const doLoad = async (): Promise<void> => {
			try {
				const result = await this.tryLoadNvmBlocks(document, fsPath, dir);
				const allBlocks = result?.resolved.blocks ?? [];
				this._registry.setNvmBlocks(document, allBlocks.length > 0 ? allBlocks : undefined);

				// Staged push: some engines (e.g. Vector FEE V3) recover hundreds
				// of historical (`stale`) block copies. Push the current versions
				// first so the editor is instantly interactive, then push the full
				// set on the next tick so the history fills in without blocking.
				const currentBlocks = allBlocks.filter(
					b => !(b.raw as { stale?: boolean } | undefined)?.stale,
				);
				const hasStale = currentBlocks.length !== allBlocks.length;
				messageHandler.sendEvent({
					type: MessageType.SetNvmBlocks,
					blocks: hasStale ? currentBlocks : allBlocks,
				});
				if (hasStale) {
					setTimeout(() => {
						messageHandler.sendEvent({
							type: MessageType.SetNvmBlocks,
							blocks: allBlocks,
						});
					}, 0);
				}
				if (result && allBlocks.length > 0) {
					console.debug(
						`Auto-loaded NVM layout [${result.resolved.providerId}] ${fsPath} -> ${allBlocks.length} blocks` +
							(hasStale ? ` (${currentBlocks.length} current, ${allBlocks.length - currentBlocks.length} stale deferred)` : ""),
					);
				}

				// (Re)wire the engine hot-reload watcher for the resolved script.
				const scriptUri = result?.engineScriptUri;
				if (scriptUri?.fsPath !== engineScript) {
					engineWatcher?.dispose();
					engineWatcher = undefined;
					engineScript = scriptUri?.fsPath;
					if (scriptUri) {
						const parent = vscode.Uri.joinPath(scriptUri, "..");
						const base = scriptUri.path.replace(/^.*\//, "");
						const watcher = vscode.workspace.createFileSystemWatcher(
							new vscode.RelativePattern(parent, base),
						);
						const onEngineChange = async () => {
							invalidateExternalEngine(scriptUri.fsPath);
							await doLoad();
						};
						watcher.onDidChange(onEngineChange);
						watcher.onDidCreate(onEngineChange);
						engineWatcher = watcher;
						disposables.push(watcher);
					}
				}
			} catch (e) {
				console.warn("NVM layout auto-detection failed:", e);
			}
		};

		// A reload drops the cached dependency index (so newly configured roots /
		// moved source files are re-discovered) and then re-parses + re-pushes.
		const reload = async (): Promise<void> => {
			invalidateDependencyResolver();
			await doLoad();
		};
		this._nvmReloaders.set(document, reload);
		disposables.push(new vscode.Disposable(() => this._nvmReloaders.delete(document)));

		// Watch the descriptor + nearby declared-source files for edits.
		this.wireLayoutWatchers(dir, reload, disposables);

		webviewPanel.onDidDispose(() => {
			engineWatcher?.dispose();
			disposeAll(disposables);
		});

		void doLoad();
	}

	/**
	 * Create file-system watchers over the directories where layout descriptors
	 * and their declared source files live (the dump dir, sibling/parent `conf/`,
	 * and every configured `layoutRoots` folder + its `conf/`). Edits to
	 * `*.nvmlayout.json` / `*.c` / `*.h` / `*.arxml` trigger a debounced reparse.
	 * Files resolved only via `workspaceRoots` are covered by the manual reload
	 * command instead (watching whole project trees would be too costly).
	 */
	private wireLayoutWatchers(
		dir: string,
		reload: () => Promise<void>,
		disposables: vscode.Disposable[],
	): void {
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const dirs = new Set<string>([dir, `${dir}/conf`, `${parent}/conf`]);
		for (const root of configuredLayoutRoots()) {
			dirs.add(root);
			dirs.add(`${root}/conf`);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const debounced = () => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => void reload(), 250);
		};
		disposables.push(new vscode.Disposable(() => timer && clearTimeout(timer)));
		for (const d of dirs) {
			try {
				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(vscode.Uri.file(d), "*.{nvmlayout.json,c,h,arxml}"),
				);
				watcher.onDidChange(debounced);
				watcher.onDidCreate(debounced);
				watcher.onDidDelete(debounced);
				disposables.push(watcher);
			} catch {
				// An invalid directory is skipped rather than aborting setup.
			}
		}
	}

	/** Re-parse the active dump and push fresh blocks (manual reload command). */
	public async reloadActiveNvmLayout(): Promise<void> {
		const doc = this._registry.activeDocument;
		const reload = doc && this._nvmReloaders.get(doc);
		if (!reload) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t("No active NVM dump to reload."),
			);
			return;
		}
		await reload();
		void vscode.window.setStatusBarMessage(vscode.l10n.t("NVM layout reloaded."), 2000);
	}

	/** Re-parse every open dump (e.g. after the discovery roots settings change). */
	public async reloadAllNvmLayouts(): Promise<void> {
		invalidateDependencyResolver();
		for (const reload of this._nvmReloaders.values()) {
			await reload();
		}
	}

	/**
	 * Run the registered vendor layout providers against the opened document.
	 * Gathers the file text plus any nearby `Fee_Lcfg.c` and `*.nvmlayout.json`
	 * descriptors and returns the first provider's blocks. A descriptor may also
	 * point at an external engine script (`engineScript`), which — when the
	 * security gate passes — is loaded and run in preference to the built-ins.
	 */
	private async tryLoadNvmBlocks(
		document: HexDocument,
		fsPath: string,
		dir: string,
	): Promise<NvmLoadResult | undefined> {
		const fileName = fsPath.replace(/^.*[\\/]/, "").toLowerCase();
		const ext = fsPath.slice(fsPath.lastIndexOf(".")).toLowerCase();
		const hexExts = new Set([
			".mot",
			".srec",
			".s19",
			".s28",
			".s37",
			".s1",
			".s2",
			".s3",
			".hex",
			".ihex",
			".ihx",
		]);
		if (!hexExts.has(ext)) {
			return undefined;
		}

		const raw = await vscode.workspace.fs.readFile(document.uri);
		const text = new TextDecoder("ascii").decode(raw);
		const configs = await this.findLayoutConfigs(dir);
		const [sources, arxml] = await Promise.all([
			this.gatherSources(dir, configs),
			this.findArxml(dir),
		]);
		// Legacy bundle for the external-engine boundary (packs consume text + sources).
		const input: LayoutInput = { fileName, ext, text, configs, sources, arxml };

		// Prefer an external engine when a descriptor opts in and the gate passes.
		const external = await this.tryExternalEngine(dir, input);
		if (external) {
			return external;
		}

		// Built-in providers run against the vendor-blind context: decode the
		// image once via the `image` capability, resolve `symbols` lazily (an
		// AUTOSAR-config symbol table is only built if a provider asks for names).
		const image = resolveImage({ fileName, ext, text });
		if (!image) {
			return undefined;
		}
		let symbolCache: ReturnType<typeof resolveSymbols>;
		let symbolResolved = false;
		const ctx: ResolveContext = {
			fileName,
			ext,
			image,
			configs,
			sources,
			symbols: () => {
				if (!symbolResolved) {
					symbolResolved = true;
					symbolCache = resolveSymbols({ fileName, ext, image, configs, sources, arxml });
				}
				return symbolCache;
			},
		};
		const resolved = resolveNvmBlocks(ctx);
		return resolved ? { resolved } : undefined;
	}

	/**
	 * If a matching descriptor declares an `engine` (installed pack) or an
	 * `engineScript` (workspace-local file), resolve and run it — but only when
	 * every safety condition holds: a Node desktop host, a trusted workspace, the
	 * `hexeditor.nvm.allowExternalEngines` setting, and a one-time per-file
	 * confirmation. Any failure falls through to the built-ins.
	 */
	private async tryExternalEngine(
		dir: string,
		input: LayoutInput,
	): Promise<NvmLoadResult | undefined> {
		// Several descriptors can match the same dump (e.g. a broad coloring-only
		// one and a narrower struct-decoding one). Pick the most *specifically*
		// gated match rather than whichever happens to sort first on disk — the
		// tie-break stays vendor-blind (it ranks the generic `match` gate, never
		// the engine `options`). A later, equally-specific descriptor wins so a
		// project-local override can shadow a shared one.
		const candidates = input.configs.filter(
			c =>
				((typeof c.engine === "string" && c.engine) ||
					(typeof c.engineScript === "string" && c.engineScript)) &&
				matchesConfig(c, input),
		);
		if (candidates.length === 0) {
			return undefined;
		}
		const config = candidates.reduce((best, c) =>
			matchSpecificity(c) >= matchSpecificity(best) ? c : best,
		);

		// The presence of a layout descriptor that points at an engine is the
		// user's opt-in: without a layout we cannot parse at all. We still keep
		// the standard safety net for executing workspace JavaScript — a desktop
		// host, a trusted workspace, and a one-time per-file confirmation — plus a
		// master kill-switch setting (defaults on) for locked-down environments.
		if (!isNodeHost()) {
			return undefined; // web/virtual host cannot execute a local engine
		}
		const enabled = vscode.workspace
			.getConfiguration("nvmstudio")
			.get<boolean>("nvm.allowExternalEngines", true);
		if (!enabled) {
			void this.warnEngineBlocked(
				"NVM layout engines are disabled by the setting `nvmstudio.nvm.allowExternalEngines`.",
				"Enable",
				async () => {
					await vscode.workspace
						.getConfiguration("nvmstudio")
						.update("nvm.allowExternalEngines", true, vscode.ConfigurationTarget.Workspace);
				},
			);
			return undefined;
		}
		if (!vscode.workspace.isTrusted) {
			void this.warnEngineBlocked(
				"This NVM dump has a layout engine, but the workspace is not trusted so it cannot run.",
				"Manage Workspace Trust",
				async () => {
					await vscode.commands.executeCommand("workbench.trust.manage");
				},
			);
			return undefined;
		}

		// Resolve the entry: an installed pack id, or a workspace-local script.
		let scriptUri: vscode.Uri | undefined;
		let label: string;
		if (config.engine) {
			const installed = await this.engineManager.resolve(config.engine);
			if (!installed) {
				console.warn(`NVM engine pack "${config.engine}" is not installed.`);
				return undefined;
			}
			scriptUri = installed.entryUri;
			label = `engine pack "${installed.manifest.id}"`;
		} else {
			scriptUri = await this.findNearbyFileUri(dir, config.engineScript!);
			if (!scriptUri) {
				console.warn(`NVM engineScript "${config.engineScript}" not found near ${dir}`);
				return undefined;
			}
			label = `engine script "${config.engineScript}"`;
		}

		if (!(await this.confirmEngineScript(scriptUri))) {
			return undefined;
		}

		try {
			const stat = await vscode.workspace.fs.stat(scriptUri);
			const engine = await loadExternalEngine(scriptUri.fsPath, stat.mtime);
			const blocks = engine.parse(input, config.options);
			applyPalette(blocks, config.palette);
			return {
				resolved: { providerId: `external:${engine.id}`, blocks },
				// Only workspace-local scripts are watched for hot reload; installed
				// packs are immutable until re-installed.
				engineScriptUri: config.engine ? undefined : scriptUri,
			};
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Failed to run NVM ${label}: ${e instanceof Error ? e.message : String(e)}`,
			);
			return undefined;
		}
	}

	/** Reasons already surfaced this session, so we don't nag on every reopen. */
	private readonly _warnedEngineReasons = new Set<string>();

	/**
	 * Surface — once per session per message — that a layout engine was found but
	 * could not run, with a single actionable button to unblock it.
	 */
	private async warnEngineBlocked(
		message: string,
		action: string,
		run: () => Promise<void>,
	): Promise<void> {
		if (this._warnedEngineReasons.has(message)) {
			return;
		}
		this._warnedEngineReasons.add(message);
		const choice = await vscode.window.showWarningMessage(message, action);
		if (choice === action) {
			await run();
		}
	}

	/**
	 * One-time per-file confirmation before executing a workspace engine script.
	 * The approval is remembered per absolute path in workspace state.
	 */
	private async confirmEngineScript(scriptUri: vscode.Uri): Promise<boolean> {
		const key = "hexeditor.nvm.approvedEngines";
		const approved = this._context.workspaceState.get<string[]>(key, []);
		if (approved.includes(scriptUri.fsPath)) {
			return true;
		}
		const choice = await vscode.window.showWarningMessage(
			`Run NVM layout engine from "${scriptUri.fsPath}"? This executes JavaScript from your workspace.`,
			{ modal: true },
			"Run once",
			"Always run this file",
		);
		if (choice === "Always run this file") {
			await this._context.workspaceState.update(key, [...approved, scriptUri.fsPath]);
			return true;
		}
		return choice === "Run once";
	}

	/** Locate a file by (possibly `./`-prefixed) name near the dump; returns its URI. */
	private async findNearbyFileUri(
		dir: string,
		fileName: string,
	): Promise<vscode.Uri | undefined> {
		const base = fileName.replace(/^.*[\\/]/, "").toLowerCase();
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const searchDirs = [dir, `${dir}/conf`, `${parent}/conf`];
		for (const d of searchDirs) {
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
				const match = entries.find(e => e[0].toLowerCase() === base);
				if (match) {
					return vscode.Uri.joinPath(vscode.Uri.file(d), match[0]);
				}
			} catch {
				// directory does not exist; keep searching
			}
		}
		// Fallback: recursively discover under the user's configured workspace roots.
		const abs = await this.resolveViaRoots(fileName);
		return abs ? vscode.Uri.file(abs) : undefined;
	}

	/**
	 * Fallback file discovery via the configured workspace roots
	 * (`nvmstudio.nvm.workspaceRoots`): recursively index them, prompt to
	 * disambiguate duplicate base names, and persist the choice. Returns undefined
	 * when no roots are configured or the file is not found — keeping the flat
	 * three-dir scan as the fast, zero-config default.
	 */
	private async resolveViaRoots(fileName: string): Promise<string | undefined> {
		const resolver = getDependencyResolver(this._context);
		if (!resolver.hasRoots()) {
			return undefined;
		}
		return resolver.resolve(fileName);
	}

	/**
	 * Discover vendor layout descriptors (`*.nvmlayout.json`) near the opened
	 * binary so vendor-specific formats can be added purely by configuration.
	 * Searches the file's directory, a sibling `conf/`, and the parent's `conf/`,
	 * plus any configured global `nvmstudio.nvm.layoutRoots` (each root and its
	 * `conf/`), so descriptors can live in a shared folder instead of next to
	 * every dump.
	 */
	private async findLayoutConfigs(dir: string): Promise<LayoutConfig[]> {
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const searchDirs = [dir, `${dir}/conf`, `${parent}/conf`];
		for (const root of configuredLayoutRoots()) {
			searchDirs.push(root, `${root}/conf`);
		}
		const configs: LayoutConfig[] = [];
		for (const d of searchDirs) {
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
				for (const [name] of entries) {
					if (!name.toLowerCase().endsWith(".nvmlayout.json")) {
						continue;
					}
					try {
						const uri = vscode.Uri.joinPath(vscode.Uri.file(d), name);
						const buf = await vscode.workspace.fs.readFile(uri);
						const parsed = JSON.parse(new TextDecoder("utf8").decode(buf));
						for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
							if (
								c &&
								(Array.isArray(c.blocks) ||
									typeof c.provider === "string" ||
									typeof c.engineScript === "string" ||
									typeof c.engine === "string")
							) {
								configs.push(c as LayoutConfig);
							}
						}
					} catch (e) {
						console.warn(`Ignoring invalid NVM layout descriptor ${name}:`, e);
					}
				}
			} catch {
				// directory does not exist; keep searching
			}
		}
		return configs;
	}

	/**
	 * Read a file by name near the opened binary (its directory, `./conf/`,
	 * `../conf/`). Vendor-agnostic; case-insensitive match on the base name.
	 */
	private async readNearbyFile(dir: string, fileName: string): Promise<string | undefined> {
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const searchDirs = [dir, `${dir}/conf`, `${parent}/conf`];
		const target = fileName.toLowerCase();
		for (const d of searchDirs) {
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
				const match = entries.find(e => e[0].toLowerCase() === target);
				if (!match) {
					continue;
				}
				const uri = vscode.Uri.joinPath(vscode.Uri.file(d), match[0]);
				const buf = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder("utf8").decode(buf);
			} catch {
				// directory does not exist; keep searching
			}
		}
		// Fallback: recursively discover under the user's configured workspace roots.
		const abs = await this.resolveViaRoots(fileName);
		if (abs) {
			try {
				const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
				return new TextDecoder("utf8").decode(buf);
			} catch {
				// fall through to undefined
			}
		}
		return undefined;
	}

	/**
	 * Resolve the auxiliary source files that the loaded descriptors declare via
	 * `sources: { logicalName: fileName }`. The core stays vendor-agnostic — it
	 * only reads what the config asks for and keys the content by logical name.
	 */
	private async gatherSources(
		dir: string,
		configs: LayoutConfig[],
	): Promise<Record<string, string>> {
		// logical name -> file name (later descriptors win on conflict)
		const wanted = new Map<string, string>();
		for (const c of configs) {
			for (const [logical, file] of Object.entries(c.sources ?? {})) {
				if (typeof file === "string" && file) {
					wanted.set(logical, file);
				}
			}
		}
		const out: Record<string, string> = {};
		await Promise.all(
			[...wanted].map(async ([logical, file]) => {
				const content = await this.readNearbyFile(dir, file);
				if (content !== undefined) {
					out[logical] = content;
				}
			}),
		);
		return out;
	}

	/** Read the nearest AUTOSAR config (`*.arxml`/`*.xml`) content, if any. */
	private async findArxml(dir: string): Promise<string | undefined> {
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const searchDirs = [dir, `${dir}/conf`, `${parent}/conf`];
		for (const d of searchDirs) {
			try {
				const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(d));
				const match = entries.find(e => {
					const n = e[0].toLowerCase();
					return n.endsWith(".arxml") || n.endsWith(".xml");
				});
				if (!match) {
					continue;
				}
				const uri = vscode.Uri.joinPath(vscode.Uri.file(d), match[0]);
				const buf = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder("utf8").decode(buf);
			} catch {
				// directory does not exist; keep searching
			}
		}
		return undefined;
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
		vscode.CustomDocumentEditEvent<HexDocument>
	>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	public async saveCustomDocument(
		document: HexDocument,
		cancellation: vscode.CancellationToken,
	): Promise<void> {
		await document.save(cancellation);

		// Update all webviews that a save has just occured
		for (const messaging of this._registry.getMessaging(document)) {
			messaging.sendEvent({ type: MessageType.Saved, unsavedEditIndex: document.unsavedEditIndex });
		}
	}

	public saveCustomDocumentAs(
		document: HexDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken,
	): Thenable<void> {
		return document.saveAs(destination, cancellation);
	}

	public revertCustomDocument(
		document: HexDocument,
		cancellation: vscode.CancellationToken,
	): Thenable<void> {
		return document.revert(cancellation);
	}

	public backupCustomDocument(
		document: HexDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken,
	): Thenable<vscode.CustomDocumentBackup> {
		return document.backup(context.destination);
	}

	/**
	 * Get the static HTML used for in our editor's webviews.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Convert the styles and scripts for the webview into webview URIs
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "dist", "editor.js"),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._context.extensionUri, "dist", "editor.css"),
		);

		// Use a nonce to allow certain scripts to be run
		const nonce = randomString();
		const strings: ILocalizedStrings = {
			pasteAs: vscode.l10n.t("Paste as"),
			pasteMode: vscode.l10n.t("Paste mode"),
			replace: vscode.l10n.t("Replace"),
			insert: vscode.l10n.t("Insert"),
			bytes: vscode.l10n.t("bytes"),
			encodingError: vscode.l10n.t("Encoding Error"),
			decodedText: vscode.l10n.t("Decoded Text"),
			loadingUpper: vscode.l10n.t("LOADING"),
			loadingDotDotDot: vscode.l10n.t("Loading..."),
			littleEndian: vscode.l10n.t("Little Endian"),
			onlyHexChars: vscode.l10n.t("Only hexadecimal characters (0-9 and a-f) are allowed"),
			onlyHexCharsAndPlaceholders: vscode.l10n.t(
				"Only hexadecimal characters (0-9, a-f, and ?? placeholders) are allowed",
			),
			toggleReplace: vscode.l10n.t("Toggle Replace"),
			findBytes: vscode.l10n.t("Find Bytes (hex)"),
			findText: vscode.l10n.t("Find Text"),
			regexSearch: vscode.l10n.t("Regular Expression Search"),
			searchInBinaryMode: vscode.l10n.t("Search in Binary Mode"),
			caseSensitive: vscode.l10n.t("Case Sensitive"),
			cancelSearch: vscode.l10n.t("Cancel Search"),
			previousMatch: vscode.l10n.t("Previous Match"),
			nextMatch: vscode.l10n.t("Next Match"),
			closeWidget: vscode.l10n.t("Close Widget (Esc)"),
			replaceAllMatches: vscode.l10n.t("Replace All Matches"),
			replaceSelectedMatch: vscode.l10n.t("Replace Selected Match"),
			resultOverflow: vscode.l10n.t("More than {0} results, click to find all", placeholder1),
			resultCount: vscode.l10n.t("{0} results", placeholder1),
			foundNResults: vscode.l10n.t("Found {0}...", placeholder1),
			noResults: vscode.l10n.t("No results"),
			openLargeFileWarning: vscode.l10n.t("Opening this large file may cause instability."),
			openAnyways: vscode.l10n.t("Open Anyways"),
			readonlyWarning: vscode.l10n.t("Cannot edit in read-only editor."),
			openSettings: vscode.l10n.t("Open Settings"),
			showDecodedText: vscode.l10n.t("Show Decoded Text"),
			bytesPerRow: vscode.l10n.t("Bytes per row"),
			close: vscode.l10n.t("Close"),
		};

		return /* html */ `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleUri}" rel="stylesheet" />
				<script nonce="${nonce}">globalThis.LOC_STRINGS=${JSON.stringify(strings)}</script>
				<script nonce="${nonce}" src="${scriptUri}" defer></script>

				<title>Hex Editor</title>
			</head>
			<body>
			</body>
			</html>`;
	}

	private readCodeSettings(): ICodeSettings {
		const editorConfig = vscode.workspace.getConfiguration("editor");
		return {
			scrollBeyondLastLine: editorConfig.get("scrollBeyondLastLine", true),
		};
	}

	private readEditorSettings(): IEditorSettings {
		const config = vscode.workspace.getConfiguration("nvmstudio");
		const settings: IEditorSettings = { ...defaultEditorSettings };
		for (const key of editorSettingsKeys) {
			if (config.has(key)) {
				(settings as any)[key] = config.get(key);
			}
		}
		return settings;
	}

	private writeEditorSettings(settings: IEditorSettings) {
		const config = vscode.workspace.getConfiguration("nvmstudio");
		for (const key of editorSettingsKeys) {
			const existing = config.inspect(key);
			const target = !existing
				? vscode.ConfigurationTarget.Global
				: existing.workspaceFolderValue !== undefined
					? vscode.ConfigurationTarget.WorkspaceFolder
					: existing.workspaceValue !== undefined
						? vscode.ConfigurationTarget.Workspace
						: vscode.ConfigurationTarget.Global;
			config.update(key, settings[key], target);
		}
	}

	private async onMessage(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
		message: FromWebviewMessage,
	): Promise<undefined | ToWebviewMessage> {
		switch (message.type) {
			// If it's a packet request
			case MessageType.ReadyRequest:
				// If there are NVM blocks associated with this document, send them as a follow-up event
				const nvmBlocks = this._registry.getNvmBlocks(document);
				if (nvmBlocks && nvmBlocks.length > 0) {
					messaging.sendEvent({ type: MessageType.SetNvmBlocks, blocks: nvmBlocks });
				}
				// Push any saved annotations (bookmarks / tags / notes) for this dump.
				void this.pushAnnotations(messaging, document);
				// Push the custom-view refs (for the decoded-tree "+" menu).
				void this.pushCustomViews(messaging, document);
				return {
					type: MessageType.ReadyResponse,
					initialOffset: document.baseAddress,
					editorSettings: this.readEditorSettings(),
					codeSettings: this.readCodeSettings(),
					edits: serializeEdits(document.edits),
					unsavedEditIndex: document.unsavedEditIndex,
					fileSize: await document.size(),
					pageSize: document.pageSize,
					isLargeFile: document.isLargeFile,
					isReadonly: document.isReadonly,
					editMode: document.editMode,
					decorators: await document.readDecorators(),
				};
			case MessageType.SetSelectedCount:
				document.selectionState = message;
				break;
			case MessageType.SetHoveredByte:
				document.hoverState = message.hovered;
				break;
			case MessageType.ReadRangeRequest:
				const data = await document.readBuffer(message.offset, message.bytes);
				return { type: MessageType.ReadRangeResponse, data: getCorrectArrayBuffer(data) };
			case MessageType.MakeEdits:
				this.publishEdit(messaging, document, document.makeEdits(deserializeEdits(message.edits)));
				return;
			case MessageType.DoPaste:
				this.publishEdit(
					messaging,
					document,
					message.mode === PasteMode.Insert
						? document.insert(message.offset, message.data)
						: await document.replace(message.offset, message.data),
				);
				messaging.sendEvent({ type: MessageType.SetEdits, edits: serializeEdits(document.edits) });
				return;
			case MessageType.DoCopy: {
				const parts = await Promise.all(
					message.selections
						.sort((a, b) => a[0] - b[0])
						.map(s => document.readBuffer(s[0], s[1] - s[0])),
				);
				const flatParts = flattenBuffers(parts);

				const filenameWoutExt = getBaseName(document.uri.path);

				copyAsFormats[message.format](flatParts, filenameWoutExt);

				return;
			}
			case MessageType.RequestDeletes: {
				const bytes = await Promise.all(
					message.deletes.map(d => document.readBufferWithEdits(d.start, d.end - d.start)),
				);
				const edits = bytes.map(
					(e, i): HexDocumentEdit => ({
						op: HexDocumentEditOp.Delete,
						previous: e,
						offset: message.deletes[i].start,
					}),
				);
				messaging.sendEvent({
					type: MessageType.SetEdits,
					edits: serializeEdits(edits),
					appendOnly: true,
				});
				this.publishEdit(messaging, document, document.makeEdits(edits));
				return { type: MessageType.DeleteAccepted };
			}
			case MessageType.CancelSearch:
				document.searchProvider.cancel();
				return;
			case MessageType.SearchRequest:
				let request: ISearchRequest;
				if ("re" in message.query) {
					request = new RegexSearchRequest(
						document,
						message.query,
						message.caseSensitive,
						message.cap,
					);
				} else {
					request = new LiteralSearchRequest(
						document,
						message.query,
						message.caseSensitive,
						message.cap,
					);
				}
				document.searchProvider.start(messaging, request);
				return;
			case MessageType.ClearDataInspector:
				this._dataInspectorView.handleEditorMessage({ method: "reset" });
				break;
			case MessageType.SetInspectByte:
				this._dataInspectorView.handleEditorMessage({
					method: "update",
					data: getCorrectArrayBuffer(await document.readBufferWithEdits(message.offset, 8)),
				});
				break;
			case MessageType.UpdateEditorSettings:
				this.writeEditorSettings(message.editorSettings);
				break;
			case MessageType.NvmAnnotationCommand:
				await this.handleAnnotationCommand(messaging, document, message.command);
				break;
			case MessageType.NvmCustomViewCommand:
				await this.handleCustomViewCommand(messaging, document, message.command);
				break;
		}
	}

	/** Push the dump's custom-view refs to the webview (for the "+" menu). */
	private async pushCustomViews(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
	): Promise<void> {
		try {
			const blocks = this._registry.getNvmBlocks(document);
			const views = await this._customViews.listForEditor(document.uri, blocks);
			messaging.sendEvent({ type: MessageType.SetNvmCustomViews, views });
		} catch (e) {
			console.warn("Failed to push NVM custom views:", e);
		}
	}

	/** Apply a custom-view mutation requested by the webview, then re-push. */
	private async handleCustomViewCommand(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
		command: import("../shared/protocol").NvmCustomViewCommand,
	): Promise<void> {
		try {
			const uri = document.uri;
			switch (command.kind) {
				case "addBlock":
					await this.addBlockToView(
						document,
						command.viewId,
						command.blockId,
						command.by,
						command.groupKey,
					);
					break;
				case "createView":
					await this._customViews.createView(uri, command.name);
					break;
				case "renameView": {
					const name = await vscode.window.showInputBox({
						title: vscode.l10n.t("Rename custom view"),
						prompt: vscode.l10n.t("New view name"),
					});
					if (name !== undefined) {
						await this._customViews.renameView(uri, command.viewId, name);
					}
					break;
				}
				case "deleteView":
					await this._customViews.deleteView(uri, command.viewId);
					break;
				case "deleteGroup":
					await this._customViews.deleteGroup(uri, command.viewId, command.groupKey);
					break;
				case "promoteToTemplate":
					await this._customViews.promoteToTemplate(uri, command.viewId);
					break;
			}
			await this.pushCustomViews(messaging, document);
		} catch (e) {
			void vscode.window.showErrorMessage(
				`NVM custom view failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/**
	 * Add a whole block (and its structurally-matching family) to a custom view.
	 * Shared by every "Add to Custom View" entry point (Blocks Table row, Blocks
	 * tree context menu, Data Inspector button). `viewId` may be "__new__" to
	 * prompt for a target view. The block is located by id, so the fingerprint is
	 * computed from the authoritative decoded tree host-side.
	 */
	public async addBlockToView(
		document: HexDocument,
		viewId: string,
		blockId: string,
		by?: "fingerprint" | "identity" | "id",
		groupKey?: string,
	): Promise<void> {
		const blocks = this._registry.getNvmBlocks(document) as NvmBlockInfo[];
		const block = blocks.find(b => b.id === blockId);
		if (!block) {
			return;
		}
		const added = await addBlockToCustomView(
			this._customViews,
			document.uri,
			blocks,
			block,
			viewId,
			by ?? "fingerprint",
			groupKey,
		);
		if (added) {
			for (const messaging of this._registry.getMessagingByUri(document.uri)) {
				void this.pushCustomViews(messaging, document);
			}
		}
	}

	/** Read the dump's annotations and push the compact view to the webview. */
	private async pushAnnotations(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
	): Promise<void> {
		try {
			const annotations = await this._annotations.toView(document.uri);
			messaging.sendEvent({ type: MessageType.SetNvmAnnotations, annotations });
		} catch (e) {
			console.warn("Failed to push NVM annotations:", e);
		}
	}

	/** Apply an annotation mutation requested by the webview, then re-push. */
	private async handleAnnotationCommand(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
		command: import("../shared/protocol").NvmAnnotationCommand,
	): Promise<void> {
		try {
			if (command.kind === "openNote") {
				const uri = this._annotations.noteUri(document.uri, command.id);
				if (uri) {
					await vscode.window.showTextDocument(uri, { preview: false });
				}
				return;
			}
			// A tag assignment with the sentinel id prompts the user to pick or
			// create a tag (the webview cannot show input UI itself).
			if (command.kind === "assignTag" && command.tagId === "__prompt__") {
				const tagId = await this.promptForTag(document);
				if (!tagId) {
					return;
				}
				command = { ...command, tagId };
			}
			// The webview asked to prompt for a bookmark label on creation.
			if (command.kind === "addBookmark" && command.prompt) {
				const label = await vscode.window.showInputBox({
					title: "New bookmark",
					prompt: "Bookmark label (optional)",
					value: command.label ?? `0x${command.offset.toString(16).toUpperCase()}`,
				});
				if (label === undefined) {
					return; // cancelled → don't create
				}
				command = { kind: "addBookmark", offset: command.offset, label: label || undefined };
			}
			// The webview asked to edit an existing bookmark's label.
			if (command.kind === "renameBookmark" && command.label === "__prompt__") {
				const bookmarkId = command.id;
				const set = await this._annotations.get(document.uri);
				const current = set.bookmarks.find(b => b.id === bookmarkId)?.label ?? "";
				const label = await vscode.window.showInputBox({
					title: "Rename bookmark",
					prompt: "Bookmark label (leave empty to clear)",
					value: current,
				});
				if (label === undefined) {
					return; // cancelled
				}
				command = { kind: "renameBookmark", id: bookmarkId, label: label || undefined };
			}
			await this._annotations.apply(document.uri, command);
			await this.pushAnnotations(messaging, document);
		} catch (e) {
			void vscode.window.showErrorMessage(
				`NVM annotation failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/** Prompt to pick an existing tag or create a new one; returns its id. */
	private async promptForTag(document: HexDocument): Promise<string | undefined> {
		const set = await this._annotations.get(document.uri);
		const CREATE = "$(add) Create new tag…";
		const pick = await vscode.window.showQuickPick(
			[CREATE, ...set.tags.map(t => `${t.label}`)],
			{ title: "Assign NVM tag", placeHolder: "Pick a tag or create one" },
		);
		if (!pick) {
			return undefined;
		}
		if (pick !== CREATE) {
			return set.tags.find(t => t.label === pick)?.id;
		}
		const label = await vscode.window.showInputBox({
			title: "New tag",
			prompt: "Tag name",
			validateInput: v => (v.trim() ? undefined : "Enter a name"),
		});
		if (!label) {
			return undefined;
		}
		await this._annotations.apply(document.uri, { kind: "createTag", label });
		const updated = await this._annotations.get(document.uri);
		return updated.tags.find(t => t.label === label)?.id;
	}

	private publishEdit(
		messaging: ExtensionHostMessageHandler,
		document: HexDocument,
		ref: HexDocumentEditReference,
	) {
		this._onDidChangeCustomDocument.fire({
			document,
			undo: () =>
				messaging.sendEvent({ type: MessageType.SetEdits, edits: serializeEdits(ref.undo()) }),
			redo: () =>
				messaging.sendEvent({ type: MessageType.SetEdits, edits: serializeEdits(ref.redo()) }),
		});
	}
}
