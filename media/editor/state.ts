/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { atom, DefaultValue, selector, selectorFamily } from "recoil";
import { HexDecorator, HexDecoratorType } from "../../shared/decorators";
import {
    buildEditTimeline,
    HexDocumentEdit,
    HexDocumentEditOp,
    HexDocumentEmptyInsertEdit,
    readUsingRanges,
} from "../../shared/hexDocumentModel";
import {
    FromWebviewMessage,
    InspectorLocation,
    MessageHandler,
    MessageType,
    NvmAnnotationsView,
    NvmBlockInfo,
    ReadRangeResponseMessage,
    ReadyResponseMessage,
    SearchResultsWithProgress,
    ToWebviewMessage,
} from "../../shared/protocol";
import { deserializeEdits, serializeEdits } from "../../shared/serialization";
import { binarySearch } from "../../shared/util/binarySearch";
import { Range } from "../../shared/util/range";
import { clamp } from "./util";

const acquireVsCodeApi: () => {
	postMessage(msg: unknown): void;
	getState(): any;
	setState(value: any): void;
} = (globalThis as any).acquireVsCodeApi;

export const vscode = acquireVsCodeApi?.();

export const setWebviewState = (key: string, value: unknown) => {
	vscode.setState?.({ ...(vscode.getState?.() ?? {}), [key]: value });
};

export const getWebviewState = <T>(key: string, defaultValue: T): T => {
	return (vscode.getState?.() ?? {})[key] ?? defaultValue;
};

type HandlerFn = (message: ToWebviewMessage) => Promise<FromWebviewMessage> | undefined;

const handles: { [T in ToWebviewMessage["type"]]?: HandlerFn | HandlerFn[] } = {};

export const registerHandler = <T extends ToWebviewMessage["type"]>(
	typ: T,
	handler: (msg: ToWebviewMessage & { type: T }) => Promise<FromWebviewMessage> | void,
): void => {
	const cast = handler as HandlerFn;
	const prev = handles[typ];
	if (!prev) {
		handles[typ] = cast;
	} else if (typeof prev === "function") {
		handles[typ] = [prev, cast];
	} else {
		prev.push(cast);
	}
};

export const messageHandler = new MessageHandler<FromWebviewMessage, ToWebviewMessage>(
	async msg => {
		const h = handles[msg.type];
		if (!h) {
			console.warn("unhandled message", msg);
		} else if (typeof h === "function") {
			return h(msg);
		} else {
			for (const fn of h) {
				fn(msg);
			}
		}
	},
	msg => vscode.postMessage(msg),
);

window.addEventListener("message", ev => messageHandler.handleMessage(ev.data));

const readyQuery = selector({
	key: "ready",
	get: () => messageHandler.sendRequest<ReadyResponseMessage>({ type: MessageType.ReadyRequest }),
});

/**
 * Selector for where the Data Inspector should be shown, if anywhere.
 * This is partially user configured, but may also change based off the
 * available editor width.
 */
export const dataInspectorLocation = selector({
	key: "dataInspectorSide",
	get: ({ get }) => {
		const settings = get(editorSettings);
		const d = get(dimensions);
		if (settings.inspectorType === InspectorLocation.Sidebar) {
			return InspectorLocation.Sidebar;
		}

		// rough approximation, if there's no enough horizontal width then use a hover instead
		// rowPxHeight * columnWidth is the width of the 'bytes' display. Double it
		// for the Decoded Text, if any, plus some sensible padding.
		if (d.rowPxHeight * settings.columnWidth * (settings.showDecodedText ? 2 : 1) + 100 > d.width) {
			return InspectorLocation.Hover;
		}

		return settings.inspectorType;
	},
});

export const isReadonly = selector({
	key: "isReadonly",
	get: ({ get }) => get(readyQuery).isReadonly,
});

export const codeSettings = selector({
	key: "codeSettings",
	get: ({ get }) => get(readyQuery).codeSettings,
});

