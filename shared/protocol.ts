/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { HexDecorator } from "./decorators";
import { HexDocumentEditOp } from "./hexDocumentModel";
import { NvmDecodedNode } from "./nvm/structRich";
import { ISerializedEdits } from "./serialization";

export const enum MessageType {
	//#region to webview
	ReadyResponse,
	ReadRangeResponse,
	SearchProgress,
	SetEdits,
	SetEditMode,
	Saved,
	ReloadFromDisk,
	SetNvmBlocks,
	StashDisplayedOffset,
	GoToOffset,
	RevealNvmOffset,
	SetHoveredByte,
	SetFocusedByte,
	SetFocusedByteRange,
	SetSelectedCount,
	PopDisplayedOffset,
	DeleteAccepted,
	TriggerCopyAs,
	SetNvmAnnotations,
	SetNvmCustomViews,
	//#endregion
	//#region from webview
	ReadyRequest,
	OpenDocument,
	ReadRangeRequest,
	MakeEdits,
	RequestDeletes,
	SearchRequest,
	CancelSearch,
	ClearDataInspector,
	SetInspectByte,
	UpdateEditorSettings,
	DoPaste,
	DoCopy,
	NvmAnnotationCommand,
	NvmCustomViewCommand,
	//#endregion
}

export interface WebviewMessage<T> {
	messageId: number;
	inReplyTo?: number;
	body: T;
}

export const enum Endianness {
	Big = "big",
	Little = "little",
}

export const enum InspectorLocation {
	Hover = "hover",
	Aside = "aside",
	Sidebar = "sidebar",
}

export interface IEditorSettings {
	copyType: CopyFormat;
	showDecodedText: boolean;
	columnWidth: number;
	inspectorType: InspectorLocation;
	defaultEndianness: Endianness;
}

export interface ICodeSettings {
	scrollBeyondLastLine: boolean;
}

export interface ReadyResponseMessage {
	type: MessageType.ReadyResponse;
	initialOffset: number;
	pageSize: number;
	edits: ISerializedEdits;
	editorSettings: IEditorSettings;
	codeSettings: ICodeSettings;
	unsavedEditIndex: number;
	fileSize: number | undefined;
	isReadonly: boolean;
	isLargeFile: boolean;
	editMode: HexDocumentEditOp.Insert | HexDocumentEditOp.Replace;
	decorators: HexDecorator[];
}

/**
 * Sent from the extension to the webview to provide parsed NVM blocks and
 * associated metadata for rendering and inspection.
 */
/** A colored sub-range (attribute) within an NVM block. */
export interface NvmFieldInfo {
	name: string;
	/** Semantic kind used to pick a color (header, marker, payload, crc, padding, ...). */
	kind: string;
	/** Byte offset of the field in the editor's byte space. */
	offset: number;
	length: number;
	/**
	 * Resolved background color (any CSS color) for this field. Config-driven:
	 * comes from the field's own `color` or the descriptor `palette[kind]`. When
	 * absent the webview falls back to a deterministic auto color.
	 */
	color?: string;
	/**
	 * Identifier of the "unit" this field belongs to (a data block, the sector
	 * header, or a single sector-table slot). Clicking any byte highlights all
	 * fields sharing this unit; when omitted the owning block id is used.
	 */
	unit?: string;
	/**
	 * When set, this field holds an address that points *inside the current
	 * file*: the adapter has decoded and range-checked it into a concrete editor
	 * byte offset. The display offers a jump affordance and navigates there.
	 */
	link?: { targetOffset: number; label?: string };
}

/**
 * A vendor-neutral display attribute for a block (one "column" in the Blocks
 * views). Engines/adapters emit these; the plugin renders them generically and
 * never interprets vendor-specific keys.
 */
export interface NvmAttribute {
	/** Stable, discoverable key (used for column selection), e.g. "sector". */
	key: string;
	/** Human-readable column label, e.g. "Sector". */
	label: string;
	value: string | number | boolean;
	/** Optional semantic hint for icon/formatting; purely presentational. */
	kind?: string;
}

/** A vendor-neutral grouping bucket a block belongs to (e.g. a sector). */
export interface NvmGroupRef {
	/** Stable group key, e.g. "sector0". */
	key: string;
	/** Display label, e.g. "Sector 0". */
	label: string;
	/** Optional sort order among groups (ascending). */
	order?: number;
}

/**
 * The logical identity a block shares with its other versions/copies. Used by
 * the "group by block id" arrangement to gather instances of the same block.
 */
export interface NvmIdentityRef {
	/** Stable identity key shared by all instances, e.g. "tag:0x0031". */
	key: string;
	/** Display label for the identity, e.g. the block name. */
	label: string;
}

