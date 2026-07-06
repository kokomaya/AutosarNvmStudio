// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `NvmCapabilities` — the single, vendor-blind capability facade the AI surface
 * (Language Model Tools + the `@nvm` chat participant) consumes. It is the ONE
 * place that:
 *
 * - reads NVM data through the two host services ({@link HexEditorRegistry} for
 *   blocks/active-document, {@link AnnotationService} for bookmarks/tags/notes),
 * - **bounds every read** (paging + hard caps + truncation) so a single tool call
 *   can never dump a huge dump into the model's context, and
 * - enforces the write guardrails for AI-authored notes.
 *
 * SOLID intent:
 * - **SRP**: this class fetches + caps structured data; it does NOT render text
 *   (the tool layer formats) and does NOT own persistence (the services do).
 * - **DIP**: tools/chat depend on this facade, not on the registry/annotations.
 * - **OCP**: a new capability = a new method here + a thin tool registration.
 *
 * Vendor/user-free: every method returns only generic block geometry, the
 * generic decoded tree, raw bytes, and the user's own annotations. It NEVER
 * interprets what a block *means* — names come from symbol adapters and meaning
 * from user notes, both of which live outside this facade.
 */

import * as vscode from "vscode";
import { NvmBlockInfo } from "../../../shared/protocol";
import { NvmDecodedNode } from "../../../shared/nvm/structRich";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { HexDocument } from "../../hexDocument";
import { AnnotationService } from "../annotations/annotationService";
import { buildActiveReport } from "../report/reportCommands";

// --- read limits (the single source of truth for how much data leaves the host) ---

/** Default page size for block listings when the caller omits `limit`. */
const DEFAULT_PAGE = 100;
/** Hard cap on any block page — the model can page for more via `offset`. */
const MAX_PAGE = 500;
/** Max fields returned for a single block's detail. */
const MAX_FIELDS = 200;
/** Max characters of a block's `raw` JSON echoed back (it can be arbitrarily large). */
const MAX_RAW_CHARS = 2000;
/** Decoded-tree summary defaults. */
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_NODES = 300;
/** Hard cap on a single `readBytes` window (bytes). */
const MAX_READ_BYTES = 4096;
/** Caps on annotation listings. */
const MAX_ANNOTATIONS = 200;
/** Max characters of the exported report returned in one call. */
const MAX_REPORT_CHARS = 40000;

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;

/** A bounded, self-describing page so the model knows whether to fetch more. */
export interface Page<T> {
	items: T[];
	/** Total matches before paging. */
	total: number;
	/** How many items this page returned. */
	returned: number;
	/** The offset this page started at. */
	offset: number;
	/** Whether more items exist beyond this page. */
	hasMore: boolean;
}

export interface BlockSummary {
	id: string;
	name?: string;
	offset: number;
	length: number;
	fieldCount: number;
	hasDecoded: boolean;
}

export interface FieldSummary {
	name: string;
	kind: string;
	offset: number;
	length: number;
	linkTarget?: number;
}

export interface BlockDetail {
	id: string;
	name?: string;
	offset: number;
	length: number;
	fields: FieldSummary[];
	fieldsTruncated: boolean;
	/** Truncated JSON of the block's raw metadata (may be omitted/clipped). */
	raw?: string;
	rawTruncated: boolean;
}

/** A depth/leaf-capped projection of a block's decoded tree. */
export interface DecodedSummaryNode {
	name: string;
	type: string;
	offset: number;
	length: number;
	value?: number | string | boolean;
	unit?: string;
	enumLabel?: string;
	children?: DecodedSummaryNode[];
}

export interface DecodedSummary {
	block: string;
	nodes: DecodedSummaryNode[];
	truncated: boolean;
}

export interface BytesWindow {
	offset: number;
	length: number;
	hex: string;
}

export interface AnnotationsSummary {
	bookmarks: { offset: number; label?: string }[];
	tags: { label: string; assignments: number }[];
	notes: { id: string; offset: number; end: number; title?: string }[];
	truncated: boolean;
}

export interface CreateNoteInput {
	/** Anchor to a named block's byte range (preferred), or use start/end. */
	blockName?: string;
	start?: number;
	end?: number;
	title: string;
	body: string;
}

