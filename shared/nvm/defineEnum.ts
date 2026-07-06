// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Generic scraper for "symbolic-name-value" `#define` tables in generated C
 * headers, e.g. AUTOSAR's DEM event-id list:
 *
 *   #define DemConf_DemEventParameter_ADC_E_HARDWARE_ERROR   146u
 *   #define DemConf_DemEventParameter_CANSM_E_BUSOFF_NETWORK_0 2u
 *
 * This is **vendor-blind**: it knows nothing about DEM, Vector, or any layout —
 * it only turns `#define <prefix><NAME> <integer>` lines into a value→name map
 * (id 146 → "ADC_E_HARDWARE_ERROR"). The caller supplies the prefix, so the same
 * function serves any such table (DTC ids, reset reasons, state ids, …).
 *
 * The output feeds two consumers with one parse:
 *  - the engine's struct catalog (an enum a decoded field can label its value with), and
 *  - a `symbols` adapter (id → business name for block naming).
 *
 * Pure data + regex (no `src/` or Node imports) so it is safe in the desktop
 * build, the web build, and the injected engine SDK, and is unit-testable.
 */

/** A parsed value→name mapping (numeric id as decimal string → symbolic name). */
export interface DefineEnumMap {
	/** Numeric value (as a decimal string key) → symbolic name (prefix stripped). */
	values: Record<string, string>;
}

/**
 * Parse `#define <prefix><NAME> <int>` lines into a value→name map. `NAME` is the
 * macro identifier with `prefix` stripped; the value accepts decimal or `0x` hex,
 * with an optional integer suffix (`u`, `U`, `ul`, `L`, …). Later duplicate values
 * keep the FIRST name seen (matching "sorted by name" tables where the lowest name
 * wins), and duplicate names keep the first value. Lines that don't match are
 * ignored, so a whole header can be passed in.
 *
 * @param source  raw C header text
 * @param prefix  the macro name prefix to require and strip (e.g.
 *                `"DemConf_DemEventParameter_"`). Must be non-empty.
 */
export function parseDefineEnum(source: string, prefix: string): DefineEnumMap {
	const values: Record<string, string> = {};
	if (!source || !prefix) {
		return { values };
	}
	// #define <prefix><NAME>   <number>[suffix]
	// NAME = identifier chars; number = 0x-hex or decimal; suffix = u/U/l/L repeated.
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`^[ \\t]*#[ \\t]*define[ \\t]+${escaped}([A-Za-z_]\\w*)[ \\t]+` +
			`(0[xX][0-9A-Fa-f]+|\\d+)[uUlL]*\\b`,
		"gm",
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		const name = m[1];
		const raw = m[2];
		const value = raw.toLowerCase().startsWith("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
		if (!Number.isFinite(value)) {
			continue;
		}
		const key = String(value);
		// First name wins per value (table is "sorted by name"); keep the earliest.
		if (values[key] === undefined) {
			values[key] = name;
		}
	}
	return { values };
}

/**
 * The inverse view: symbolic name → numeric value, for callers that need to look
 * up an id by name (e.g. a `symbols` adapter keyed by id). Built from the same
 * parse; when several names share a value each name maps to that value.
 */
export function parseDefineEnumByName(source: string, prefix: string): Map<string, number> {
	const byName = new Map<string, number>();
	if (!source || !prefix) {
		return byName;
	}
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`^[ \\t]*#[ \\t]*define[ \\t]+${escaped}([A-Za-z_]\\w*)[ \\t]+` +
			`(0[xX][0-9A-Fa-f]+|\\d+)[uUlL]*\\b`,
		"gm",
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		const name = m[1];
		const raw = m[2];
		const value = raw.toLowerCase().startsWith("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
		if (Number.isFinite(value) && !byName.has(name)) {
			byName.set(name, value);
		}
	}
	return byName;
}