export interface NvmBlockInfo {
	id: string;
	name?: string;
	offset: number;
	length: number;
	raw?: any;
	/** Sub-ranges (attributes) that should be colored individually. */
	fields?: NvmFieldInfo[];
	/**
	 * The following fields are all OPTIONAL and vendor-neutral. Engines populate
	 * them from their own (vendor-specific) metadata; the plugin's Blocks views
	 * consume only these generic shapes and never read `raw`.
	 */
	/** Grouping bucket for the "group by sector" arrangement. */
	group?: NvmGroupRef;
	/**
	 * Best-effort write-order hint (higher = written later). May be undefined
	 * when the order is not derivable; such blocks are shown as "unknown order".
	 */
	sequence?: number;
	/** Logical identity shared with this block's other versions/copies. */
	identity?: NvmIdentityRef;
	/** True when this is the newest instance of its {@link identity}. */
	isLatest?: boolean;
	/** Vendor-neutral display attributes (the configurable columns). */
	attributes?: NvmAttribute[];
	/**
	 * Business-decoded value tree for this block, produced by the engine from a
	 * struct definition it resolved (from C source / ARXML / JSON). Node offsets
	 * are absolute editor byte offsets. The plugin renders this generically and
	 * never interprets vendor semantics — it only appears on blocks the engine
	 * chose to bind to a struct, so most blocks omit it.
	 */
	decoded?: NvmDecodedNode[];
}

export interface SetNvmBlocksMessage {
	type: MessageType.SetNvmBlocks;
	blocks: NvmBlockInfo[];
}

// --- NVM annotations (bookmarks / tags / notes) ---

/** A user tag definition. */
export interface NvmTagView {
	id: string;
	label: string;
	color?: string;
}

/** A byte range that carries one or more tags (for the corner badge). */
export interface NvmTagBadge {
	start: number;
	end: number;
	tagIds: string[];
	/** The tag-assignment ids covering this range (for removal). */
	assignmentIds: string[];
}

/** A single tag application (assignment-level, for precise add/remove UI). */
export interface NvmTagAssignmentView {
	id: string;
	tagId: string;
	start: number;
	end: number;
}

/** A note projected for the webview (hover + panel). */
export interface NvmNoteView {
	id: string;
	start: number;
	end: number;
	title?: string;
	/** Markdown body, included so hovers/panels can render without a round-trip. */
	body?: string;
}

/** A bookmark projected for the webview. */
export interface NvmBookmarkView {
	id: string;
	offset: number;
	label?: string;
}

/** The full annotation projection pushed to the webview. */
export interface NvmAnnotationsView {
	tags: NvmTagView[];
	badges: NvmTagBadge[];
	assignments: NvmTagAssignmentView[];
	notes: NvmNoteView[];
	bookmarks: NvmBookmarkView[];
}

export interface SetNvmAnnotationsMessage {
	type: MessageType.SetNvmAnnotations;
	annotations: NvmAnnotationsView;
}

/** A mutation the webview asks the host to perform on annotations. */
export type NvmAnnotationCommand =
	| { kind: "addBookmark"; offset: number; label?: string; prompt?: boolean }
	| { kind: "removeBookmark"; id: string }
	| { kind: "renameBookmark"; id: string; label?: string }
	| { kind: "createTag"; label: string; color?: string }
	| { kind: "renameTag"; tagId: string; label: string }
	| { kind: "recolorTag"; tagId: string; color: string }
	| { kind: "deleteTag"; tagId: string }
	| { kind: "assignTag"; tagId: string; start: number; end: number }
	| { kind: "createAndAssignTag"; label: string; color?: string; start: number; end: number }
	| { kind: "unassignTag"; assignmentId: string }
	| { kind: "addNote"; start: number; end: number; title?: string; body?: string }
	| { kind: "openNote"; id: string }
	| { kind: "deleteNote"; id: string };

export interface NvmAnnotationCommandMessage {
	type: MessageType.NvmAnnotationCommand;
	command: NvmAnnotationCommand;
}

// --- NVM custom views (user-composable) ---

/** A lightweight descriptor of a custom view, pushed to the editor webview so
 * the decoded-tree "+" menu can list existing views to add a field to. */
export interface NvmCustomViewRef {
	id: string;
	name: string;
}

export interface SetNvmCustomViewsMessage {
	type: MessageType.SetNvmCustomViews;
	views: NvmCustomViewRef[];
}

/**
 * A mutation the webview asks the host to perform on custom views. `addBlock`
 * carries a `viewId` of the target view, or the `__new__` sentinel to prompt
 * for a new view name host-side (mirrors the tag `__prompt__` pattern). The
 * block is referenced by its generic `id`; the host looks it up, computes a
 * structural fingerprint, and adds a group so all structurally-matching blocks
 * join at once.
 */
