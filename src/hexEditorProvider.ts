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
import {
    applyPalette,
    LayoutConfig,
    LayoutInput,
    matchesConfig,
    ResolvedLayout,
    resolveNvmBlocks,
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
	): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			HexEditorProvider.viewType,
			new HexEditorProvider(context, telemetryReporter, dataInspectorView, registry),
			{
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	private static readonly viewType = "hexEditor.hexedit";

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _telemetryReporter: TelemetryReporter,
		private readonly _dataInspectorView: DataInspectorView,
		private readonly _registry: HexEditorRegistry,
	) {}

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
		(async () => {
			try {
				const fsPath = document.uri.fsPath;
				if (!fsPath) return;
				// compute directory using string-safe operations to avoid importing node 'path'
				const dir = fsPath.replace(/[\\/][^\\/]+$/, "");

				const result = await this.tryLoadNvmBlocks(document, fsPath, dir);
				if (result && result.resolved.blocks.length > 0) {
					this._registry.setNvmBlocks(document, result.resolved.blocks);
					messageHandler.sendEvent({
						type: MessageType.SetNvmBlocks,
						blocks: result.resolved.blocks,
					});
					console.debug(
						`Auto-loaded NVM layout [${result.resolved.providerId}] ${fsPath} -> ${result.resolved.blocks.length} blocks`,
					);

					// Hot reload: when the loaded external engine script changes,
					// re-parse the document and push fresh blocks to this webview.
					if (result.engineScriptUri) {
						const scriptUri = result.engineScriptUri;
						const parent = vscode.Uri.joinPath(scriptUri, "..");
						const base = scriptUri.path.replace(/^.*\//, "");
						const watcher = vscode.workspace.createFileSystemWatcher(
							new vscode.RelativePattern(parent, base),
						);
						const reload = async () => {
							invalidateExternalEngine(scriptUri.fsPath);
							try {
								const next = await this.tryLoadNvmBlocks(document, fsPath, dir);
								const blocks = next?.resolved.blocks ?? [];
								this._registry.setNvmBlocks(document, blocks);
								messageHandler.sendEvent({ type: MessageType.SetNvmBlocks, blocks });
							} catch (e) {
								console.warn("NVM engine hot reload failed:", e);
							}
						};
						watcher.onDidChange(reload);
						watcher.onDidCreate(reload);
						webviewPanel.onDidDispose(() => watcher.dispose());
					}
				}
			} catch (e) {
				console.warn("NVM layout auto-detection failed:", e);
			}
		})();

		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
		webviewPanel.webview.onDidReceiveMessage(e => messageHandler.handleMessage(e));
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
		const input: LayoutInput = { fileName, ext, text, configs, sources, arxml };

		// Prefer an external engine when a descriptor opts in and the gate passes.
		const external = await this.tryExternalEngine(dir, input);
		if (external) {
			return external;
		}

		const resolved = resolveNvmBlocks(input);
		return resolved ? { resolved } : undefined;
	}

	/**
	 * If a matching descriptor declares an `engineScript`, resolve and run it —
	 * but only when every safety condition holds: a Node desktop host, a trusted
	 * workspace, the `hexeditor.nvm.allowExternalEngines` setting, and a one-time
	 * per-file user confirmation. Any failure falls through to the built-ins.
	 */
	private async tryExternalEngine(
		dir: string,
		input: LayoutInput,
	): Promise<NvmLoadResult | undefined> {
		const config = input.configs.find(
			c => typeof c.engineScript === "string" && c.engineScript && matchesConfig(c, input),
		);
		if (!config?.engineScript) {
			return undefined;
		}

		// Executing workspace JS: never on web, never in an untrusted workspace,
		// only when explicitly enabled.
		if (!isNodeHost() || !vscode.workspace.isTrusted) {
			return undefined;
		}
		const enabled = vscode.workspace
			.getConfiguration("hexeditor")
			.get<boolean>("nvm.allowExternalEngines", false);
		if (!enabled) {
			return undefined;
		}

		const scriptUri = await this.findNearbyFileUri(dir, config.engineScript);
		if (!scriptUri) {
			console.warn(`NVM engineScript "${config.engineScript}" not found near ${dir}`);
			return undefined;
		}

		if (!(await this.confirmEngineScript(scriptUri))) {
			return undefined;
		}

		try {
			const stat = await vscode.workspace.fs.stat(scriptUri);
			const engine = await loadExternalEngine(scriptUri.fsPath, stat.mtime);
			const blocks = engine.parse(input, config.options);
			applyPalette(blocks, config.palette);
			return { resolved: { providerId: `external:${engine.id}`, blocks }, engineScriptUri: scriptUri };
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Failed to run NVM engine "${config.engineScript}": ${e instanceof Error ? e.message : String(e)}`,
			);
			return undefined;
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
		return undefined;
	}

	/**
	 * Discover vendor layout descriptors (`*.nvmlayout.json`) near the opened
	 * binary so vendor-specific formats can be added purely by configuration.
	 * Searches the file's directory, a sibling `conf/`, and the parent's `conf/`.
	 */
	private async findLayoutConfigs(dir: string): Promise<LayoutConfig[]> {
		const parent = dir.replace(/[\\/][^\\/]+$/, "");
		const searchDirs = [dir, `${dir}/conf`, `${parent}/conf`];
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
									typeof c.engineScript === "string")
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
		const config = vscode.workspace.getConfiguration("hexeditor");
		const settings: IEditorSettings = { ...defaultEditorSettings };
		for (const key of editorSettingsKeys) {
			if (config.has(key)) {
				(settings as any)[key] = config.get(key);
			}
		}
		return settings;
	}

	private writeEditorSettings(settings: IEditorSettings) {
		const config = vscode.workspace.getConfiguration("hexeditor");
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
		}
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