export const decorators = selector({
	key: "decorators",
	get: ({ get }) => {
		const ready = get(readyQuery);
		const base: HexDecorator[] = ready.decorators ?? [];
		const merged = base.slice();
		merged.sort((a, b) => a.range.start - b.range.start);
		return merged;
	},
});

/**
 * Eagerly (at module load) capture NVM blocks pushed from the extension so the
 * message is never lost to a startup race, then fan out to any subscribed atom.
 */
let latestNvmBlocks: NvmBlockInfo[] = [];
const nvmBlockListeners = new Set<(blocks: NvmBlockInfo[]) => void>();
registerHandler(MessageType.SetNvmBlocks, (msg: any) => {
	latestNvmBlocks = msg.blocks ?? [];
	for (const listener of nvmBlockListeners) {
		listener(latestNvmBlocks);
	}
});

export const nvmBlocksAtom = atom<NvmBlockInfo[]>({
	key: "nvmBlocksAtom",
	default: [],
	effects_UNSTABLE: [fx => {
		// Seed with any blocks that arrived before this atom was first subscribed
		// (the SetNvmBlocks event is pushed by the extension right at startup and
		// can race the atom's lazy subscription), then keep in sync.
		fx.setSelf(latestNvmBlocks);
		const listener = (blocks: NvmBlockInfo[]) => fx.setSelf(blocks);
		nvmBlockListeners.add(listener);
		return () => {
			nvmBlockListeners.delete(listener);
		};
	}],
});

/** A single colored NVM attribute range, flattened across all blocks. */
export interface NvmFieldRange {
	start: number;
	end: number;
	kind: string;
	fieldName: string;
	/** Config-resolved background color, if any. */
	color?: string;
	/** Highlight unit this field belongs to (block / sector header / table slot). */
	unit: string;
	/** Resolved in-file jump target (editor offset), when this field is a link. */
	link?: { targetOffset: number; label?: string };
	block: NvmBlockInfo;
}

/** All NVM field ranges across every block, sorted by start offset. */
export const nvmFieldRanges = selector<NvmFieldRange[]>({
	key: "nvmFieldRanges",
	get: ({ get }) => {
		const blocks = get(nvmBlocksAtom);
		const ranges: NvmFieldRange[] = [];
		for (const block of blocks) {
			const fields = block.fields?.length
				? block.fields
				: [{ name: block.name ?? block.id, kind: "payload", offset: block.offset, length: block.length }];
			for (const f of fields) {
				if (f.length <= 0) {
					continue;
				}
				ranges.push({
					start: f.offset,
					end: f.offset + f.length,
					kind: f.kind,
					fieldName: f.name,
					color: (f as { color?: string }).color,
					unit: (f as { unit?: string }).unit ?? block.id,
					link: (f as { link?: { targetOffset: number; label?: string } }).link,
					block,
				});
			}
		}
		ranges.sort((a, b) => a.start - b.start || a.end - b.end);
		return ranges;
	},
});

export const selectedNvmBlockAtom = atom<NvmBlockInfo | undefined>({
	key: "selectedNvmBlockAtom",
	default: undefined,
});

/**
 * The currently selected highlight unit (block id / sector header / table slot).
 * Only fields belonging to this unit are colored; everything else renders like
 * the plain hex editor.
 */
export const selectedNvmUnitAtom = atom<string | undefined>({
	key: "selectedNvmUnitAtom",
	default: undefined,
});

export const showReadonlyWarningForEl = atom<HTMLElement | null>({
	key: "showReadonlyWarningForEl",
	default: null,
});