export type NvmCustomViewCommand =
	| {
			kind: "addBlock";
			/** Target view id, or "__new__" to create a new view first (host prompts). */
			viewId: string;
			/** The block's generic id (host resolves it to compute the group selector). */
			blockId: string;
			/** How structurally-matching blocks are grouped (default: fingerprint). */
			by?: "fingerprint" | "identity" | "id";
			/** When set, merge into this existing group (user-curated union) instead
			 * of adding a new group. Omit to add a new group (host may still prompt). */
			groupKey?: string;
	  }
	| { kind: "createView"; name: string }
	| { kind: "renameView"; viewId: string }
	| { kind: "deleteView"; viewId: string }
	| { kind: "deleteGroup"; viewId: string; groupKey: string }
	| { kind: "promoteToTemplate"; viewId: string };

export interface NvmCustomViewCommandMessage {
	type: MessageType.NvmCustomViewCommand;
	command: NvmCustomViewCommand;
}

export interface SetEditModeMessage {
	type: MessageType.SetEditMode;
	mode: HexDocumentEditOp.Insert | HexDocumentEditOp.Replace;
}

export interface ReadRangeResponseMessage {
	type: MessageType.ReadRangeResponse;
	data: ArrayBuffer;
}

export interface SearchResult {
	from: number;
	to: number;
	previous: Uint8Array;
}

export interface SearchResultsWithProgress {
	results: SearchResult[];
	progress: number;
	capped?: boolean;
	outdated?: boolean;
}

export interface SearchProgressMessage {
	type: MessageType.SearchProgress;
	data: SearchResultsWithProgress;
}

/** Notifies the document is saved, any pending edits should be flushed */
export interface SavedMessage {
	type: MessageType.Saved;
	unsavedEditIndex: number;
}

/** Notifies that the underlying file is changed. Webview should throw away and re-request state. */
export interface ReloadMessage {
	type: MessageType.ReloadFromDisk;
}

/** Sets the edits that should be applied to the document */
export interface SetEditsMessage {
	type: MessageType.SetEdits;
	edits: ISerializedEdits;
	replaceFileSize?: number | null;
	appendOnly?: boolean;
}

/** Sets the displayed offset. */
export interface GoToOffsetMessage {
	type: MessageType.GoToOffset;
	offset: number;
}

/**
 * NVM panel jump: unlike {@link GoToOffsetMessage} (scroll only), this replicates
 * a real byte click — it scrolls to, focuses, selects and briefly flashes the
 * byte, and selects its owning NVM block so the data inspector decodes it. Sent
 * by the Custom View / Blocks Table / NVM Studio tree jump affordances.
 */
export interface RevealNvmOffsetMessage {
	type: MessageType.RevealNvmOffset;
	offset: number;
}

/** Focuses a byte in the editor. */
export interface SetFocusedByteMessage {
	type: MessageType.SetFocusedByte;
	offset: number;
}

/** Focuses a byte range in the editor. */
export interface SetFocusedByteRangeMessage {
	type: MessageType.SetFocusedByteRange;
	startingOffset: number;
	endingOffset: number;
}

/** sets the count of selected bytes. */
export interface SetSelectedCountMessage {
	type: MessageType.SetSelectedCount;
	selected: number;
	focused?: number;
}

/** Sets the hovered byte in the editor */
export interface SetHoveredByteMessage {
	type: MessageType.SetHoveredByte;
	hovered?: number;
}

/** Saves the current offset shown in the editor. */
export interface StashDisplayedOffsetMessage {
	type: MessageType.StashDisplayedOffset;
}

/** Restored a stashed offset. */
export interface PopDisplayedOffsetMessage {
	type: MessageType.PopDisplayedOffset;
}

/** Acks a deletion request. */
export interface DeleteAcceptedMessage {
	type: MessageType.DeleteAccepted;
}

export const enum CopyFormat {
	HexOctets = "Hex Octets",
	Hex = "Hex",
	Literal = "Literal",
	Utf8 = "UTF-8",
	C = "C",
	Go = "Go",
	Java = "Java",
	JSON = "JSON",
	Base64 = "Base64",
}

export interface TriggerCopyAsMessage {
	type: MessageType.TriggerCopyAs;
	format: CopyFormat;
}

