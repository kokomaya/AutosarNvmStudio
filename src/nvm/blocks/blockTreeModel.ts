// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure view-model for the NVM Blocks views. Converts the vendor-neutral
 * {@link NvmBlockInfo} shape into display nodes and formats its generic
 * {@link NvmAttribute} columns. No VS Code / vendor knowledge lives here so the
 * same model can back both the native tree and the (later) webview table.
 */

import { NvmAttribute, NvmBlockInfo } from "../../../shared/protocol";

/** A node in a Blocks tree: either a grouping bucket or a single block. */
export type BlockNode =
	| {
			kind: "group";
			/** Stable key for the bucket. */
			key: string;
			label: string;
			/** Secondary text (usually the child count). */
			description?: string;
			children: BlockNode[];
	  }
	| {
			kind: "block";
			block: NvmBlockInfo;
	  };

/** Format a byte offset as an upper-case `0x` hex string. */
export function hexOffset(offset: number): string {
	return `0x${offset.toString(16).toUpperCase()}`;
}

/** Best display label for a block (its name, else its identity, else offset). */
export function blockLabel(block: NvmBlockInfo): string {
	return block.name ?? block.identity?.label ?? hexOffset(block.offset);
}

/** Stringify a single attribute value for compact display. */
export function formatAttributeValue(attr: NvmAttribute): string {
	if (typeof attr.value === "boolean") {
		return attr.value ? "yes" : "no";
	}
	return String(attr.value);
}

/**
 * Build the tree-item description line from the user-selected attribute keys,
 * preserving the order the keys are listed in. Keys with no matching attribute
 * on this block are skipped.
 */
export function blockDescription(block: NvmBlockInfo, selectedKeys: readonly string[]): string {
	const byKey = new Map((block.attributes ?? []).map(a => [a.key, a]));
	const parts: string[] = [];
	for (const key of selectedKeys) {
		const attr = byKey.get(key);
		if (attr) {
			parts.push(formatAttributeValue(attr));
		}
	}
	return parts.join("  ·  ");
}

/** Every attribute key present across the given blocks, in first-seen order. */
export function discoverAttributeKeys(blocks: readonly NvmBlockInfo[]): NvmAttribute[] {
	const seen = new Map<string, NvmAttribute>();
	for (const block of blocks) {
		for (const attr of block.attributes ?? []) {
			if (!seen.has(attr.key)) {
				seen.set(attr.key, attr);
			}
		}
	}
	return [...seen.values()];
}