const diskFileSize = atom({
	key: "diskFileSize",
	default: selector({
		key: "defaultDiskFileSize",
		get: ({ get }) => get(readyQuery).fileSize,
	}),
	effects_UNSTABLE: [
		fx => {
			registerHandler(MessageType.SetEdits, msg => {
				if (msg.replaceFileSize !== undefined) {
					fx.setSelf(msg.replaceFileSize ?? undefined);
				}
			});
			registerHandler(MessageType.Saved, () => {
				const size = fx.getLoadable(diskFileSize).getValue();
				if (size === undefined) {
					return;
				}
				fx.setSelf(size + fx.getLoadable(unsavedEditTimeline).getValue().sizeDelta);
			});
		},
	],
});

export const fileSize = selector({
	key: "fileSize",
	get: ({ get }) => {
		const initial = get(diskFileSize);
		const sizeDelta = get(unsavedAndDecoratorEditTimeline).sizeDelta;
		return initial === undefined ? initial : initial + sizeDelta;
	},
});

const initialOffset = selector<number>({
	key: "initialOffset",
	get: ({ get }) => vscode.getState()?.offset ?? get(readyQuery).initialOffset,
});

/** Editor settings which have changes persisted to user settings */
export const editorSettings = atom({
	key: "editorSettings",
	default: selector({
		key: "defaultEditorSettings",
		get: ({ get }) => get(readyQuery).editorSettings,
	}),
	effects_UNSTABLE: [
		fx =>
			fx.onSet(value =>
				messageHandler.sendEvent({
					type: MessageType.UpdateEditorSettings,
					editorSettings: value,
				}),
			),
	],
});

export const columnWidth = selector({
	key: "columnWidth",
	get: ({ get }) => get(editorSettings).columnWidth,
});

export const copyType = selector({
	key: "copyType",
	get: ({ get }) => get(editorSettings).copyType,
});

export const showDecodedText = selector({
	key: "showDecodedText",
	get: ({ get }) => get(editorSettings).showDecodedText,
});

// Atom used to invalidate data when a reload is requested.
const reloadGeneration = atom({
	key: "reloadGeneration",
	default: 0,
	effects_UNSTABLE: [
		fx => {
			registerHandler(MessageType.ReloadFromDisk, () => {
				fx.setSelf(Date.now());
			});
		},
	],
});

export const isLargeFile = selector({
	key: "isLargeFile",
	get: ({ get }) => get(readyQuery).isLargeFile,
});

export const bypassLargeFilePrompt = atom({
	key: "bypassLargeFilePrompt",
	default: false,
});

export interface IDimensions {
	width: number;
	height: number;
	rowPxHeight: number;
}

/** Information about the window and layout size */
export const dimensions = atom<IDimensions>({
	key: "dimensions",
	default: { width: 0, height: 0, rowPxHeight: 24 },
});

/** Gets the number of bytes visible in the window. */
export const getDisplayedBytes = (d: IDimensions, columnWidth: number): number =>
	columnWidth * (Math.floor(d.height / d.rowPxHeight) - 1);

/** Gets whether the byte is visible in the current window. */
export const isByteVisible = (
	d: IDimensions,
	columnWidth: number,
	offset: number,
	byte: number,
): boolean => byte >= offset && byte - offset < getDisplayedBytes(d, columnWidth);

/** Returns the byte at the start of the row containing the given byte. */
export const startOfRowContainingByte = (byte: number, columnWidth: number): number =>
	Math.floor(byte / columnWidth) * columnWidth;

/** Currently displayed byte offset */
export const offset = atom({
	key: "offset",
	default: initialOffset,

	effects_UNSTABLE: [
		fx => {
			let stashedOffset: number | undefined;

			fx.onSet(offset => {
				vscode.setState({ ...vscode.getState(), offset });
			});

			registerHandler(MessageType.StashDisplayedOffset, () => {
				stashedOffset = fx.getLoadable(fx.node).getValue();
			});

			registerHandler(MessageType.PopDisplayedOffset, () => {
				if (stashedOffset !== undefined) {
					fx.setSelf(stashedOffset);
					stashedOffset = undefined;
				}
			});

			registerHandler(MessageType.GoToOffset, msg => {
				const s = fx.getLoadable(columnWidth).getValue();
				vscode.setState({ ...vscode.getState(), offset: msg.offset });
				fx.setSelf(startOfRowContainingByte(msg.offset, s));
			});
		},
	],
});