export type ToWebviewMessage =
	| ReadyResponseMessage
	| ReadRangeResponseMessage
	| SearchProgressMessage
	| SavedMessage
	| ReloadMessage
	| SetNvmBlocksMessage
	| SetNvmAnnotationsMessage
	| SetNvmCustomViewsMessage
	| GoToOffsetMessage
	| RevealNvmOffsetMessage
	| SetEditsMessage
	| SetFocusedByteMessage
	| SetFocusedByteRangeMessage
	| SetEditModeMessage
	| PopDisplayedOffsetMessage
	| StashDisplayedOffsetMessage
	| DeleteAcceptedMessage
	| TriggerCopyAsMessage;

export interface OpenDocumentMessage {
	type: MessageType.OpenDocument;
}

export interface ReadRangeMessage {
	type: MessageType.ReadRangeRequest;
	offset: number;
	bytes: number;
}

export interface MakeEditsMessage {
	type: MessageType.MakeEdits;
	edits: ISerializedEdits;
}

export type LiteralSearchQuery = { literal: (Uint8Array | "*")[] };

export type RegExpSearchQuery = { re: string };

export interface SearchRequestMessage {
	type: MessageType.SearchRequest;
	query: LiteralSearchQuery | RegExpSearchQuery;
	cap: number | undefined;
	caseSensitive: boolean;
}

export interface CancelSearchMessage {
	type: MessageType.CancelSearch;
}

export interface ClearDataInspectorMessage {
	type: MessageType.ClearDataInspector;
}

export interface SetInspectByteMessage {
	type: MessageType.SetInspectByte;
	offset: number;
}

export interface ReadyRequestMessage {
	type: MessageType.ReadyRequest;
}

export interface UpdateEditorSettings {
	type: MessageType.UpdateEditorSettings;
	editorSettings: IEditorSettings;
}

export const enum PasteMode {
	Insert = "insert",
	Replace = "replace",
}

export interface PasteMessage {
	type: MessageType.DoPaste;
	offset: number;
	data: Uint8Array;
	mode: PasteMode;
}

export interface CopyMessage {
	type: MessageType.DoCopy;
	selections: [from: number, to: number][];
	format: CopyFormat;
}

export interface RequestDeletesMessage {
	type: MessageType.RequestDeletes;
	deletes: { start: number; end: number }[];
}

export type FromWebviewMessage =
	| OpenDocumentMessage
	| ReadRangeMessage
	| MakeEditsMessage
	| SearchRequestMessage
	| CancelSearchMessage
	| ClearDataInspectorMessage
	| SetInspectByteMessage
	| SetSelectedCountMessage
	| SetHoveredByteMessage
	| ReadyRequestMessage
	| UpdateEditorSettings
	| PasteMessage
	| CopyMessage
	| RequestDeletesMessage
	| NvmAnnotationCommandMessage
	| NvmCustomViewCommandMessage;

export type ExtensionHostMessageHandler = MessageHandler<ToWebviewMessage, FromWebviewMessage>;
export type WebviewMessageHandler = MessageHandler<FromWebviewMessage, ToWebviewMessage>;

/**
 * Helper for postMessage-based RPC.
 */
export class MessageHandler<TTo, TFrom> {
	private messageIdCounter = 0;
	private readonly pendingMessages = new Map<
		number,
		{ resolve: (msg: TFrom) => void; reject: (err: Error) => void }
	>();

	constructor(
		public messageHandler: (msg: TFrom) => Promise<TTo | undefined>,
		private readonly postMessage: (msg: WebviewMessage<TTo>, transfer?: Transferable[]) => void,
	) {}

	/** Sends a request without waiting for a response */
	public sendEvent(body: TTo, transfer?: Transferable[]): void {
		this.postMessage({ body, messageId: this.messageIdCounter++ }, transfer);
	}

	/** Sends a request that expects a response */
	public sendRequest<TResponse extends TFrom>(
		msg: TTo,
		transfer?: Transferable[],
	): Promise<TResponse> {
		const id = this.messageIdCounter++;
		this.postMessage({ body: msg, messageId: id }, transfer);
		return new Promise<TResponse>((resolve, reject) => {
			this.pendingMessages.set(id, { resolve: resolve as (msg: TFrom) => void, reject });
		});
	}

	/** Sends a reply in response to a previous request */
	private sendReply(inReplyTo: WebviewMessage<TFrom>, reply: TTo): void {
		this.postMessage({
			body: reply,
			messageId: this.messageIdCounter++,
			inReplyTo: inReplyTo.messageId,
		});
	}

	/** Should be called when a postMessage is received */
	public handleMessage(message: WebviewMessage<TFrom>): void {
		if (message.inReplyTo !== undefined) {
			this.pendingMessages.get(message.inReplyTo)?.resolve(message.body);
			this.pendingMessages.delete(message.inReplyTo);
		} else {
			Promise.resolve(this.messageHandler(message.body)).then(
				reply => reply && this.sendReply(message, reply),
			);
		}
	}
}
