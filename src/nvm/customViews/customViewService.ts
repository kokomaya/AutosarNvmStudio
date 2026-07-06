// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-side custom-view service: owns the per-dump (sidecar) view set and the
 * shared workspace template set, applies mutations from the editor webview /
 * panel / commands, persists via the two {@link CustomViewStore} backends, and
 * projects render-ready {@link ResolvedView}s for the panel.
 *
 * It is entirely vendor-blind: it never inspects what a view *means*, only its
 * generic block selectors (a decoded-structure fingerprint / identity / id /
 * glob). `effectiveViews` unions a dump's own sidecar views with any workspace
 * templates whose selectors match that dump's blocks, so a template auto-applies
 * to every sibling dump of the same shape.
 */

import * as vscode from "vscode";
import { NvmBlockInfo, NvmCustomViewRef } from "../../../shared/protocol";
import {
	BlockSelector,
	deNumber,
	fingerprintBlock,
	nameFamilyGlob,
	NvmCustomView,
	resolveCustomView,
	ResolvedView,
	selectBlocks,
} from "../../../shared/nvm/customView";
import { emptyViewSet, newId, NvmCustomViewSet } from "./model";
import { CustomViewStore } from "./store/customViewStore";
import { SidecarViewStore } from "./store/sidecarViewStore";
import { TemplateViewStore } from "./store/templateViewStore";

export class CustomViewService {
	private readonly sidecar: CustomViewStore = new SidecarViewStore();
	private readonly templates: CustomViewStore;
	/** Per-dump sidecar cache, keyed by dump uri string. */
	private readonly cache = new Map<string, NvmCustomViewSet>();
	/** Shared template set (dump-independent). */
	private templateSet: NvmCustomViewSet | undefined;

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	/** Fires when a dump's effective views change (for the panel to refresh). */
	public readonly onDidChange = this._onDidChange.event;

	constructor(context: vscode.ExtensionContext) {
		this.templates = new TemplateViewStore(context);
	}

	/** Get (loading + caching) the sidecar view set for a dump. */
	private async sidecarSet(docUri: vscode.Uri): Promise<NvmCustomViewSet> {
		const key = docUri.toString();
		const existing = this.cache.get(key);
		if (existing) {
			return existing;
		}
		const set = await this.sidecar.load(docUri);
		this.cache.set(key, set);
		return set;
	}

	/** Get (loading + caching) the shared workspace template set. */
	private async templateSetLoaded(docUri: vscode.Uri): Promise<NvmCustomViewSet> {
		if (!this.templateSet) {
			this.templateSet = await this.templates.load(docUri);
		}
		return this.templateSet;
	}

	/** Locate a view (in either backend) by id, with its owning set + store. */
	private async locate(
		docUri: vscode.Uri,
		viewId: string,
	): Promise<{ view: NvmCustomView; set: NvmCustomViewSet; store: CustomViewStore } | undefined> {
		const sc = await this.sidecarSet(docUri);
		const scView = sc.views.find(v => v.id === viewId);
		if (scView) {
			return { view: scView, set: sc, store: this.sidecar };
		}
		const tpl = await this.templateSetLoaded(docUri);
		const tplView = tpl.views.find(v => v.id === viewId);
		if (tplView) {
			return { view: tplView, set: tpl, store: this.templates };
		}
		return undefined;
	}

	/**
	 * The views that apply to a dump: its own sidecar views, plus any workspace
	 * templates whose group selectors match at least one of the dump's blocks.
	 * Sidecar views take precedence when ids collide.
	 */
	public async effectiveViews(
		docUri: vscode.Uri,
		blocks: readonly NvmBlockInfo[],
	): Promise<NvmCustomView[]> {
		const sc = await this.sidecarSet(docUri);
		const tpl = await this.templateSetLoaded(docUri);
		const seen = new Set(sc.views.map(v => v.id));
		const applicableTemplates = tpl.views.filter(
			v => !seen.has(v.id) && v.groups.some(g => selectBlocks(g, blocks).length > 0),
		);
		return [...sc.views, ...applicableTemplates];
	}

