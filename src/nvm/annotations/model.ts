// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * User annotation model for an NVM dump: bookmarks, tags and notes.
 *
 * Annotations are anchored to editor byte offsets (0 = image base) and are
 * persisted per-dump. The model is storage-agnostic: {@link AnnotationStore}
 * backends decide *where* it lives (a sidecar file or workspace state).
 */

/** Where an annotation points in the dump. */
export interface Anchor {
	/** Start editor byte offset (0 = image base). */
	offset: number;
	/** Exclusive end offset for a range; when omitted the anchor is one byte. */
	endOffset?: number;
	/** Optional id of the block/unit this anchors to (for stability + reports). */
	blockId?: string;
}

/** A quick-jump marker. */
export interface Bookmark {
	id: string;
	anchor: Anchor;
	label?: string;
	createdAt: number;
}

/** A user-defined classification label. */
export interface Tag {
	id: string;
	label: string;
	/** Any CSS color; used for the tag chip/badge. */
	color?: string;
}

/** An application of a {@link Tag} to a location. */
export interface TagAssignment {
	id: string;
	tagId: string;
	anchor: Anchor;
}

/** A rich note. The body is Markdown; sidecar storage keeps it in a `.md` file. */
export interface Note {
	id: string;
	anchor: Anchor;
	title?: string;
	/** Relative markdown file name (sidecar backend). */
	file?: string;
	/** Inline markdown body (workspace-state backend, or unsaved). */
	body?: string;
	createdAt: number;
	updatedAt: number;
}

/** The full annotation set for a single dump. */
export interface AnnotationSet {
	version: number;
	bookmarks: Bookmark[];
	tags: Tag[];
	tagAssignments: TagAssignment[];
	notes: Note[];
}

export const ANNOTATION_SET_VERSION = 1;

/** An empty annotation set. */
export function emptyAnnotationSet(): AnnotationSet {
	return {
		version: ANNOTATION_SET_VERSION,
		bookmarks: [],
		tags: [],
		tagAssignments: [],
		notes: [],
	};
}

/** Generate a short unique id. */
export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize a possibly-partial parsed object into a valid {@link AnnotationSet}. */
export function coerceAnnotationSet(value: unknown): AnnotationSet {
	const v = (value ?? {}) as Partial<AnnotationSet>;
	return {
		version: ANNOTATION_SET_VERSION,
		bookmarks: Array.isArray(v.bookmarks) ? v.bookmarks : [],
		tags: Array.isArray(v.tags) ? v.tags : [],
		tagAssignments: Array.isArray(v.tagAssignments) ? v.tagAssignments : [],
		notes: Array.isArray(v.notes) ? v.notes : [],
	};
}
