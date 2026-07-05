// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Config-driven layout provider. Turns a vendor-supplied JSON descriptor
 * (`*.nvmlayout.json`) into colored blocks, so non-linked-list formats
 * (top-down sequential dumps, dual-ended rings, fixed tables, …) can be
 * supported purely by configuration — no code and no core changes.
 */

import { resolveFieldLink } from "../../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../../shared/protocol";
import { ResolveContext } from "./context";
import { applyPalette, effectiveStrategy, LayoutBlockDef, LayoutConfig, matchesConfig, NvmLayoutProvider } from "./provider";

/** True when the descriptor defines its own explicit `blocks` (not a built-in provider). */
function isBlockConfig(config: LayoutConfig, ctx: ResolveContext): boolean {
	return (
		!config.provider &&
		!!config.blocks?.length &&
		effectiveStrategy(config) === "positional" &&
		matchesConfig(config, ctx)
	);
}

function blocksFromConfig(
	config: LayoutConfig,
	imageBase: number,
	bytes: Uint8Array,
): NvmBlockInfo[] {
	const imageLength = bytes.length;
	const regionStart = config.baseAddress !== undefined ? config.baseAddress - imageBase : 0;
	const out: NvmBlockInfo[] = [];
	let top = regionStart;
	let bottom = regionStart + imageLength;

	(config.blocks ?? []).forEach((b: LayoutBlockDef, index) => {
		let offset: number;
		if (b.offset !== undefined) {
			offset = b.offset;
		} else if (b.from === "bottom") {
			bottom -= b.length;
			offset = bottom;
		} else {
			offset = top;
			top += b.length;
		}
		if (offset < 0) {
			return;
		}

		const unit = `${config.vendor}:${b.name}#${index}`;
		const fields: NvmFieldInfo[] = (b.fields?.length
			? b.fields
			: [{ name: b.name, kind: "payload", offset: 0, length: b.length }]
		).map(f => {
			const fieldOffset = offset + f.offset;
			const spec = (f as { link?: import("../../../shared/nvm").FieldLinkSpec }).link;
			// Decode + range-check any in-file address so the display can jump.
			const link = spec
				? resolveFieldLink(bytes, fieldOffset, spec, {
						imageBase,
						fileSize: imageLength,
					})
				: undefined;
			return {
				name: f.name,
				kind: f.kind,
				offset: fieldOffset,
				length: f.length,
				color: (f as { color?: string }).color,
				unit,
				link,
			};
		});

		out.push({
			id: unit,
			name: b.name,
			offset,
			length: b.length,
			raw: { vendor: config.vendor, arrangement: config.arrangement ?? "sequential", index },
			fields,
		});
	});

	return out;
}

export const configLayoutProvider: NvmLayoutProvider = {
	id: "config-layout",
	label: "Config-driven layout (*.nvmlayout.json)",
	detect(ctx: ResolveContext): boolean {
		return ctx.configs.some(c => isBlockConfig(c, ctx));
	},
	parse(ctx: ResolveContext): NvmBlockInfo[] {
		const { baseAddress, bytes } = ctx.image;
		const out: NvmBlockInfo[] = [];
		for (const config of ctx.configs) {
			if (isBlockConfig(config, ctx)) {
				const blocks = blocksFromConfig(config, baseAddress, bytes);
				applyPalette(blocks, config.palette);
				out.push(...blocks);
			}
		}
		out.sort((a, b) => a.offset - b.offset);
		return out;
	},
};