/** Current edit mode */
export const editMode = atom({
	key: "editMode",
	default: selector({
		key: "initialEditMode",
		get: ({ get }) => get(readyQuery).editMode,
	}),
	effects_UNSTABLE: [
		fx => {
			registerHandler(MessageType.SetEditMode, msg => {
				fx.setSelf(msg.mode);
			});
		},
	],
});

/** Size of data pages, in bytes */
export const dataPageSize = selector({
	key: "dataPageSize",
	get: ({ get }) => {
		const colWidth = get(columnWidth);
		const pageSize = get(readyQuery).pageSize;
		// Make sure the page size is a multiple of column width, since rendering
		// happens in page chunks.
		return Math.round(pageSize / colWidth) * colWidth;
	},
});

/**
 * First and last byte that can be currently scrolled to. May expand with
 * infinite scrolling.
 */
export const scrollBounds = atom<Range>({
	key: "scrollBounds",
	default: selector({
		key: "initialScrollBounds",
		get: ({ get }) => {
			const windowSize = getDisplayedBytes(get(dimensions), get(columnWidth));
			const offset = get(initialOffset);
			const scrollEnd = get(fileSize) ?? offset + windowSize * 2;

			return new Range(clamp(0, offset - windowSize, scrollEnd - windowSize), scrollEnd);
		},
	}),
});

const initialEdits = selector({
	key: "initialEdits",
	get: ({ get }) => deserializeEdits(get(readyQuery).edits),
});
/**
 * List of edits made locally and not synced with the extension host.
 */
export const edits = atom<readonly HexDocumentEdit[]>({
	key: "edits",
	default: initialEdits,

	effects_UNSTABLE: [
		fx => {
			fx.onSet((newEdits, oldEditsOrDefault) => {
				const oldEdits =
					oldEditsOrDefault instanceof DefaultValue
						? fx.getLoadable(initialEdits).getValue()
						: oldEditsOrDefault;

				if (newEdits.length > oldEdits.length) {
					messageHandler.sendEvent({
						type: MessageType.MakeEdits,
						edits: serializeEdits(newEdits.slice(oldEdits.length)),
					});
				}
			});

			registerHandler(MessageType.SetEdits, msg => {
				const edits = deserializeEdits(msg.edits);
				fx.setSelf(prev =>
					msg.appendOnly ? [...(prev instanceof DefaultValue ? [] : prev), ...edits] : edits,
				);
			});
		},
	],
});

export const unsavedEditIndex = atom({
	key: "unsavedEditIndex",
	default: selector({
		key: "initialUnsavedEditIndex",
		get: ({ get }) => get(readyQuery).unsavedEditIndex,
	}),

	effects_UNSTABLE: [
		fx => {
			registerHandler(MessageType.Saved, msg => {
				fx.setSelf(msg.unsavedEditIndex);
			});
		},
	],
});

/**
 * Timeline of all edits of the document. Includes both saved
 * and unsaved edits.
 */
export const allEditTimeline = selector({
	key: "allEditTimeline",
	get: ({ get }) => buildEditTimeline(get(edits)),
});

export const unsavedEditTimeline = selector({
	key: "unsavedEditTimeline",
	get: ({ get }) => {
		return buildEditTimeline(get(edits).slice(get(unsavedEditIndex)));
	},
});

const emptyDecoratorEdits = selector({
	key: "emptyDecoratorEdits",
	get: ({ get }) => {
		return get(decorators)
			.filter(record => record.type === HexDecoratorType.Empty)
			.map(value => {
				return {
					op: HexDocumentEditOp.EmptyInsert,
					offset: value.range.start,
					length: value.range.end - value.range.start,
				} as HexDocumentEmptyInsertEdit;
			});
	},
});

