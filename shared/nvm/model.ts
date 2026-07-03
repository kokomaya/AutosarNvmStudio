// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Runtime model produced by the NVM parse engine. This is the single source
 * of truth consumed by the webview (coloring / tree / inspector), the
 * Language Model tools, the MCP server and the CLI.
 *
 * See docs/design.md §5 for the conceptual overview.
 */

export type Endianness = "little" | "big";

export interface ByteRange {
	/** Inclusive start byte offset in the image. */
	start: number;
	/** Exclusive end byte offset in the image. */
	end: number;
}

export type BlockStatus = "valid" | "invalid" | "empty" | "encrypted";

export interface CrcResult {
	/** CRC value stored in the image (if the profile knows where to read it). */
	stored?: number;
	/** CRC value computed by the engine over the configured range. */
	computed?: number;
	/** Whether stored === computed. Undefined when no CRC was configured. */
	valid?: boolean;
}

export interface DecodedField {
	/** Dotted path such as `Header.Temperature`. */
	path: string;
	/** [start, end) offset of the raw bytes relative to the payload start. */
	rawBytes: [number, number];
	raw: number | bigint | string;
	value: number | string | boolean;
	unit?: string;
	enumLabel?: string;
}

export interface NvmBlockInstance {
	logicalId: number | string;
	/** Byte range of the whole block (header + payload + trailer) in the image. */
	fileRange: ByteRange;
	/** Parsed header fields keyed by field name (post-transform values). */
	header: Record<string, number>;
	/** Byte range of the payload portion in the image. */
	payloadRange: ByteRange;
	crc: CrcResult;
	crypto?: { algo: string; decrypted: boolean };
	/** Version / write counter / erase counter, when the profile exposes one. */
	version?: number;
	datasetIndex?: number;
	status: BlockStatus;
	/** Physical values decoded from the payload (L5). Empty in M0. */
	decoded?: DecodedField[];
}

export interface NvmBlock {
	logicalId: number | string;
	/** Business name resolved from ARXML / CSV mapping, when available. */
	name?: string;
	/** The instance selected as the current valid one. */
	active: NvmBlockInstance;
	/** Other (historical / superseded) instances of the same logical block. */
	history: NvmBlockInstance[];
}

export type IssueSeverity = "error" | "warning" | "info";

export interface NvmIssue {
	severity: IssueSeverity;
	/** Machine-readable code, e.g. `CRC_MISMATCH`, `OUT_OF_BOUNDS`. */
	code: string;
	blockId?: number | string;
	fileRange?: ByteRange;
	message: string;
}

export interface NvmSector {
	index: number;
	fileRange: ByteRange;
	/** Free-form metadata extracted by the container layer (L1). */
	meta?: Record<string, number | string | boolean>;
}

export interface NvmModel {
	profileId: string;
	sectors: NvmSector[];
	blocks: NvmBlock[];
	allInstances: NvmBlockInstance[];
	issues: NvmIssue[];
}
