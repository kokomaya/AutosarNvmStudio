// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure, vendor-blind resolver for user-composable custom views.
 *
 * A {@link NvmCustomView} is a declarative recipe: pick *whole blocks* by generic
 * metadata (a decoded-structure fingerprint / logical identity / id / name glob)
 * and this module lays every matched block out as a row, auto-deriving the
 * columns from the union of the blocks' decoded field paths. Blocks that decode
 * to the same structure (e.g. Record0/Record1/Record2, decoded from one C
 * struct) share a fingerprint and land in the same sub-table; unrelated
 * structures form their own sub-tables in the same view.
 *
 * It contains NO vendor or use-case knowledge — the words "reset"/"DEM" never
 * appear; a view is only a name and a set of block selectors. The fingerprint is
 * a pure hash of the generic decoded tree shape. The whole module is pure data +
 * arithmetic (no `src/` or Node imports, no Date/Math.random) so it is safe in
 * the desktop build, the web build, and the injected engine SDK, and is
 * trivially unit-testable with synthetic blocks.
 */

import { NvmBlockInfo } from "../protocol";
import { NvmDecodedNode } from "./structRich";

/** Where a view's definition lives (and thus how widely it applies). */
export type ViewScope = "dump" | "template";

/**
 * How a group of blocks is chosen (all vendor-neutral):
 * - `fingerprint`: all blocks whose decoded tree shape hashes to `value`
 *   (structurally identical blocks — the primary "add a block, get its family").
 * - `identity`: match `block.identity.key` (a block's versions/copies).
 * - `id`: match a single `block.id` exactly.
 * - `nameGlob`: match `block.name` against a `*`-glob.
 * - `union`: the union of the `members` selectors — a user-curated group that
 *   merges blocks the plugin can NOT prove are related (e.g. differently-named,
 *   un-decoded blocks the user asserts share a layout). The plugin never forms a
 *   union on its own; it only records what the user explicitly merged.
 */
export interface BlockSelector {
	by: "fingerprint" | "identity" | "id" | "nameGlob" | "union";
	value: string;
	/** Human label for the group (e.g. the representative block name, de-numbered). */
	label?: string;
	/** For `by: "union"` only: the merged member selectors (each matched in turn). */
	members?: BlockSelector[];
}

/** A single user-defined custom view: a set of block groups. */
export interface NvmCustomView {
	id: string;
	name: string;
	scope: ViewScope;
	/** Each selector contributes one sub-table (usually one fingerprint family). */
	groups: BlockSelector[];
	createdAt: number;
	updatedAt: number;
}

/** The full set of custom views for one storage backend. */
export interface NvmCustomViewSet {
	version: number;
	views: NvmCustomView[];
}

/** A resolved cell: display text plus an optional byte range to reveal on click. */
export interface ResolvedCell {
	text: string;
	/** Absolute editor byte offset of the source node, when the field was found. */
	offset?: number;
	length?: number;
}

/** A resolved column (a decoded field path shared across the group). */
export interface ResolvedColumn {
	key: string;
	label: string;
}

/** A resolved row: one matched block, keyed cells for each column. */
export interface ResolvedRow {
	blockLabel: string;
	blockOffset: number;
	cells: Record<string, ResolvedCell>;
}

/** A resolved sub-table: all blocks matched by one group selector. */
export interface ResolvedGroup {
	/** Stable key = the selector's `by:value` (used for delete-group actions). */
	key: string;
	label: string;
	columns: ResolvedColumn[];
	rows: ResolvedRow[];
	matchedBlocks: number;
}

/** The flat, render-ready projection of a custom view over the current blocks. */
export interface ResolvedView {
	id: string;
	name: string;
	scope: ViewScope;
	groups: ResolvedGroup[];
}

/** Convert a `*`-glob (only `*` is special) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Collect the ordered leaf "path:type" tokens of a decoded tree. Two blocks
 * decoded from the same struct produce the same token sequence regardless of
 * their values, so a hash of it is a stable structural fingerprint.
 */
function collectLeafTokens(nodes: readonly NvmDecodedNode[], prefix: string, out: string[]): void {
	for (const n of nodes) {
		const path = prefix ? `${prefix}.${n.name}` : n.name;
		if (n.children && n.children.length > 0) {
			collectLeafTokens(n.children, path, out);
		} else {
			out.push(`${path}:${n.type}`);
		}
	}
}

