// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * External (workspace-supplied) NVM layout engines — **desktop only**.
 *
 * An engine lives in a Node module the user points at with
 * `"engineScript": "./my.engine.js"` in a `*.nvmlayout.json`. It exports a
 * factory that receives the injected {@link EngineSdk} and returns a parser:
 *
 * ```js
 * module.exports.createEngine = sdk => ({
 *   id: "my-engine",
 *   parse(input, options) { return [ /* NvmBlockInfo[] *\/ ]; }
 * });
 * ```
 *
 * Loading executes workspace JavaScript, so callers MUST gate this behind
 * Workspace Trust + the `hexeditor.nvm.allowExternalEngines` setting + a
 * per-file confirmation (see `hexEditorProvider.ts`). This module never runs in
 * the web build: it is only reached from a code path guarded by
 * {@link isNodeHost}.
 */

import { NvmBlockInfo } from "../../../shared/protocol";
import { createEngineSdk, EngineSdk } from "./engineSdk";
import { LayoutInput } from "./provider";

/** The object an engine script's `createEngine(sdk)` must return. */
export interface ExternalEngine {
	/** Stable engine id (informational). */
	id: string;
	/** Produce blocks from the generic input bundle + descriptor options. */
	parse(input: LayoutInput, options?: Record<string, unknown>): NvmBlockInfo[];
}

/** The module shape an engine script must export. */
export interface ExternalEngineModule {
	createEngine(sdk: EngineSdk): ExternalEngine;
}

/**
 * Force a *native* ESM dynamic import even though this file is bundled to CJS by
 * esbuild. Written via `new Function` so esbuild neither rewrites it to
 * `require()` (which cannot load ESM) nor tries to bundle the target. Never
 * called in the web host.
 */
const nativeDynamicImport: (url: string) => Promise<unknown> = new Function(
	"url",
	"return import(url);",
) as (url: string) => Promise<unknown>;

/** True only when running in a Node-capable extension host (not the web build). */
export function isNodeHost(): boolean {
	return (
		typeof process !== "undefined" &&
		!!(process as { versions?: { node?: string } }).versions?.node
	);
}

/** Convert an absolute filesystem path to a `file://` URL without `node:url`. */
function pathToFileUrl(absPath: string): string {
	let p = absPath.replace(/\\/g, "/");
	if (!p.startsWith("/")) {
		p = "/" + p; // Windows drive path -> file:///C:/...
	}
	// Encode everything unsafe for a URL except the path separators and drive colon.
	const encoded = p
		.split("/")
		.map(seg => encodeURIComponent(seg).replace(/%3A/gi, ":"))
		.join("/");
	return "file://" + encoded;
}

interface CacheEntry {
	mtime: number;
	engine: ExternalEngine;
}

/** Loaded engines keyed by absolute path, invalidated when the file's mtime changes. */
const engineCache = new Map<string, CacheEntry>();

function validateEngine(value: unknown): value is ExternalEngine {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ExternalEngine).id === "string" &&
		typeof (value as ExternalEngine).parse === "function"
	);
}

function pickFactory(mod: unknown): ExternalEngineModule["createEngine"] | undefined {
	const candidates = [
		(mod as ExternalEngineModule)?.createEngine,
		(mod as { default?: ExternalEngineModule })?.default?.createEngine,
	];
	return candidates.find(c => typeof c === "function");
}

/**
 * Load (or return a cached) external engine from an absolute path. The `mtime`
 * (from `vscode.workspace.fs.stat`) both cache-busts the ESM import and keys the
 * cache, so editing the script and reloading picks up the new code.
 *
 * @throws when the module cannot be imported or does not expose a valid engine.
 */
export async function loadExternalEngine(
	absPath: string,
	mtime: number,
	sdk: EngineSdk = createEngineSdk(),
): Promise<ExternalEngine> {
	if (!isNodeHost()) {
		throw new Error("External NVM engines are only available in the desktop (Node) host.");
	}

	const cached = engineCache.get(absPath);
	if (cached && cached.mtime === mtime) {
		return cached.engine;
	}

	const url = `${pathToFileUrl(absPath)}?t=${mtime}`;
	const mod = await nativeDynamicImport(url);
	const factory = pickFactory(mod);
	if (!factory) {
		throw new Error(`Engine script "${absPath}" does not export createEngine(sdk).`);
	}

	const engine = factory(sdk);
	if (!validateEngine(engine)) {
		throw new Error(`Engine script "${absPath}" returned an invalid engine (need { id, parse }).`);
	}

	engineCache.set(absPath, { mtime, engine });
	return engine;
}