/**
 * Creates the edit timeline for the unsaved edits and empty decorators.
 */
export const unsavedAndDecoratorEditTimeline = selector({
	key: "unsavedAndDecoratorEditTimeline",
	get: ({ get }) => {
		return buildEditTimeline([
			...get(edits).slice(get(unsavedEditIndex)),
			...get(emptyDecoratorEdits),
		]);
	},
});

export const editedDataPages = selectorFamily({
	key: "editedDataPages",
	get:
		(pageNumber: number) =>
		async ({ get }) => {
			const pageSize = get(dataPageSize);
			const { ranges } = get(unsavedAndDecoratorEditTimeline);
			const target = new Uint8Array(pageSize);
			const it = readUsingRanges(
				{
					read: (offset, target) => {
						const pageNo = Math.floor(offset / pageSize);
						const page = get(rawDataPages(pageNo));
						const start = offset - pageNo * pageSize;
						const len = Math.min(page.byteLength - start, target.byteLength);
						target.set(page.subarray(start, start + len), 0);
						return Promise.resolve(len);
					},
				},
				ranges,
				pageSize * pageNumber,
				pageSize,
			);

			let soFar = 0;
			for await (const chunk of it) {
				const read = Math.min(chunk.length, target.length - soFar);
				target.set(chunk.subarray(0, read), soFar);
				soFar += read;
				if (soFar === pageSize) {
					return target;
				}
			}

			return target.subarray(0, soFar);
		},
	cachePolicy_UNSTABLE: {
		eviction: "lru",
		maxSize: 1024,
	},
});

/** Returns the decorators in a page */
export const decoratorsPage = selectorFamily({
	key: "decoratorsPage",
	get:
		(pageNumber: number) =>
		async ({ get }) => {
			const allDecorators = get(decorators);
			if (allDecorators.length === 0) {
				return [];
			}
			const pageSize = get(dataPageSize);
			const searcherByEnd = binarySearch<HexDecorator>(decorator => decorator.range.end);
			const startIndex = searcherByEnd(pageSize * pageNumber, allDecorators);
			const searcherByStart = binarySearch<HexDecorator>(d => d.range.start);
			const endIndex = searcherByStart(pageSize * pageNumber + pageSize + 1, allDecorators);
			return allDecorators.slice(startIndex, endIndex);
		},
});

/** Returns the NVM field ranges overlapping a page. */
export const nvmFieldRangesPage = selectorFamily({
	key: "nvmFieldRangesPage",
	get:
		(pageNumber: number) =>
		({ get }) => {
			const all = get(nvmFieldRanges);
			if (all.length === 0) {
				return [];
			}
			const pageSize = get(dataPageSize);
			const pageStart = pageSize * pageNumber;
			const pageEnd = pageStart + pageSize;
			// `all` is sorted by start; binary-search the window instead of an O(n)
			// scan (there can be tens of thousands of ranges across stale chunks).
			// Mirrors `decoratorsPage` above.
			const searcherByEnd = binarySearch<NvmFieldRange>(r => r.end);
			const startIndex = searcherByEnd(pageStart, all);
			const searcherByStart = binarySearch<NvmFieldRange>(r => r.start);
			const endIndex = searcherByStart(pageEnd + 1, all);
			return all.slice(startIndex, endIndex).filter(r => r.start < pageEnd && r.end > pageStart);
		},
});

/**
 * NVM annotations (bookmarks / tags / notes) pushed from the extension. Captured
 * eagerly (like blocks) so the startup push is never lost to a subscription race.
 */