/** FNV-1a 32-bit hash as an 8-char hex string (deterministic, no RNG). */
function fnv1a(str: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		// h *= 16777619, kept in 32-bit via Math.imul.
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable hash of a block's decoded-structure shape. Blocks decoded from the
 * same struct share it; blocks with no decoded tree get the sentinel "none".
 */
export function fingerprintBlock(block: NvmBlockInfo): string {
	if (!block.decoded || block.decoded.length === 0) {
		return "none";
	}
	const tokens: string[] = [];
	collectLeafTokens(block.decoded, "", tokens);
	return fnv1a(tokens.join("|"));
}

/** Whether a single selector matches a block. */
function selectorMatches(sel: BlockSelector, block: NvmBlockInfo): boolean {
	switch (sel.by) {
		case "fingerprint":
			// "none" is the sentinel for "no decoded structure" — it must NEVER be a
			// grouping key, or every structureless block would collapse into one group.
			return sel.value !== "none" && fingerprintBlock(block) === sel.value;
		case "identity":
			return block.identity?.key === sel.value;
		case "id":
			return block.id === sel.value;
		case "nameGlob":
			return block.name !== undefined && globToRegExp(sel.value).test(block.name);
		case "union":
			// A user-curated merge: match if ANY member selector matches.
			return (sel.members ?? []).some(m => selectorMatches(m, block));
		default:
			return false;
	}
}

/** Blocks matched by a selector, in offset order. */
export function selectBlocks(
	selector: BlockSelector,
	blocks: readonly NvmBlockInfo[],
): NvmBlockInfo[] {
	return blocks
		.filter(b => selectorMatches(selector, b))
		.slice()
		.sort((a, b) => a.offset - b.offset);
}

/** Descend a decoded tree by node-name path; undefined if any segment is absent. */
export function findNode(
	nodes: readonly NvmDecodedNode[] | undefined,
	path: readonly string[],
): NvmDecodedNode | undefined {
	if (!nodes || path.length === 0) {
		return undefined;
	}
	let current: NvmDecodedNode | undefined = nodes.find(n => n.name === path[0]);
	for (let i = 1; current && i < path.length; i++) {
		current = current.children?.find(n => n.name === path[i]);
	}
	return current;
}

/**
 * Render a decoded node to compact display text. Mirrors the webview's
 * `formatNodeValue`: prefer the enum label, then the physical value, then the
 * pre-rendered hex; append the unit when present. Purely presentational.
 */
export function nodeText(node: NvmDecodedNode | undefined): string {
	if (!node) {
		return "";
	}
	let text: string;
	if (node.enumLabel !== undefined) {
		text = node.enumLabel;
	} else if (node.value !== undefined) {
		text = typeof node.value === "boolean" ? (node.value ? "true" : "false") : String(node.value);
	} else if (node.hex !== undefined) {
		text = node.hex;
	} else if (node.raw !== undefined) {
		text = String(node.raw);
	} else {
		text = "";
	}
	return node.unit ? `${text} ${node.unit}` : text;
}

/** Best display label for a block (name, else identity label, else hex offset). */
function blockLabel(block: NvmBlockInfo): string {
	return block.name ?? block.identity?.label ?? `0x${block.offset.toString(16).toUpperCase()}`;
}

/** Strip a trailing run of digits from a name (Record0 → Record), for group titles. */
export function deNumber(name: string): string {
	return name.replace(/\d+$/, "") || name;
}

/**
 * The `*`-glob for a block name's numeric family: `DemPrimaryDataBlock5` →
 * `DemPrimaryDataBlock*`, so all its siblings (…Block0, …Block1, …) match while
 * unrelated names (`DemStatusDataBlock`) do NOT. Used to group structureless
 * blocks (no decoded tree, hence no fingerprint) by their naming convention.
 */
export function nameFamilyGlob(name: string): string {
	const base = deNumber(name);
	return base === name ? name : `${base}*`;
}

/**
 * Collect every leaf field path across a set of blocks, in first-seen order.
 * Each column key is the dotted path; the label is the last segment. Deeper
 * fields are flattened so nested-struct members become their own columns.
 */
function unionColumns(blocks: readonly NvmBlockInfo[]): ResolvedColumn[] {
	const seen = new Set<string>();
	const columns: ResolvedColumn[] = [];
	const walk = (nodes: readonly NvmDecodedNode[] | undefined, prefix: string): void => {
		for (const n of nodes ?? []) {
			const path = prefix ? `${prefix}.${n.name}` : n.name;
			if (n.children && n.children.length > 0) {
				walk(n.children, path);
			} else if (!seen.has(path)) {
				seen.add(path);
				columns.push({ key: path, label: n.name });
			}
		}
	};
	for (const b of blocks) {
		walk(b.decoded, "");
	}
	return columns;
}

/** Resolve one group selector into a sub-table. */
function resolveGroup(selector: BlockSelector, blocks: readonly NvmBlockInfo[]): ResolvedGroup {
	const matched = selectBlocks(selector, blocks);
	const columns = unionColumns(matched);
	const rows: ResolvedRow[] = matched.map(block => {
		const cells: Record<string, ResolvedCell> = {};
		for (const col of columns) {
			const node = findNode(block.decoded, col.key.split("."));
			cells[col.key] = node
				? { text: nodeText(node), offset: node.offset, length: node.length }
				: { text: "" };
		}
		return { blockLabel: blockLabel(block), blockOffset: block.offset, cells };
	});
	const label =
		selector.label ?? (matched.length ? deNumber(blockLabel(matched[0])) : selector.value);
	return {
		key: `${selector.by}:${selector.value}`,
		label,
		columns,
		rows,
		matchedBlocks: matched.length,
	};
}

/**
 * Resolve a custom view against the current blocks into per-group sub-tables.
 * Each group is a family of structurally-matching blocks laid out as rows with
 * auto-derived columns; missing fields yield empty cells.
 */
export function resolveCustomView(
	view: NvmCustomView,
	blocks: readonly NvmBlockInfo[],
): ResolvedView {
	return {
		id: view.id,
		name: view.name,
		scope: view.scope,
		groups: view.groups.map(g => resolveGroup(g, blocks)),
	};
}