/** Drop a cached engine (used by the hot-reload watcher). */
export function invalidateExternalEngine(absPath: string): void {
	engineCache.delete(absPath);
}

// --- project-local pre-processing hooks --------------------------------------

/**
 * Services the core hands a hook, in addition to the input bundle. Keeps the
 * hook self-sufficient (persistent cache, its descriptor options, logging)
 * without the core knowing anything about what the hook does.
 */
export interface HookContext {
	/**
	 * A persistent, hook-private directory the core has created. Use it to cache
	 * downloads across sessions and implement your own versioned retention. Path
	 * is stable per hook id.
	 */
	storageDir: string;
	/**
	 * The descriptor's `options` object — the config lives in the descriptor (in
	 * the workspace), the hook only reads it. This is the clean split: the plugin
	 * owns configuration, the hook owns behaviour.
	 */
	options?: Record<string, unknown>;
	/** Append a line to the user-visible NVM Studio log. */
	log(message: string): void;
}

/**
 * What a hook may return. Either a plain value (treated as {@link data}) or this
 * shape to also contribute extra source files that get merged into the engine's
 * `input.sources` (keyed by logical name) — e.g. files the hook downloaded.
 */
export interface HookResult {
	/** Opaque data for the engine, exposed as `input.hookData`. */
	data?: unknown;
	/** Extra source files (logicalName -> content) merged into `input.sources`. */
	sources?: Record<string, string>;
}

/**
 * A project-local pre-processing hook, declared by a descriptor's `hookScript`.
 * It runs BEFORE the engine (same trust gate) and may return opaque data (for
 * `input.hookData`) and/or extra source files (merged into `input.sources`).
 * The core never interprets the data. `run` may be async.
 */
export interface ExternalHook {
	/** Stable hook id (informational; also names the private cache dir). */
	id: string;
	/** Produce pre-processing data and/or extra sources from the input bundle. */
	run(
		input: LayoutInput,
		ctx: HookContext,
	): HookResult | unknown | Promise<HookResult | unknown>;
}

/** The module shape a hook script must export. */
export interface ExternalHookModule {
	createHook(sdk: EngineSdk): ExternalHook;
}

interface HookCacheEntry {
	mtime: number;
	hook: ExternalHook;
}

/** Loaded hooks keyed by absolute path, invalidated when the file's mtime changes. */
const hookCache = new Map<string, HookCacheEntry>();

function validateHook(value: unknown): value is ExternalHook {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ExternalHook).id === "string" &&
		typeof (value as ExternalHook).run === "function"
	);
}

function pickHookFactory(mod: unknown): ExternalHookModule["createHook"] | undefined {
	const candidates = [
		(mod as ExternalHookModule)?.createHook,
		(mod as { default?: ExternalHookModule })?.default?.createHook,
	];
	return candidates.find(c => typeof c === "function");
}

/**
 * Load (or return a cached) project-local hook from an absolute path. Mirrors
 * {@link loadExternalEngine}: the `mtime` both cache-busts the ESM import and
 * keys the cache. Callers MUST apply the same security gate used for engines.
 *
 * @throws when the module cannot be imported or does not expose a valid hook.
 */
export async function loadExternalHook(
	absPath: string,
	mtime: number,
	sdk: EngineSdk = createEngineSdk(),
): Promise<ExternalHook> {
	if (!isNodeHost()) {
		throw new Error("External NVM hooks are only available in the desktop (Node) host.");
	}

	const cached = hookCache.get(absPath);
	if (cached && cached.mtime === mtime) {
		return cached.hook;
	}

	const url = `${pathToFileUrl(absPath)}?t=${mtime}`;
	const mod = await nativeDynamicImport(url);
	const factory = pickHookFactory(mod);
	if (!factory) {
		throw new Error(`Hook script "${absPath}" does not export createHook(sdk).`);
	}

	const hook = factory(sdk);
	if (!validateHook(hook)) {
		throw new Error(`Hook script "${absPath}" returned an invalid hook (need { id, run }).`);
	}

	hookCache.set(absPath, { mtime, hook });
	return hook;
}

/** Drop a cached hook (used by the hot-reload watcher). */
export function invalidateExternalHook(absPath: string): void {
	hookCache.delete(absPath);
}