	/** Resolve every effective view against the dump's blocks (for the panel). */
	public async toResolvedViews(
		docUri: vscode.Uri,
		blocks: readonly NvmBlockInfo[],
	): Promise<ResolvedView[]> {
		const views = await this.effectiveViews(docUri, blocks);
		return views.map(v => resolveCustomView(v, blocks));
	}

	/** Lightweight refs of effective views (for the "add to view" quick pick). */
	public async listForEditor(
		docUri: vscode.Uri,
		blocks: readonly NvmBlockInfo[],
	): Promise<NvmCustomViewRef[]> {
		const views = await this.effectiveViews(docUri, blocks);
		return views.map(v => ({ id: v.id, name: v.name }));
	}

	/**
	 * The existing groups of one view, as `{key, label, matchedBlocks}` — used by
	 * the "add block" flow to offer merging into an existing comparison sub-table.
	 */
	public async listGroups(
		docUri: vscode.Uri,
		viewId: string,
		blocks: readonly NvmBlockInfo[],
	): Promise<{ key: string; label: string; matchedBlocks: number }[]> {
		const located = await this.locate(docUri, viewId);
		if (!located) {
			return [];
		}
		const resolved = resolveCustomView(located.view, blocks);
		return resolved.groups.map(g => ({
			key: g.key,
			label: g.label,
			matchedBlocks: g.matchedBlocks,
		}));
	}

	/** Create a new (dump-scoped) empty view and return it. */
	public async createView(docUri: vscode.Uri, name: string): Promise<NvmCustomView> {
		const set = await this.sidecarSet(docUri);
		const now = Date.now();
		const view: NvmCustomView = {
			id: newId("view"),
			name: name.trim() || "Untitled view",
			scope: "dump",
			groups: [],
			createdAt: now,
			updatedAt: now,
		};
		set.views.push(view);
		await this.persist(docUri, this.sidecar, set);
		return view;
	}

	/**
	 * Add a whole block to a view: compute the block's group selector (a decoded
	 * structure fingerprint by default) so all structurally-matching blocks join
	 * at once, then add it as a group if not already present. Returns the view id
	 * the block was added to (creating a view if `viewId` is "__new__" is handled
	 * by the caller via {@link createView}).
	 */
	public async addBlock(
		docUri: vscode.Uri,
		viewId: string,
		block: NvmBlockInfo,
		by: "fingerprint" | "identity" | "id" = "fingerprint",
		targetGroupKey?: string,
	): Promise<void> {
		const located = await this.locate(docUri, viewId);
		if (!located) {
			return;
		}
		const selector = this.selectorForBlock(block, by);
		if (targetGroupKey) {
			if (this.mergeIntoGroup(located.view, targetGroupKey, selector)) {
				located.view.updatedAt = Date.now();
				await this.persist(docUri, located.store, located.set);
			}
			return;
		}
		const key = `${selector.by}:${selector.value}`;
		if (!located.view.groups.some(g => `${g.by}:${g.value}` === key)) {
			located.view.groups.push(selector);
			located.view.updatedAt = Date.now();
			await this.persist(docUri, located.store, located.set);
		}
	}

	/**
	 * Merge `selector` into the existing group identified by `targetGroupKey`,
	 * turning that group into a user-curated `union`. This is how a user asserts
	 * that two blocks the plugin can NOT prove are related (e.g. differently-named,
	 * un-decoded blocks) belong in the same comparison sub-table. Returns whether
	 * the view actually changed (false if the group is missing or already contains
	 * the selector). The plugin never merges on its own — only via this action.
	 */
	private mergeIntoGroup(
		view: NvmCustomView,
		targetGroupKey: string,
		selector: BlockSelector,
	): boolean {
		const idx = view.groups.findIndex(g => `${g.by}:${g.value}` === targetGroupKey);
		if (idx < 0) {
			return false;
		}
		const existing = view.groups[idx];
		// Normalize the target to a union of its current member selectors.
		const members = existing.by === "union" ? [...(existing.members ?? [])] : [existing];
		const memberKey = (s: BlockSelector) => `${s.by}:${s.value}`;
		if (members.some(m => memberKey(m) === memberKey(selector))) {
			return false; // already merged
		}
		members.push(selector);
		view.groups[idx] = {
			by: "union",
			// Keep a stable key across merges so the group's delete/identity survives.
			value: existing.by === "union" ? existing.value : `merged_${existing.by}_${existing.value}`,
			label: existing.label ?? selector.label,
			members,
		};
		return true;
	}

