// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A sparse memory image reconstructed from an address-based container format
 * (Motorola S-record, Intel HEX, ...). NVM dumps such as `NVM 1.mot` are not
 * raw binaries: they carry an absolute base address (e.g. 0x3A0000) and may
 * have gaps. The parse engine and struct decoder operate on the flattened
 * bytes, using `baseAddress` to translate absolute block addresses.
 *
 * See docs/design.md §6 (loaders sit in front of the L1 container layer).
 */

export interface MemorySegment {
	/** Absolute start address of this segment. */
	address: number;
	data: Uint8Array;
}

export class MemoryImage {
	/** Segments sorted by ascending address, merged where contiguous. */
	public readonly segments: MemorySegment[];
	/** Lowest absolute address present in the image. */
	public readonly baseAddress: number;
	/** One past the highest absolute address present in the image. */
	public readonly endAddress: number;

	constructor(segments: MemorySegment[]) {
		this.segments = MemoryImage.normalize(segments);
		if (this.segments.length === 0) {
			this.baseAddress = 0;
			this.endAddress = 0;
		} else {
			this.baseAddress = this.segments[0].address;
			const last = this.segments[this.segments.length - 1];
			this.endAddress = last.address + last.data.length;
		}
	}

	/** Total span from base to end (including any gaps). */
	public get span(): number {
		return this.endAddress - this.baseAddress;
	}

	/** Whether the whole [base, end) range is covered by a single segment. */
	public get isContiguous(): boolean {
		return this.segments.length === 1;
	}

	/**
	 * Flatten the image into a single buffer spanning [base, end). Gaps are
	 * filled with `fill` (default 0xFF, the typical erased-flash value).
	 */
	public toFlat(fill = 0xff): { baseAddress: number; bytes: Uint8Array } {
		const bytes = new Uint8Array(this.span);
		bytes.fill(fill);
		for (const seg of this.segments) {
			bytes.set(seg.data, seg.address - this.baseAddress);
		}
		return { baseAddress: this.baseAddress, bytes };
	}

	/**
	 * Read `length` bytes starting at an absolute address. Returns undefined
	 * if the requested range is not fully covered by a segment.
	 */
	public read(address: number, length: number): Uint8Array | undefined {
		for (const seg of this.segments) {
			if (address >= seg.address && address + length <= seg.address + seg.data.length) {
				const start = address - seg.address;
				return seg.data.subarray(start, start + length);
			}
		}
		return undefined;
	}

	/** Merge overlapping/adjacent segments and sort by address. */
	private static normalize(input: MemorySegment[]): MemorySegment[] {
		const sorted = [...input]
			.filter(s => s.data.length > 0)
			.sort((a, b) => a.address - b.address);
		const merged: MemorySegment[] = [];
		for (const seg of sorted) {
			const last = merged[merged.length - 1];
			if (last && seg.address <= last.address + last.data.length) {
				// Overlap or adjacency: extend the previous segment.
				const end = Math.max(last.address + last.data.length, seg.address + seg.data.length);
				const combined = new Uint8Array(end - last.address);
				combined.set(last.data, 0);
				combined.set(seg.data, seg.address - last.address);
				merged[merged.length - 1] = { address: last.address, data: combined };
			} else {
				merged.push({ address: seg.address, data: seg.data });
			}
		}
		return merged;
	}
}
