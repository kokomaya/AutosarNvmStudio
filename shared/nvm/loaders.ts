// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Loaders that turn address-based text container formats into a MemoryImage.
 *
 * Supported:
 * - Motorola S-record (.mot / .s19 / .s28 / .s37 / .srec)
 * - Intel HEX (.hex / .ihex)
 *
 * Both are auto-detected by `loadHexImage`. Records with checksums are
 * validated; a mismatch throws so corrupt dumps are surfaced early.
 */

import { MemoryImage, MemorySegment } from "./memoryImage";

function hexByte(text: string, index: number): number {
	return parseInt(text.substr(index, 2), 16);
}

/** Parse the hex payload (address + data + checksum area) into bytes. */
function parseHexBytes(line: string, start: number, count: number): number[] {
	const bytes: number[] = [];
	for (let i = 0; i < count; i++) {
		bytes.push(hexByte(line, start + i * 2));
	}
	return bytes;
}

/** Parse a Motorola S-record file into a MemoryImage. */
export function parseSRecord(text: string): MemoryImage {
	const segments: MemorySegment[] = [];
	const lines = text.split(/\r?\n/);
	// Address width in bytes for the data-record types S1/S2/S3.
	const addressWidth: Record<string, number> = { "1": 2, "2": 3, "3": 4 };

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo].trim();
		if (line.length === 0) {
			continue;
		}
		if (line[0] !== "S") {
			throw new Error(`Line ${lineNo + 1}: not an S-record (expected 'S')`);
		}
		const type = line[1];
		const count = hexByte(line, 2); // number of bytes that follow (addr + data + checksum)
		const payload = parseHexBytes(line, 4, count);

		// Validate the trailing checksum: ones' complement of the sum of
		// count + address + data bytes.
		const checksum = payload[payload.length - 1];
		let sum = count;
		for (let i = 0; i < payload.length - 1; i++) {
			sum += payload[i];
		}
		if (((~sum) & 0xff) !== checksum) {
			throw new Error(`Line ${lineNo + 1}: S-record checksum mismatch`);
		}

		const width = addressWidth[type];
		if (width === undefined) {
			// S0 (header), S5/S6 (record count), S7/S8/S9 (start address): ignore.
			continue;
		}
		let address = 0;
		for (let i = 0; i < width; i++) {
			address = address * 256 + payload[i];
		}
		const data = Uint8Array.from(payload.slice(width, payload.length - 1));
		if (data.length > 0) {
			segments.push({ address, data });
		}
	}

	return new MemoryImage(segments);
}

/** Parse an Intel HEX file into a MemoryImage. */
export function parseIntelHex(text: string): MemoryImage {
	const segments: MemorySegment[] = [];
	const lines = text.split(/\r?\n/);
	let upperBase = 0; // set by extended segment/linear address records

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo].trim();
		if (line.length === 0) {
			continue;
		}
		if (line[0] !== ":") {
			throw new Error(`Line ${lineNo + 1}: not an Intel HEX record (expected ':')`);
		}
		const count = hexByte(line, 1);
		const offset = (hexByte(line, 3) << 8) | hexByte(line, 5);
		const recordType = hexByte(line, 7);
		const data = parseHexBytes(line, 9, count);
		const checksum = hexByte(line, 9 + count * 2);

		let sum = count + (offset >> 8) + (offset & 0xff) + recordType;
		for (const b of data) {
			sum += b;
		}
		if (((~sum + 1) & 0xff) !== checksum) {
			throw new Error(`Line ${lineNo + 1}: Intel HEX checksum mismatch`);
		}

		switch (recordType) {
			case 0x00: // data
				segments.push({ address: upperBase + offset, data: Uint8Array.from(data) });
				break;
			case 0x02: // extended segment address (<<4)
				upperBase = ((data[0] << 8) | data[1]) << 4;
				break;
			case 0x04: // extended linear address (<<16)
				upperBase = ((data[0] << 8) | data[1]) * 0x10000;
				break;
			case 0x01: // EOF
				return new MemoryImage(segments);
			default: // 0x03 / 0x05 start address records: ignore
				break;
		}
	}

	return new MemoryImage(segments);
}

/** Auto-detect the container format and load it into a MemoryImage. */
export function loadHexImage(text: string): MemoryImage {
	const firstNonEmpty = text.split(/\r?\n/).find(l => l.trim().length > 0)?.trim() ?? "";
	if (firstNonEmpty[0] === "S") {
		return parseSRecord(text);
	}
	if (firstNonEmpty[0] === ":") {
		return parseIntelHex(text);
	}
	throw new Error("Unrecognized image format (expected Motorola S-record or Intel HEX)");
}
