// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parser for Vector MICROSAR generated `Fee_Lcfg.c` files.
 *
 * The FEE block configuration table (`Fee_BlockConfig_at[]`) maps the physical
 * flash "link-table index" (a.k.a. the block `tag` stored inside every FEE
 * chunk) to the logical block name and payload length. This mapping is *not*
 * derivable from the ARXML `FeeBlockNumber` alone, therefore the generated
 * source is required to resolve chunk tags into business block names.
 *
 * See docs/design.md [TODO-Vector].
 */

export interface FeeLcfgBlock {
	/** Index of the block in the FEE link table. Equals the chunk `tag`. */
	blkIdx: number;
	/** Configured payload length in bytes (net user data, excluding CRC). */
	payloadLength: number;
	/** Number of datasets (redundant instances). */
	numberOfDatasets: number;
	/** Exponent of the number of instances per chunk: instances = 2^n. */
	instanceExponent: number;
	/** Base index of the block in the look-up table. */
	baseIndex: number;
	immediateData: boolean;
	criticalData: boolean;
	lookUpTableBlock: boolean;
	/** Logical block name taken from the `Block:` comment. */
	name: string;
}

/**
 * Parse the `Fee_BlockConfig_at[]` array out of a `Fee_Lcfg.c` source string.
 */
export function parseFeeLcfg(source: string): FeeLcfgBlock[] {
	const blocks: FeeLcfgBlock[] = [];

	// Isolate the block configuration array body.
	const start = source.indexOf("Fee_BlockConfig_at");
	if (start < 0) {
		return blocks;
	}
	const braceStart = source.indexOf("{", start);
	if (braceStart < 0) {
		return blocks;
	}

	// Each entry starts with a `Block:` comment; split on it so every segment
	// contains exactly one block definition.
	const region = source.slice(braceStart);
	const parts = region.split(/\/\*\s*Block:\s*/);
	for (let i = 1; i < parts.length; i++) {
		const seg = parts[i];
		// The name is the first token up to the closing comment `*/`.
		const nameMatch = /^([^\s*]+)/.exec(seg);
		if (!nameMatch) {
			continue;
		}
		const name = nameMatch[1];

		// Stop the segment at the end of this struct initializer so numbers from
		// the following entry never leak in.
		const bodyEnd = seg.indexOf("}");
		const body = bodyEnd >= 0 ? seg.slice(0, bodyEnd) : seg;

		const numbers = Array.from(body.matchAll(/(\d+)\s*u\b/gi)).map(m => Number(m[1]));
		const bools = Array.from(body.matchAll(/\b(TRUE|FALSE)\b/gi)).map(m => m[1].toUpperCase() === "TRUE");

		if (numbers.length < 4) {
			continue;
		}

		blocks.push({
			blkIdx: numbers[0],
			payloadLength: numbers[1],
			numberOfDatasets: numbers[2],
			instanceExponent: numbers[3],
			baseIndex: numbers.length > 4 ? numbers[4] : 0,
			immediateData: bools[0] ?? false,
			criticalData: bools[1] ?? false,
			lookUpTableBlock: bools[2] ?? false,
			name,
		});
	}

	return blocks;
}

/** Build a `tag -> FeeLcfgBlock` lookup for fast chunk resolution. */
export function feeLcfgByTag(blocks: FeeLcfgBlock[]): Map<number, FeeLcfgBlock> {
	const map = new Map<number, FeeLcfgBlock>();
	for (const b of blocks) {
		map.set(b.blkIdx, b);
	}
	return map;
}
