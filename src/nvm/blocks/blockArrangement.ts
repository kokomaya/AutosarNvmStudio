// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Block arrangement strategies (Strategy pattern). Each takes the flat list of
 * vendor-neutral blocks and produces a display tree. Adding a new arrangement
 * means adding one class here — the tree provider is untouched (Open/Closed).
 *
 * Only the generic {@link NvmBlockInfo} fields (`offset`, `group`, `sequence`,
 * `identity`) are read; nothing vendor-specific.
 */

import { NvmBlockInfo } from "../../../shared/protocol";
import { BlockNode, blockLabel } from "./blockTreeModel";

/** A named strategy that arranges blocks into a display tree. */
export interface BlockArrangement {
	/** Stable id (persisted / referenced by commands). */
	readonly id: string;
	/** Human-readable label for the arrangement picker. */
	readonly label: string;
	/** Codicon id shown next to the label. */
	readonly icon: string;
	arrange(blocks: readonly NvmBlockInfo[]): BlockNode[];
}

const byOffset = (a: NvmBlockInfo, b: NvmBlockInfo) => a.offset - b.offset;

function blockNodes(blocks: readonly NvmBlockInfo[]): BlockNode[] {
	return blocks.map(block => ({ kind: "block", block }));
}

/** Flat list ordered by editor offset. */
class FlatArrangement implements BlockArrangement {
	public readonly id = "flat";
	public readonly label = "Flat (by address)";
	public readonly icon = "list-flat";
	public arrange(blocks: readonly NvmBlockInfo[]): BlockNode[] {
		return blockNodes([...blocks].sort(byOffset));
	}
}

/** Group blocks by their {@link NvmBlockInfo.group} bucket (e.g. sector). */
class GroupBySectorArrangement implements BlockArrangement {
	public readonly id = "sector";
	public readonly label = "Group by sector";
	public readonly icon = "layers";
	public arrange(blocks: readonly NvmBlockInfo[]): BlockNode[] {
		const groups = new Map<string, { label: string; order: number; items: NvmBlockInfo[] }>();
		const ungrouped: NvmBlockInfo[] = [];
		for (const block of blocks) {
			if (!block.group) {
				ungrouped.push(block);
				continue;
			}
			const existing = groups.get(block.group.key);
			if (existing) {
				existing.items.push(block);
			} else {
				groups.set(block.group.key, {
					label: block.group.label,
					order: block.group.order ?? Number.MAX_SAFE_INTEGER,
					items: [block],
				});
			}
		}
		const nodes: BlockNode[] = [...groups.entries()]
			.sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label))
			.map(([key, g]) => ({
				kind: "group" as const,
				key,
				label: g.label,
				description: `${g.items.length}`,
				children: blockNodes(g.items.sort(byOffset)),
			}));
		if (ungrouped.length > 0) {
			nodes.push({
				kind: "group",
				key: "__ungrouped__",
				label: "Ungrouped",
				description: `${ungrouped.length}`,
				children: blockNodes(ungrouped.sort(byOffset)),
			});
		}
		return nodes;
	}
}

/**
 * Order blocks by best-effort write sequence (earliest → latest). Blocks whose
 * order could not be derived (`sequence` undefined) are collected into a
 * trailing "Unknown order" group instead of being interleaved.
 */
class OrderByWriteArrangement implements BlockArrangement {
	public readonly id = "write";
	public readonly label = "Order by write time";
	public readonly icon = "history";
	public arrange(blocks: readonly NvmBlockInfo[]): BlockNode[] {
		const ordered = blocks.filter(b => typeof b.sequence === "number");
		const unknown = blocks.filter(b => typeof b.sequence !== "number");
		ordered.sort((a, b) => a.sequence! - b.sequence! || a.offset - b.offset);
		const nodes: BlockNode[] = blockNodes(ordered);
		if (unknown.length > 0) {
			nodes.push({
				kind: "group",
				key: "__unknownOrder__",
				label: "Unknown order",
				description: `${unknown.length}`,
				children: blockNodes(unknown.sort(byOffset)),
			});
		}
		return nodes;
	}
}

/**
 * Group blocks that share a logical {@link NvmBlockInfo.identity} (i.e. the same
 * block's multiple versions / copies). Within a group the newest instance is
 * listed first.
 */
class GroupByIdentityArrangement implements BlockArrangement {
	public readonly id = "identity";
	public readonly label = "Group by block id";
	public readonly icon = "versions";
	public arrange(blocks: readonly NvmBlockInfo[]): BlockNode[] {
		const groups = new Map<string, { label: string; items: NvmBlockInfo[] }>();
		const standalone: NvmBlockInfo[] = [];
		for (const block of blocks) {
			if (!block.identity) {
				standalone.push(block);
				continue;
			}
			const existing = groups.get(block.identity.key);
			if (existing) {
				existing.items.push(block);
			} else {
				groups.set(block.identity.key, { label: block.identity.label, items: [block] });
			}
		}
		const rank = (b: NvmBlockInfo) => (typeof b.sequence === "number" ? b.sequence : -Infinity);
		const nodes: BlockNode[] = [...groups.entries()]
			.sort((a, b) => a[1].label.localeCompare(b[1].label))
			.map(([key, g]) => ({
				kind: "group" as const,
				key,
				label: g.label,
				description: `${g.items.length}`,
				children: blockNodes(g.items.sort((x, y) => rank(y) - rank(x) || x.offset - y.offset)),
			}));
		if (standalone.length > 0) {
			nodes.push({
				kind: "group",
				key: "__standalone__",
				label: "Other",
				description: `${standalone.length}`,
				children: blockNodes(
					standalone.sort((a, b) => blockLabel(a).localeCompare(blockLabel(b)) || byOffset(a, b)),
				),
			});
		}
		return nodes;
	}
}

/** All available arrangements, in picker order. */
export const ARRANGEMENTS: readonly BlockArrangement[] = [
	new FlatArrangement(),
	new GroupBySectorArrangement(),
	new OrderByWriteArrangement(),
	new GroupByIdentityArrangement(),
];

/** Resolve an arrangement by id, falling back to the first (flat). */
export function arrangementById(id: string | undefined): BlockArrangement {
	return ARRANGEMENTS.find(a => a.id === id) ?? ARRANGEMENTS[0];
}
