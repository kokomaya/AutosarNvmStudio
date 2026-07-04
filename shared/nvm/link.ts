// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Config-driven in-file address links.
 *
 * A field can declare that its bytes hold an address that points *inside the
 * current file*. The adapter decodes those bytes, applies an optional safe
 * transform expression, range-checks the result and — when valid — exposes a
 * concrete editor byte offset the display can jump to. The display stays dumb:
 * it only ever sees a resolved `targetOffset`.
 *
 * The transform reuses the whitelist evaluator in {@link evaluateExpression}
 * (no `eval`). See docs/nvm-layout-providers.md and docs/design.md.
 */

import { evaluateExpression } from "./expr";

/** Byte encoding of the raw address stored in a link field. */
export type LinkEncoding = "u16le" | "u16be" | "u32le" | "u32be";

/** Per-field `link` specification, as written in a `*.nvmlayout.json`. */
export interface FieldLinkSpec {
	/** How to decode the address bytes. */
	encoding: LinkEncoding;
	/**
	 * Optional safe arithmetic expression mapping the decoded `value` to an
	 * editor byte offset. Scope vars: `value`, `imageBase`, `fileSize`, and
	 * vendor extras such as `chipBase`. When omitted, `value` is used verbatim.
	 */
	transform?: string;
	/** Optional label shown on the jump affordance. */
	label?: string;
}

/** A resolved, in-file editor offset the display can navigate to. */
export interface ResolvedFieldLink {
	/** Editor byte offset (0 = image base). Guaranteed in `[0, fileSize)`. */
	targetOffset: number;
	/** Optional human-readable label. */
	label?: string;
}

/** Numeric scope the transform expression is evaluated against. */
export interface LinkScope {
	/** Absolute base address that maps to editor offset 0. */
	imageBase: number;
	/** Total decoded image length in bytes (upper bound for the target). */
	fileSize: number;
	/** Vendor extras (e.g. Vector `chipBase`). */
	[key: string]: number;
}

/** Number of bytes an encoding consumes. */
export function linkEncodingLength(encoding: LinkEncoding): number {
	return encoding === "u16le" || encoding === "u16be" ? 2 : 4;
}

/**
 * Decode the raw address `value` from `bytes` starting at `offset`, per
 * `encoding`. Returns `undefined` when there are not enough bytes.
 */
export function decodeLinkValue(
	bytes: Uint8Array,
	offset: number,
	encoding: LinkEncoding,
): number | undefined {
	const len = linkEncodingLength(encoding);
	if (offset < 0 || offset + len > bytes.length) {
		return undefined;
	}
	switch (encoding) {
		case "u16le":
			return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
		case "u16be":
			return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
		case "u32le":
			return (
				(bytes[offset] |
					(bytes[offset + 1] << 8) |
					(bytes[offset + 2] << 16) |
					(bytes[offset + 3] << 24)) >>>
				0
			);
		case "u32be":
			return (
				((bytes[offset] << 24) |
					(bytes[offset + 1] << 16) |
					(bytes[offset + 2] << 8) |
					bytes[offset + 3]) >>>
				0
			);
		default:
			return undefined;
	}
}

/**
 * Resolve a field's `link` spec into a concrete in-file editor offset.
 *
 * @param bytes       The decoded flat image (editor byte 0 = image base).
 * @param fieldOffset Editor byte offset where the link field's bytes start.
 * @param spec        The field's `link` specification.
 * @param scope       Numeric scope for the transform (`imageBase`, `fileSize`, …).
 * @returns The resolved link, or `undefined` when it cannot be made a valid,
 *          in-file offset (silently — a link is simply not offered).
 */
export function resolveFieldLink(
	bytes: Uint8Array,
	fieldOffset: number,
	spec: FieldLinkSpec,
	scope: LinkScope,
): ResolvedFieldLink | undefined {
	const value = decodeLinkValue(bytes, fieldOffset, spec.encoding);
	if (value === undefined) {
		return undefined;
	}

	let targetOffset: number;
	if (spec.transform) {
		try {
			targetOffset = evaluateExpression(spec.transform, { value, ...scope });
		} catch {
			return undefined;
		}
	} else {
		targetOffset = value;
	}

	targetOffset = Math.trunc(targetOffset);
	if (!Number.isFinite(targetOffset) || targetOffset < 0 || targetOffset >= scope.fileSize) {
		return undefined;
	}
	return { targetOffset, label: spec.label };
}
