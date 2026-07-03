// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { computeCrc, CrcModel, resolveCrcPreset } from "./crc";
import { evaluateExpression } from "./expr";
import {
    ByteRange,
    Endianness,
    NvmBlock,
    NvmBlockInstance,
    NvmIssue,
    NvmModel,
} from "./model";
import { BlockSpec, CrcSpec, MarkerSpec, NvmProfile } from "./profile";

/** Read an unsigned integer (1..4 bytes) from the image. */
function readUint(data: Uint8Array, offset: number, size: number, endian: Endianness): number {
	let value = 0;
	if (endian === "little") {
		for (let i = size - 1; i >= 0; i--) {
			value = value * 256 + data[offset + i];
		}
	} else {
		for (let i = 0; i < size; i++) {
			value = value * 256 + data[offset + i];
		}
	}
	return value >>> 0;
}

function alignUp(value: number, alignment: number): number {
	if (alignment <= 1) {
		return value;
	}
	const remainder = value % alignment;
	return remainder === 0 ? value : value + (alignment - remainder);
}

function headerSizeOf(block: BlockSpec): number {
	if (typeof block.headerSize === "number") {
		return block.headerSize;
	}
	let size = 0;
	for (const field of block.header) {
		size = Math.max(size, field.offset + field.size);
	}
	return size;
}

function crcModelOf(spec: CrcSpec): CrcModel {
	return spec.model ?? resolveCrcPreset(spec.preset as string);
}

interface ParsedHeader {
	/** Post-transform field values keyed by name. */
	values: Record<string, number>;
	/** Names indexed by role for quick lookup. */
	byRole: Partial<Record<string, string>>;
}

function parseHeader(
	data: Uint8Array,
	blockStart: number,
	block: BlockSpec,
	defaultEndian: Endianness,
): ParsedHeader {
	const values: Record<string, number> = {};
	const byRole: Partial<Record<string, string>> = {};
	for (const field of block.header) {
		const endian = field.endian ?? defaultEndian;
		const raw = readUint(data, blockStart + field.offset, field.size, endian);
		let value = raw;
		if (field.transform) {
			value = evaluateExpression(field.transform, { ...values, v: raw }) >>> 0;
		}
		values[field.name] = value;
		if (field.role) {
			byRole[field.role] = field.name;
		}
	}
	return { values, byRole };
}

function resolvePayloadLength(block: BlockSpec, header: ParsedHeader): number {
	const spec = block.payload.length;
	if (typeof spec === "number") {
		return spec;
	}
	if (spec.startsWith("$")) {
		const name = spec.slice(1);
		if (!(name in header.values)) {
			throw new Error(`payload.length references unknown field "${name}"`);
		}
		return header.values[name];
	}
	return evaluateExpression(spec, header.values) >>> 0;
}

function readMarker(data: Uint8Array, blockStart: number, marker: MarkerSpec): number | undefined {
	const at = blockStart + marker.at;
	if (at + marker.size > data.length) {
		return undefined;
	}
	return readUint(data, at, marker.size, marker.endian ?? "little");
}

function evaluateCrc(
	data: Uint8Array,
	spec: CrcSpec,
	fileRange: ByteRange,
	payloadRange: ByteRange,
	header: ParsedHeader,
): { stored?: number; computed?: number; valid?: boolean } {
	const model = crcModelOf(spec);

	let rangeStart: number;
	let rangeEnd: number;
	switch (spec.range) {
		case "payload":
			rangeStart = payloadRange.start;
			rangeEnd = payloadRange.end;
			break;
		case "header":
			rangeStart = fileRange.start;
			rangeEnd = payloadRange.start;
			break;
		case "header+payload":
			rangeStart = fileRange.start;
			rangeEnd = payloadRange.end;
			break;
	}

	const computed = computeCrc(data, model, rangeStart, rangeEnd);

	let stored: number | undefined;
	if (spec.stored.source === "trailer") {
		const at = payloadRange.end;
		if (at + spec.stored.size <= data.length) {
			stored = readUint(data, at, spec.stored.size, spec.stored.endian ?? "little");
		}
	} else {
		stored = header.values[spec.stored.field];
	}

	return { stored, computed, valid: stored === undefined ? undefined : stored === computed };
}

