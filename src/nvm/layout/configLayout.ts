// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Config-driven layout provider. Turns a vendor-supplied JSON descriptor
 * (`*.nvmlayout.json`) into colored blocks, so non-linked-list formats
 * (top-down sequential dumps, dual-ended rings, fixed tables, …) can be
 * supported purely by configuration — no code and no core changes.
 */

import { loadHexImage, resolveFieldLink } from "../../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../../shared/protocol";
import { applyPalette, LayoutBlockDef, LayoutConfig, LayoutInput, matchesConfig, NvmLayoutProvider } from "./provider";

/** True when the descriptor defines its own explicit `blocks` (not a built-in provider). */
function isBlockConfig(config: LayoutConfig, input: LayoutInput): boolean {
	return !config.provider && !!config.blocks?.length && matchesConfig(config, input);
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
	detect(input: LayoutInput): boolean {
		return input.configs.some(c => isBlockConfig(c, input));
	},
	parse(input: LayoutInput): NvmBlockInfo[] {
		const image = loadHexImage(input.text);
		const { baseAddress, bytes } = image.toFlat(0xff);
		const out: NvmBlockInfo[] = [];
		for (const config of input.configs) {
			if (isBlockConfig(config, input)) {
				const blocks = blocksFromConfig(config, baseAddress, bytes);
				applyPalette(blocks, config.palette);
				out.push(...blocks);
			}
		}
		out.sort((a, b) => a.offset - b.offset);
		return out;
	},
};