export interface CreateNoteResult {
	created: boolean;
	noteId?: string;
	/** When not created: why (e.g. the user declined the confirmation). */
	reason?: string;
}

/** A validated, anchored note ready to write — the output of {@link NvmCapabilities.validateNoteInput}. */
export interface ResolvedNoteInput {
	start: number;
	end: number;
	title: string;
	body: string;
}

/**
 * Raised for invalid capability input (bad range, missing anchor, empty note).
 * Tools catch it and surface `message` to the model as a normal tool result.
 */
export class NvmCapabilityError extends Error {}

export class NvmCapabilities {
	constructor(
		private readonly registry: HexEditorRegistry,
		private readonly annotations: AnnotationService,
	) {}

	/** The active dump document, or throw a friendly error. */
	private activeDoc(): HexDocument {
		const doc = this.registry.activeDocument;
		if (!doc) {
			throw new NvmCapabilityError("No active NVM dump. Open a dump in the hex editor first.");
		}
		return doc;
	}

	private activeBlocks(): NvmBlockInfo[] {
		return this.registry.getNvmBlocks(this.activeDoc()) as NvmBlockInfo[];
	}

	private summary(b: NvmBlockInfo): BlockSummary {
		return {
			id: b.id,
			name: b.name,
			offset: b.offset,
			length: b.length,
			fieldCount: b.fields?.length ?? 0,
			hasDecoded: !!b.decoded?.length,
		};
	}