/**
 * Parse an image into an NvmModel using the given profile.
 *
 * M0 handles the linear (container "none") path with sequential /
 * fixed-count iteration, header parsing, payload length resolution and
 * optional CRC validation.
 */
export function parseNvm(data: Uint8Array, profile: NvmProfile): NvmModel {
	const block = profile.block;
	const defaultEndian: Endianness = profile.endian ?? "little";
	const headerSize = headerSizeOf(block);
	const align = block.align ?? 1;
	const trailerSize =
		profile.integrity?.crc?.stored.source === "trailer"
			? profile.integrity.crc.stored.size
			: 0;

	const allInstances: NvmBlockInstance[] = [];
	const issues: NvmIssue[] = [];

	let offset = block.start ?? 0;
	let index = 0;
	const maxCount = block.iterate === "fixed-count" ? block.count ?? 0 : Infinity;

	while (offset + headerSize <= data.length && index < maxCount) {
		// Terminate on an end marker before attempting to parse a block.
		if (block.endMarker) {
			const marker = readMarker(data, offset, block.endMarker);
			if (marker === block.endMarker.value) {
				break;
			}
		}

		let header: ParsedHeader;
		let payloadLength: number;
		try {
			header = parseHeader(data, offset, block, defaultEndian);
			payloadLength = resolvePayloadLength(block, header);
		} catch (err) {
			issues.push({
				severity: "error",
				code: "HEADER_PARSE_FAILED",
				fileRange: { start: offset, end: Math.min(offset + headerSize, data.length) },
				message: err instanceof Error ? err.message : String(err),
			});
			break;
		}

		if (payloadLength < 0) {
			issues.push({
				severity: "error",
				code: "INVALID_LENGTH",
				fileRange: { start: offset, end: offset + headerSize },
				message: `Computed payload length ${payloadLength} is negative`,
			});
			break;
		}

		const payloadStart = offset + headerSize;
		const payloadEnd = payloadStart + payloadLength;
		const rawTotal = headerSize + payloadLength + trailerSize;
		const totalSize = alignUp(rawTotal, align);
		const fileRange: ByteRange = { start: offset, end: offset + totalSize };
		const payloadRange: ByteRange = { start: payloadStart, end: payloadEnd };

		if (payloadEnd + trailerSize > data.length) {
			issues.push({
				severity: "warning",
				code: "OUT_OF_BOUNDS",
				fileRange,
				message: `Block at offset ${offset} extends beyond the image (${data.length} bytes)`,
			});
		}

		const logicalId = header.byRole.blockId
			? header.values[header.byRole.blockId]
			: index;

		const instance: NvmBlockInstance = {
			logicalId,
			fileRange,
			header: header.values,
			payloadRange,
			crc: {},
			status: "valid",
		};

		if (header.byRole.version) {
			instance.version = header.values[header.byRole.version];
		}
		if (header.byRole.datasetIndex) {
			instance.datasetIndex = header.values[header.byRole.datasetIndex];
		}

		const crcSpec = profile.integrity?.crc;
		if (crcSpec && payloadEnd + trailerSize <= data.length) {
			instance.crc = evaluateCrc(data, crcSpec, fileRange, payloadRange, header);
			if (instance.crc.valid === false) {
				instance.status = "invalid";
				issues.push({
					severity: "error",
					code: "CRC_MISMATCH",
					blockId: logicalId,
					fileRange,
					message: `CRC mismatch (stored 0x${(instance.crc.stored ?? 0).toString(16)}, computed 0x${(instance.crc.computed ?? 0).toString(16)})`,
				});
			}
		}

		allInstances.push(instance);
		index++;

		// Guard against zero-progress loops on malformed profiles.
		if (totalSize <= 0) {
			issues.push({
				severity: "error",
				code: "ZERO_PROGRESS",
				fileRange,
				message: "Block total size resolved to 0; stopping to avoid an infinite loop",
			});
			break;
		}
		offset += totalSize;
	}

	// M0: no instance selection yet — every instance is its own logical block.
	const blocks: NvmBlock[] = allInstances.map(active => ({
		logicalId: active.logicalId,
		active,
		history: [],
	}));

	return {
		profileId: profile.id,
		sectors: [{ index: 0, fileRange: { start: 0, end: data.length } }],
		blocks,
		allInstances,
		issues,
	};
}
