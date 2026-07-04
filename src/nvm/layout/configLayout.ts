// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Config-driven layout provider. Turns a vendor-supplied JSON descriptor
 * (`*.nvmlayout.json`) into colored blocks, so non-linked-list formats
 * (top-down sequential dumps, dual-ended rings, fixed tables, …) can be
 * supported purely by configuration — no code and no core changes.
 */

import { loadHexImage } from "../../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../../shared/protocol";
import { LayoutConfig, LayoutInput, NvmLayoutProvider } from "./provider";

function matches(config: LayoutConfig, input: LayoutInput): boolean {
	const m = config.match;
	if (!m) {
		return true;
	}
	if (m.ext && !m.ext.map(e => e.toLowerCase()).includes(input.ext)) {
		return false;
	}
	if (
		m.fileNameIncludes &&
		!m.fileNameIncludes.some(s => input.fileName.includes(s.toLowerCase()))
	) {
		return false;
	}
	return true;
}

function blocksFromConfig(config: LayoutConfig, imageBase: number, imageLength: number): NvmBlockInfo[] {
	const regionStart = config.baseAddress !== undefined ? config.baseAddress - imageBase : 0;
	const out: NvmBlockInfo[] = [];
	let top = regionStart;
	let bottom = regionStart + imageLength;

	config.blocks.forEach((b, index) => {
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
		).map(f => ({
			name: f.name,
			kind: f.kind,
			offset: offset + f.offset,
			length: f.length,
			unit,
		}));

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
		return input.configs.some(c => matches(c, input));
	},
	parse(input: LayoutInput): NvmBlockInfo[] {
		const image = loadHexImage(input.text);
		const { baseAddress, bytes } = image.toFlat(0xff);
		const out: NvmBlockInfo[] = [];
		for (const config of input.configs) {
			if (matches(config, input)) {
				out.push(...blocksFromConfig(config, baseAddress, bytes.length));
			}
		}
		out.sort((a, b) => a.offset - b.offset);
		return out;
	},
};
