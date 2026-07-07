// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parser for Vector MICROSAR generated `NvM_Cfg.c` files.
 *
 * The FEE `Fee_Lcfg.c` table (see {@link ./feeLcfg}) only knows the *stored*
 * payload length of a chunk — that is the NvM business data **plus** its
 * appended integrity bytes (CRC / CMAC) **plus** alignment padding. The
 * generated `NvM_BlockDescriptorTable_at[]` is the authoritative source for the
 * two facts the FEE table conflates:
 *
 * - `NvMNvBlockLength`  → the real NvM business-data length (what a struct
 *   decoder should read), and
 * - `NvMacSize`         → the integrity-check size that follows the data.
 *
 * Example (`Nvm_SafeSection_Index`): FEE payload length `17` = `1` byte data
 * (`NvMNvBlockLength`) + `16` byte CMAC (`NvMacSize`) + 6 bytes padding. Without
 * `NvM_Cfg.c` the engine would (wrongly) treat all 17 bytes as business data and
 * decode a struct into the CMAC bytes.
 *
 * This parser is intentionally tolerant: it keys blocks by the leading name
 * comment the generator emits and reads each labelled field by its trailing
 * comment, so field-ordering changes between MICROSAR versions do not break it.
 */

/** One entry of `NvM_BlockDescriptorTable_at[]`, keyed by its block name. */
export interface NvmCfgBlock {
	/** Logical block name from the leading name comment on the entry. */
	name: string;
	/** `NvMNvBlockLength` — the real business-data length in bytes. */
	nvBlockLength: number;
	/** `NvMNvBlockNVRAMDataLength`, when present. */
	nvramDataLength?: number;
	/** `NvMacSize` — trailing integrity-check (CMAC) size in bytes (0 = none). */
	macSize: number;
	/** `NV block Base number (defined by FEE/EA)`, when present. */
	blockBaseNumber?: number;
	/** `NvMBlockDataIntegrityType`, e.g. `NVM_BLOCK_MAC_ON` / `NVM_BLOCK_CRC_16_ON`. */
	dataIntegrityType?: string;
}

/** Escape a literal string for embedding in a `RegExp`. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read a numeric field identified by its trailing `/* <label> ... *\/` comment
 * from a single block body. Accepts decimal (`1u`, `0U`) and hex (`0x02E0u`).
 */
function labeledNumber(body: string, label: string): number | undefined {
	const re = new RegExp(
		`(0x[0-9A-Fa-f]+|\\d+)\\s*[Uu]?\\s*\\/\\*\\s*${escapeRegExp(label)}[^*]*\\*\\/`,
	);
	const m = re.exec(body);
	if (!m) {
		return undefined;
	}
	const raw = m[1];
	return /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
}

/**
 * Parse the `NvM_BlockDescriptorTable_at[]` array out of an `NvM_Cfg.c` source
 * string. Returns `[]` when the table is absent (e.g. an unrelated source).
 */
export function parseNvmCfg(source: string): NvmCfgBlock[] {
	const blocks: NvmCfgBlock[] = [];

	const start = source.indexOf("NvM_BlockDescriptorTable_at");
	if (start < 0) {
		return blocks;
	}
	const region = source.slice(start);

	// Each array element opens with `{ /* BlockName */`. The nested `Flags`
	// initializer opens with a bare `{` (no comment), so requiring a comment
	// immediately after the brace uniquely identifies element boundaries.
	const opener = /\{\s*\/\*\s+([A-Za-z_][\w]*)\s+\*\//g;
	const openers: { name: string; index: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = opener.exec(region)) !== null) {
		openers.push({ name: m[1], index: m.index });
	}

	for (let i = 0; i < openers.length; i++) {
		const bodyStart = openers[i].index;
		const bodyEnd = i + 1 < openers.length ? openers[i + 1].index : region.length;
		const body = region.slice(bodyStart, bodyEnd);

		const nvBlockLength = labeledNumber(body, "NvMNvBlockLength");
		if (nvBlockLength === undefined) {
			// Not a real descriptor entry (guards against a name-like comment that
			// is not part of the table).
			continue;
		}
		const integrity = /(NVM_BLOCK_[A-Z0-9_]+)\s*\/\*\s*NvMBlockDataIntegrityType/.exec(body);

		blocks.push({
			name: openers[i].name,
			nvBlockLength,
			nvramDataLength: labeledNumber(body, "NvMNvBlockNVRAMDataLength"),
			macSize: labeledNumber(body, "NvMacSize") ?? 0,
			blockBaseNumber: labeledNumber(body, "NV block Base number"),
			dataIntegrityType: integrity?.[1],
		});
	}

	return blocks;
}

/** Build a `name -> NvmCfgBlock` lookup for fast per-block resolution. */
export function nvmCfgByName(blocks: NvmCfgBlock[]): Map<string, NvmCfgBlock> {
	const map = new Map<string, NvmCfgBlock>();
	for (const b of blocks) {
		map.set(b.name, b);
	}
	return map;
}