const emptyAnnotations: NvmAnnotationsView = { tags: [], badges: [], assignments: [], notes: [], bookmarks: [] };
let latestNvmAnnotations: NvmAnnotationsView = emptyAnnotations;
const nvmAnnotationListeners = new Set<(a: NvmAnnotationsView) => void>();
registerHandler(MessageType.SetNvmAnnotations, (msg: any) => {
	latestNvmAnnotations = msg.annotations ?? emptyAnnotations;
	for (const listener of nvmAnnotationListeners) {
		listener(latestNvmAnnotations);
	}
});

export const nvmAnnotationsAtom = atom<NvmAnnotationsView>({
	key: "nvmAnnotationsAtom",
	default: emptyAnnotations,
	effects_UNSTABLE: [
		fx => {
			fx.setSelf(latestNvmAnnotations);
			const listener = (a: NvmAnnotationsView) => fx.setSelf(a);
			nvmAnnotationListeners.add(listener);
			return () => {
				nvmAnnotationListeners.delete(listener);
			};
		},
	],
});

/** Tag definitions indexed by id, for quick badge/chip lookup. */
export const nvmTagsById = selector({
	key: "nvmTagsById",
	get: ({ get }) => {
		const map = new Map<string, NvmAnnotationsView["tags"][number]>();
		for (const t of get(nvmAnnotationsAtom).tags) {
			map.set(t.id, t);
		}
		return map;
	},
});

/** Tag badges overlapping a page (for the per-cell corner marker). */
export const nvmTagBadgesPage = selectorFamily({
	key: "nvmTagBadgesPage",
	get:
		(pageNumber: number) =>
		({ get }) => {
			const all = get(nvmAnnotationsAtom).badges;
			if (all.length === 0) {
				return [];
			}
			const pageSize = get(dataPageSize);
			const pageStart = pageSize * pageNumber;
			const pageEnd = pageStart + pageSize;
			return all.filter(b => b.start < pageEnd && b.end > pageStart);
		},
});

/** Notes overlapping a page (for the per-cell indicator + hover). */
export const nvmNotesPage = selectorFamily({
	key: "nvmNotesPage",
	get:
		(pageNumber: number) =>
		({ get }) => {
			const all = get(nvmAnnotationsAtom).notes;
			if (all.length === 0) {
				return [];
			}
			const pageSize = get(dataPageSize);
			const pageStart = pageSize * pageNumber;
			const pageEnd = pageStart + pageSize;
			return all.filter(n => n.start < pageEnd && n.end > pageStart);
		},
});

/** Send a mutation request for annotations to the extension host. */
export const sendAnnotationCommand = (
	command: import("../../shared/protocol").NvmAnnotationCommand,
): void => {
	messageHandler.sendEvent({ type: MessageType.NvmAnnotationCommand, command });
};


const rawDataPages = selectorFamily({
	key: "rawDataPages",
	get:
		(pageNumber: number) =>
		async ({ get }) => {
			get(reloadGeneration); // used to trigger invalidation
			get(unsavedEditIndex); // used to trigger invalidation when the user saves
			const pageSize = get(dataPageSize);
			const response = await messageHandler.sendRequest<ReadRangeResponseMessage>({
				type: MessageType.ReadRangeRequest,
				offset: pageSize * pageNumber,
				bytes: pageSize,
			});

			return new Uint8Array(response.data);
		},
	cachePolicy_UNSTABLE: {
		eviction: "lru",
		maxSize: 1024,
	},
});

export const searchResults = atom<SearchResultsWithProgress>({
	key: "searchResults",
	default: {
		results: [],
		progress: 1,
	},
	effects_UNSTABLE: [
		fx => {
			registerHandler(MessageType.SearchProgress, msg => {
				fx.setSelf(prev =>
					prev instanceof DefaultValue
						? msg.data
						: {
								progress: msg.data.progress,
								capped: msg.data.capped,
								results: prev.results.concat(msg.data.results),
							},
				);
			});

			registerHandler(MessageType.ReloadFromDisk, () => {
				fx.setSelf(prev => (prev instanceof DefaultValue ? prev : { ...prev, outdated: true }));
			});
		},
	],
});