	private page<T>(all: T[], offset = 0, limit = DEFAULT_PAGE): Page<T> {
		const start = Math.max(0, Math.floor(offset));
		const size = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE);
		const items = all.slice(start, start + size);
		return {
			items,
			total: all.length,
			returned: items.length,
			offset: start,
			hasMore: start + items.length < all.length,
		};
	}

	/** List the active dump's blocks (paged). */
	public listBlocks(opts?: { limit?: number; offset?: number }): Page<BlockSummary> {
		const blocks = this.activeBlocks();
		return this.page(blocks.map(b => this.summary(b)), opts?.offset, opts?.limit);
	}

	/** Search blocks by case-insensitive substring of name/id, or a hex/decimal offset (paged). */
	public searchBlocks(query: string, opts?: { limit?: number; offset?: number }): Page<BlockSummary> {
		const blocks = this.activeBlocks();
		const q = (query ?? "").trim().toLowerCase();
		if (!q) {
			return this.page(blocks.map(b => this.summary(b)), opts?.offset, opts?.limit);
		}
		// Allow matching by an offset the user typed (0x.. or decimal).
		const asNum = q.startsWith("0x") ? parseInt(q, 16) : /^\d+$/.test(q) ? parseInt(q, 10) : NaN;
		const matched = blocks.filter(b => {
			const name = (b.name ?? b.id).toLowerCase();
			if (name.includes(q) || b.id.toLowerCase().includes(q)) {
				return true;
			}
			return !Number.isNaN(asNum) && asNum >= b.offset && asNum < b.offset + b.length;
		});
		return this.page(matched.map(b => this.summary(b)), opts?.offset, opts?.limit);
	}

	private findBlock(name: string): NvmBlockInfo | undefined {
		const blocks = this.activeBlocks();
		const q = (name ?? "").toLowerCase();
		return (
			blocks.find(b => (b.name ?? b.id).toLowerCase() === q) ??
			blocks.find(b => (b.name ?? b.id).toLowerCase().includes(q))
		);
	}

	/** Fields + capped metadata of a single block (matched by name). */
	public analyzeBlock(name: string): BlockDetail {
		const block = this.findBlock(name);
		if (!block) {
			throw new NvmCapabilityError(`No block matching "${name}".`);
		}
		const allFields = block.fields ?? [];
		const fields: FieldSummary[] = allFields.slice(0, MAX_FIELDS).map(f => ({
			name: f.name,
			kind: f.kind,
			offset: f.offset,
			length: f.length,
			linkTarget: f.link?.targetOffset,
		}));
		let raw: string | undefined;
		let rawTruncated = false;
		if (block.raw !== undefined) {
			const json = safeStringify(block.raw);
			raw = json.length > MAX_RAW_CHARS ? json.slice(0, MAX_RAW_CHARS) : json;
			rawTruncated = json.length > MAX_RAW_CHARS;
		}
		return {
			id: block.id,
			name: block.name,
			offset: block.offset,
			length: block.length,
			fields,
			fieldsTruncated: allFields.length > MAX_FIELDS,
			raw,
			rawTruncated,
		};
	}

	/** A depth/leaf-capped projection of a block's decoded value tree. */
	public getDecoded(name: string, opts?: { maxDepth?: number; maxNodes?: number }): DecodedSummary {
		const block = this.findBlock(name);
		if (!block) {
			throw new NvmCapabilityError(`No block matching "${name}".`);
		}
		if (!block.decoded?.length) {
			return { block: block.name ?? block.id, nodes: [], truncated: false };
		}
		const maxDepth = clamp(opts?.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 12);
		const maxNodes = clamp(opts?.maxNodes ?? DEFAULT_MAX_NODES, 1, 5000);
		let budget = maxNodes;
		let truncated = false;
		const walk = (nodes: readonly NvmDecodedNode[], depth: number): DecodedSummaryNode[] => {
			const out: DecodedSummaryNode[] = [];
			for (const n of nodes) {
				if (budget <= 0) {
					truncated = true;
					break;
				}
				budget--;
				const node: DecodedSummaryNode = {
					name: n.name,
					type: n.type,
					offset: n.offset,
					length: n.length,
					value: n.value,
					unit: n.unit,
					enumLabel: n.enumLabel,
				};
				if (n.children?.length) {
					if (depth + 1 < maxDepth) {
						node.children = walk(n.children, depth + 1);
					} else {
						truncated = true;
					}
				}
				out.push(node);
			}
			return out;
		};
		return { block: block.name ?? block.id, nodes: walk(block.decoded, 0), truncated };
	}

	/** Read a bounded byte window (≤ {@link MAX_READ_BYTES}) as hex. */
	public async readBytes(offset: number, length: number): Promise<BytesWindow> {
		const doc = this.activeDoc();
		if (!Number.isFinite(offset) || offset < 0) {
			throw new NvmCapabilityError("readBytes: offset must be a non-negative number.");
		}
		if (!Number.isFinite(length) || length <= 0) {
			throw new NvmCapabilityError("readBytes: length must be a positive number.");
		}
		const len = Math.min(Math.floor(length), MAX_READ_BYTES);
		const buf = await doc.readBufferWithEdits(Math.floor(offset), len);
		const hexStr = Array.from(buf, b => b.toString(16).padStart(2, "0")).join(" ");
		return { offset: Math.floor(offset), length: buf.length, hex: hexStr };
	}

	/** The user's bookmarks/tags/notes for the active dump (capped; note bodies omitted). */
	public async listAnnotations(): Promise<AnnotationsSummary> {
		const doc = this.activeDoc();
		const set = await this.annotations.get(doc.uri);
		const cap = <T>(a: T[]) => a.slice(0, MAX_ANNOTATIONS);
		const truncated =
			set.bookmarks.length > MAX_ANNOTATIONS ||
			set.tags.length > MAX_ANNOTATIONS ||
			set.notes.length > MAX_ANNOTATIONS;
		return {
			bookmarks: cap(set.bookmarks).map(b => ({ offset: b.anchor.offset, label: b.label })),
			tags: cap(set.tags).map(t => ({
				label: t.label,
				assignments: set.tagAssignments.filter(a => a.tagId === t.id).length,
			})),
			notes: cap(set.notes).map(n => ({
				id: n.id,
				offset: n.anchor.offset,
				end: n.anchor.endOffset ?? n.anchor.offset + 1,
				title: n.title,
			})),
			truncated,
		};
	}

	/**
	 * Validate + resolve a note request WITHOUT writing or prompting. Enforces the
	 * two data guardrails so both `prepareInvocation` (for the confirmation UI) and
	 * `createNote` share one source of truth (SRP):
	 * 1. it MUST be anchored (a named block, or an explicit start/end range),
	 * 2. it MUST have a non-empty title AND body.
	 * Throws {@link NvmCapabilityError} on violation. The THIRD guardrail — user
	 * confirmation — is the host's job (the LM Tool's native `prepareInvocation`
	 * confirmation, not a modal here), so the facade never blocks on UI.
	 */
	public validateNoteInput(input: CreateNoteInput): ResolvedNoteInput {
		const title = (input.title ?? "").trim();
		const body = (input.body ?? "").trim();
		if (!title || !body) {
			throw new NvmCapabilityError(
				"createNote requires a non-empty title and body — placeholder notes are rejected.",
			);
		}
		let start: number;
		let end: number;
		if (input.blockName) {
			const block = this.findBlock(input.blockName);
			if (!block) {
				throw new NvmCapabilityError(`createNote: no block matching "${input.blockName}".`);
			}
			start = block.offset;
			end = block.offset + block.length;
		} else if (Number.isFinite(input.start)) {
			start = Math.floor(input.start as number);
			end = Number.isFinite(input.end) ? Math.floor(input.end as number) : start + 1;
		} else {
			throw new NvmCapabilityError(
				"createNote must be anchored: pass a blockName or a start (and optional end) byte offset.",
			);
		}
		if (end <= start) {
			end = start + 1;
		}
		return { start, end, title, body };
	}

	/**
	 * Create a note on the active dump — the ONE AI write path. Confirmation is
	 * handled by the caller (the LM Tool's native `prepareInvocation` UI), so this
	 * only validates + writes. On a host that CANNOT show a tool confirmation, the
	 * caller passes `confirmFallback` — a modal shown here as a last-resort guard so
	 * an AI note is never written completely unconfirmed.
	 */
	public async createNote(
		input: CreateNoteInput,
		confirmFallback = false,
	): Promise<CreateNoteResult> {
		const doc = this.activeDoc();
		const { start, end, title, body } = this.validateNoteInput(input);

		if (confirmFallback) {
			const ok = await vscode.window.showWarningMessage(
				vscode.l10n.t(
					'Copilot wants to create the note “{0}” on bytes {1}–{2}. Create it?',
					title,
					hex(start),
					hex(end),
				),
				{ modal: true },
				vscode.l10n.t("Create note"),
			);
			if (!ok) {
				return { created: false, reason: "The user declined to create the note." };
			}
		}

		const before = (await this.annotations.get(doc.uri)).notes.length;
		const set = await this.annotations.apply(doc.uri, {
			kind: "addNote",
			start,
			end,
			title,
			body: `# ${title}\n\n> Anchored to bytes ${hex(start)}–${hex(end)}\n\n${body}\n`,
		});
		const created = set.notes.length > before ? set.notes[set.notes.length - 1] : undefined;
		return { created: true, noteId: created?.id };
	}

	/** The full analysis report (truncated if very long). */
	public async exportReport(): Promise<{ markdown: string; truncated: boolean }> {
		const report = await buildActiveReport(this.registry, this.annotations);
		if (!report) {
			throw new NvmCapabilityError("No active NVM dump to report on.");
		}
		const md = report.markdown;
		return md.length > MAX_REPORT_CHARS
			? { markdown: md.slice(0, MAX_REPORT_CHARS), truncated: true }
			: { markdown: md, truncated: false };
	}

	/** Heuristic risk checks over the active dump's blocks. */
	public riskDetection(): { risks: string[] } {
		const blocks = this.activeBlocks();
		if (!blocks.length) {
			return { risks: [] };
		}
		const risks: string[] = [];
		const unresolved = blocks.filter(b => /^Tag \d+$/.test(b.name ?? ""));
		if (unresolved.length) {
			risks.push(
				`${unresolved.length} block(s) have unresolved names ("Tag N") — the engine's config source (e.g. the generated block table) may be missing.`,
			);
		}
		const empty = blocks.filter(b => !b.fields?.length && b.length === 0);
		if (empty.length) {
			risks.push(`${empty.length} zero-length block(s).`);
		}
		const overlap = findOverlap(blocks);
		if (overlap !== undefined) {
			risks.push(`Overlapping blocks detected near ${hex(overlap)}.`);
		}
		return { risks };
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** JSON.stringify that survives bigint and cyclic-ish values. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
	} catch {
		return String(value);
	}
}

function findOverlap(blocks: NvmBlockInfo[]): number | undefined {
	const sorted = [...blocks].sort((a, b) => a.offset - b.offset);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].length) {
			return sorted[i].offset;
		}
	}
	return undefined;
}
