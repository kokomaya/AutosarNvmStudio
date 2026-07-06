// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-side annotation service: owns the annotation set per dump, applies
 * mutations from the webview/commands, persists via the configured
 * {@link AnnotationStore}, and projects a webview-friendly view.
 */

import * as vscode from "vscode";
import { NvmAnnotationCommand, NvmAnnotationsView } from "../../../shared/protocol";
import { Anchor, AnnotationSet, newId, Note } from "./model";
import { AnnotationStore } from "./store/annotationStore";
import { SidecarStore } from "./store/sidecarStore";
import { WorkspaceStateStore } from "./store/workspaceStateStore";

const NEW_NOTE_TEMPLATE = (title: string, start: number, end: number) =>
	`# ${title}\n\n> NVM note for bytes 0x${start.toString(16).toUpperCase()}–0x${end
		.toString(16)
		.toUpperCase()}\n\n_Write your notes here. You can add images and \`#tag\` references._\n`;

export class AnnotationService {
	private readonly store: AnnotationStore;
	private readonly cache = new Map<string, AnnotationSet>();

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	/** Fires when a dump's annotations change (for the sidebar to refresh). */
	public readonly onDidChange = this._onDidChange.event;

	constructor(context: vscode.ExtensionContext) {
		const mode = vscode.workspace
			.getConfiguration("hexeditor")
			.get<string>("nvm.annotationStorage", "sidecar");
		this.store = mode === "workspaceState" ? new WorkspaceStateStore(context) : new SidecarStore();
	}

	/** Get (loading + caching) the annotation set for a dump. */
	public async get(docUri: vscode.Uri): Promise<AnnotationSet> {
		const key = docUri.toString();
		const existing = this.cache.get(key);
		if (existing) {
			return existing;
		}
		const set = await this.store.load(docUri);
		this.cache.set(key, set);
		return set;
	}

	/** Apply a mutation, persist, and return the updated set. */
	public async apply(docUri: vscode.Uri, cmd: NvmAnnotationCommand): Promise<AnnotationSet> {
		const set = await this.get(docUri);
		switch (cmd.kind) {
			case "addBookmark":
				set.bookmarks.push({
					id: newId("bm"),
					anchor: { offset: cmd.offset },
					label: cmd.label,
					createdAt: Date.now(),
				});
				break;
			case "removeBookmark":
				set.bookmarks = set.bookmarks.filter(b => b.id !== cmd.id);
				break;
			case "createTag":
				if (!set.tags.some(t => t.label === cmd.label)) {
					set.tags.push({ id: newId("tag"), label: cmd.label, color: cmd.color });
				}
				break;
			case "renameTag": {
				const tag = set.tags.find(t => t.id === cmd.tagId);
				if (tag) {
					tag.label = cmd.label;
				}
				break;
			}
			case "recolorTag": {
				const tag = set.tags.find(t => t.id === cmd.tagId);
				if (tag) {
					tag.color = cmd.color;
				}
				break;
			}
			case "deleteTag":
				set.tags = set.tags.filter(t => t.id !== cmd.tagId);
				set.tagAssignments = set.tagAssignments.filter(a => a.tagId !== cmd.tagId);
				break;
			case "assignTag":
				set.tagAssignments.push({
					id: newId("ta"),
					tagId: cmd.tagId,
					anchor: this.range(cmd.start, cmd.end),
				});
				break;
			case "createAndAssignTag": {
				let tag = set.tags.find(t => t.label === cmd.label);
				if (!tag) {
					tag = { id: newId("tag"), label: cmd.label, color: cmd.color };
					set.tags.push(tag);
				}
				set.tagAssignments.push({
					id: newId("ta"),
					tagId: tag.id,
					anchor: this.range(cmd.start, cmd.end),
				});
				break;
			}
			case "unassignTag":
				set.tagAssignments = set.tagAssignments.filter(a => a.id !== cmd.assignmentId);
				break;
			case "addNote": {
				const note = this.newNote(cmd.start, cmd.end, cmd.title);
				// Use the caller-supplied body when present (e.g. an AI-authored note);
				// otherwise seed with the human template so the note opens ready to edit.
				const body = cmd.body ?? NEW_NOTE_TEMPLATE(note.title ?? "Note", cmd.start, cmd.end);
				const ref = await this.store.writeNote(docUri, note.id, body);
				note.file = ref.file;
				note.body = ref.body;
				set.notes.push(note);
				break;
			}
			case "deleteNote":
				set.notes = set.notes.filter(n => n.id !== cmd.id);
				break;
			case "openNote":
				// handled by the caller (needs UI); no model change.
				break;
		}
		await this.store.save(docUri, set);
		this._onDidChange.fire(docUri);
		return set;
	}

	/** Resolve a note to an editable document URI, when the backend has one. */
	public noteUri(docUri: vscode.Uri, noteId: string): vscode.Uri | undefined {
		return this.store.noteUri?.(docUri, noteId);
	}

	/** Read a note's markdown body. */
	public readNote(docUri: vscode.Uri, noteId: string): Promise<string> {
		const cached = this.cache.get(docUri.toString())?.notes.find(n => n.id === noteId)?.body;
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		return this.store.readNote(docUri, noteId);
	}

	/** Build the compact projection the webview renders. */
	public async toView(docUri: vscode.Uri): Promise<NvmAnnotationsView> {
		const set = await this.get(docUri);

		// Merge overlapping/identical tag ranges into one badge per byte span.
		const badgeMap = new Map<string, { start: number; end: number; tagIds: string[]; assignmentIds: string[] }>();
		for (const a of set.tagAssignments) {
			const start = a.anchor.offset;
			const end = a.anchor.endOffset ?? a.anchor.offset + 1;
			const key = `${start}:${end}`;
			const b = badgeMap.get(key) ?? { start, end, tagIds: [], assignmentIds: [] };
			b.tagIds.push(a.tagId);
			b.assignmentIds.push(a.id);
			badgeMap.set(key, b);
		}

		const notes = await Promise.all(
			set.notes.map(async n => ({
				id: n.id,
				start: n.anchor.offset,
				end: n.anchor.endOffset ?? n.anchor.offset + 1,
				title: n.title,
				body: await this.readNote(docUri, n.id),
			})),
		);

		return {
			tags: set.tags.map(t => ({ id: t.id, label: t.label, color: t.color })),
			badges: [...badgeMap.values()],
			assignments: set.tagAssignments.map(a => ({
				id: a.id,
				tagId: a.tagId,
				start: a.anchor.offset,
				end: a.anchor.endOffset ?? a.anchor.offset + 1,
			})),
			notes,
			bookmarks: set.bookmarks.map(b => ({
				id: b.id,
				offset: b.anchor.offset,
				label: b.label,
			})),
		};
	}

	/** Drop the cached set for a dump (e.g. after external edits). */
	public invalidate(docUri: vscode.Uri): void {
		this.cache.delete(docUri.toString());
	}

	private range(start: number, end: number): Anchor {
		return end > start + 1 ? { offset: start, endOffset: end } : { offset: start };
	}

	private newNote(start: number, end: number, title?: string): Note {
		const now = Date.now();
		return {
			id: newId("note"),
			anchor: this.range(start, end),
			title: title ?? `Note @0x${start.toString(16).toUpperCase()}`,
			createdAt: now,
			updatedAt: now,
		};
	}
}