	/** Build the group selector for a block under the chosen grouping axis. */
	private selectorForBlock(
		block: NvmBlockInfo,
		by: "fingerprint" | "identity" | "id",
	): BlockSelector {
		const label = deNumber(block.name ?? block.identity?.label ?? block.id);
		switch (by) {
			case "identity":
				return { by: "identity", value: block.identity?.key ?? block.id, label };
			case "id":
				return { by: "id", value: block.id, label: block.name ?? block.id };
			case "fingerprint":
			default: {
				const fp = fingerprintBlock(block);
				// A block with a decoded structure groups by its shape fingerprint —
				// that pulls in every structurally-identical sibling. A block WITHOUT a
				// decoded tree has no fingerprint ("none"), which would otherwise match
				// every structureless block; fall back to its numeric name-family glob
				// (DemPrimaryDataBlock5 → DemPrimaryDataBlock*) so only its own indexed
				// siblings join, never unrelated blocks.
				if (fp !== "none") {
					return { by: "fingerprint", value: fp, label };
				}
				const name = block.name;
				if (name) {
					return { by: "nameGlob", value: nameFamilyGlob(name), label };
				}
				return { by: "id", value: block.id, label: block.id };
			}
		}
	}

	public async renameView(docUri: vscode.Uri, viewId: string, name: string): Promise<void> {
		const located = await this.locate(docUri, viewId);
		if (!located) {
			return;
		}
		located.view.name = name.trim() || located.view.name;
		located.view.updatedAt = Date.now();
		await this.persist(docUri, located.store, located.set);
	}

	public async deleteView(docUri: vscode.Uri, viewId: string): Promise<void> {
		const located = await this.locate(docUri, viewId);
		if (!located) {
			return;
		}
		located.set.views = located.set.views.filter(v => v.id !== viewId);
		await this.persist(docUri, located.store, located.set);
	}

	public async deleteGroup(docUri: vscode.Uri, viewId: string, groupKey: string): Promise<void> {
		const located = await this.locate(docUri, viewId);
		if (!located) {
			return;
		}
		located.view.groups = located.view.groups.filter(g => `${g.by}:${g.value}` !== groupKey);
		located.view.updatedAt = Date.now();
		await this.persist(docUri, located.store, located.set);
	}

	/** Copy a dump-scoped view into the shared template set so sibling dumps get it. */
	public async promoteToTemplate(docUri: vscode.Uri, viewId: string): Promise<void> {
		const located = await this.locate(docUri, viewId);
		if (!located || located.view.scope === "template") {
			return;
		}
		const tpl = await this.templateSetLoaded(docUri);
		tpl.views.push({
			...located.view,
			id: newId("view"),
			groups: located.view.groups.map(g => ({ ...g })),
			scope: "template",
			updatedAt: Date.now(),
		});
		await this.persist(docUri, this.templates, tpl);
	}

	/** Drop the cached sidecar set for a dump (e.g. after external edits). */
	public invalidate(docUri: vscode.Uri): void {
		this.cache.delete(docUri.toString());
	}

	private async persist(
		docUri: vscode.Uri,
		store: CustomViewStore,
		set: NvmCustomViewSet,
	): Promise<void> {
		await store.save(docUri, set);
		if (store === this.templates) {
			this.templateSet = set;
		} else {
			this.cache.set(docUri.toString(), set);
		}
		this._onDidChange.fire(docUri);
	}
}
