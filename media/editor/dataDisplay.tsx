// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license

import ArrowRight from "@vscode/codicons/src/icons/arrow-right.svg";
import BookmarkIcon from "@vscode/codicons/src/icons/bookmark.svg";
import CheckIcon from "@vscode/codicons/src/icons/check.svg";
import ChevronDown from "@vscode/codicons/src/icons/chevron-down.svg";
import ChevronRight from "@vscode/codicons/src/icons/chevron-right.svg";
import EditIcon from "@vscode/codicons/src/icons/edit.svg";
import EyeIcon from "@vscode/codicons/src/icons/eye.svg";
import NoteIcon from "@vscode/codicons/src/icons/note.svg";
import TagIcon from "@vscode/codicons/src/icons/tag.svg";
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecoilValue, useSetRecoilState } from "recoil";
import { HexDecorator } from "../../shared/decorators";
import { EditRangeOp, HexDocumentEditOp } from "../../shared/hexDocumentModel";
import {
	CopyFormat,
	DeleteAcceptedMessage,
	InspectorLocation,
	MessageType,
	NvmNoteView,
	NvmTagBadge,
	NvmTagView,
} from "../../shared/protocol";
import { binarySearch } from "../../shared/util/binarySearch";
import { Range } from "../../shared/util/range";
import { PastePopup } from "./copyPaste";
import _style from "./dataDisplay.css";
import {
	dataCellCls,
	FocusedElement,
	useDisplayContext,
	useIsFlashing,
	useIsFocused,
	useIsHovered,
	useIsSelected,
	useIsUnsaved,
} from "./dataDisplayContext";
import { DataInspectorAside } from "./dataInspector";
import { useGlobalHandler, useLastAsyncRecoilValue, usePersistedState } from "./hooks";
import * as select from "./state";
import { strings } from "./strings";
import {
	clamp,
	clsx,
	colorForNvmField,
	getAsciiCharacter,
	getScrollDimensions,
	HexDecoratorStyles,
	parseHexDigit,
	throwOnUndefinedAccessInDev,
} from "./util";
import { VsTooltipPopover } from "./vscodeUi";

const style = throwOnUndefinedAccessInDev(_style);

const EmptyDataCell = () => (
	<span className={dataCellCls} aria-hidden style={{ visibility: "hidden" }}>
		00
	</span>
);

const Byte: React.FC<{ value: number }> = ({ value }) => (
	<span className={dataCellCls}>{value.toString(16).padStart(2, "0").toUpperCase()}</span>
);

// Byte cells are square, and show two (hex) characters, but text cells show a
// single character so can be narrower--by this constant multiplier.
const textCellWidth = 0.7;

const DataCellGroup: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, ...props }) => (
	<div className={style.dataCellGroup} {...props}>
		{children}
	</div>
);

const Address: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, ...props }) => (
	<div className={style.address} {...props}>
		{children}
	</div>
);

export const DataHeader: React.FC = () => {
	const editorSettings = useRecoilValue(select.editorSettings);
	const setEditorSettings = useSetRecoilState(select.editorSettings);
	const inspectorLocation = useRecoilValue(select.dataInspectorLocation);
	const showDecoded = editorSettings.showDecodedText;
	const toggleDecoded = () => setEditorSettings(s => ({ ...s, showDecodedText: !s.showDecodedText }));

	return (
		<div className={style.header}>
			<DataCellGroup style={{ visibility: "hidden" }} aria-hidden="true">
				<Address>00000000</Address>
			</DataCellGroup>
			<DataCellGroup>
				{new Array(editorSettings.columnWidth).fill(0).map((_v, i) => (
					<Byte key={i} value={i & 0xff} />
				))}
			</DataCellGroup>
			{/* Decoded text column: collapsible via the chevron; expanded by default. */}
			<DataCellGroup
				style={{
					width: showDecoded
						? `calc(var(--cell-size) * ${editorSettings.columnWidth * textCellWidth})`
						: undefined,
					flexShrink: 0,
				}}
			>
				<button
					className={style.collapseToggle}
					title={showDecoded ? "Collapse decoded text" : "Show decoded text"}
					aria-label={showDecoded ? "Collapse decoded text" : "Show decoded text"}
					onClick={toggleDecoded}
				>
					{showDecoded ? <ChevronDown /> : <ChevronRight />}
				</button>
				{showDecoded && strings.decodedText}
			</DataCellGroup>
			{inspectorLocation === InspectorLocation.Aside && <DataInspector />}
		</div>
	);
};

/** Component that shows a Data Inspector header, and the inspector itself directly below when appropriate. */
const DataInspector: React.FC = () => {
	const [isInspecting, setIsInspecting] = useState(false);
	const [collapsed, setCollapsed] = usePersistedState("nvmInspectorCollapsed", false);
	return (
		<DataCellGroup style={{ position: "relative", flexGrow: 1, flexShrink: 0 }}>
			<div className={style.collapseHeaderRow}>
				<button
					className={style.collapseToggle}
					title={collapsed ? "Show data inspector" : "Collapse data inspector"}
					aria-label={collapsed ? "Show data inspector" : "Collapse data inspector"}
					onClick={() => setCollapsed(c => !c)}
				>
					{collapsed ? <ChevronRight /> : <ChevronDown />}
				</button>
				{!collapsed && (isInspecting ? "Data Inspector" : null)}
			</div>
			{!collapsed && (
				<div
					className={style.dataInspectorWrap}
					style={
						{ "--scrollbar-width": `${getScrollDimensions().width}px` } as React.CSSProperties
					}
				>
					<DataInspectorAside onInspecting={setIsInspecting} />
				</div>
			)}
		</DataCellGroup>
	);
};

export const DataDisplay: React.FC = () => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const setOffset = useSetRecoilState(select.offset);
	const setScrollBounds = useSetRecoilState(select.scrollBounds);
	const columnWidth = useRecoilValue(select.columnWidth);
	const dimensions = useRecoilValue(select.dimensions);
	const fileSize = useRecoilValue(select.fileSize);
	const copyType = useRecoilValue(select.copyType);
	const allEditTimeline = useRecoilValue(select.allEditTimeline);
	const unsavedEditIndex = useRecoilValue(select.unsavedEditIndex);
	const ctx = useDisplayContext();
	const [pasting, setPasting] = useState<
		{ target: HTMLElement; offset: number; data: string } | undefined
	>();

	useEffect(() => {
		const l = () => {
			ctx.isSelecting = undefined;
		};
		window.addEventListener("mouseup", l, { passive: true });
		return () => window.removeEventListener("mouseup", l);
	}, []);

	// When the focused byte changes, make sure it's in view
	useEffect(() => {
		const disposable = ctx.onDidChangeAnyFocus(byte => {
			if (byte === undefined) {
				return;
			}

			const displayedBytes = select.getDisplayedBytes(dimensions, columnWidth);
			const byteRowStart = select.startOfRowContainingByte(byte, columnWidth);
			let newOffset: number;

			setOffset(offset => {
				// If the focused byte is before the selected byte, adjust upwards.
				// If the focused byte is off the window, adjust the offset so it's displayed
				if (byte < offset) {
					return (newOffset = byteRowStart);
				} else if (byte - offset >= displayedBytes) {
					return (newOffset = byteRowStart - displayedBytes + columnWidth);
				} else {
					return offset;
				}
			});

			if (newOffset! !== undefined) {
				// Ensure the scroll bounds contain the new offset.
				setScrollBounds(scrollBounds => {
					if (newOffset < scrollBounds.start) {
						return scrollBounds.expandToContain(newOffset);
					} else if (newOffset > scrollBounds.end) {
						return scrollBounds.expandToContain(newOffset + displayedBytes * 2);
					} else {
						return scrollBounds;
					}
				});
			}
		});
		return () => disposable.dispose();
	}, [dimensions, columnWidth]);

	// Whenever the edit timeline changes, update unsaved ranges.
	useEffect(() => {
		const unsavedRanges: Range[] = [];
		for (let i = 0; i < allEditTimeline.ranges.length; i++) {
			const range = allEditTimeline.ranges[i];
			// todo: eventually support delete decorations?
			if (range.op !== EditRangeOp.Insert || range.editIndex < unsavedEditIndex) {
				continue;
			}

			if (range.value.byteLength > 0) {
				unsavedRanges.push(new Range(range.offset, range.offset + range.value.byteLength));
			}
		}
		ctx.unsavedRanges = unsavedRanges;
	}, [allEditTimeline, unsavedEditIndex]);

	useGlobalHandler(
		"keydown",
		(e: KeyboardEvent) => {
			// handle keydown events not sent to a more specific element. The user can
			// scroll to a point where the 'focused' element is no longer rendered,
			// but we still want to allow use of arrow keys.
			if (
				document.activeElement !== document.body &&
				!containerRef.current?.contains(document.activeElement)
			) {
				return;
			}

			const current = ctx.focusedElement || FocusedElement.zero;
			const displayedBytes = select.getDisplayedBytes(dimensions, columnWidth);

			let delta = 0;
			switch (e.key) {
				case "ArrowLeft":
					delta = -1;
					break;
				case "ArrowRight":
					delta = 1;
					break;
				case "ArrowDown":
					delta = columnWidth;
					break;
				case "ArrowUp":
					delta = -columnWidth;
					break;
				case "Home":
					delta = -current.byte;
					break;
				case "End":
					delta = fileSize === undefined ? displayedBytes : fileSize - current.byte - 1;
					break;
				case "PageUp":
					delta = -displayedBytes;
					break;
				case "PageDown":
				case "Space":
					delta = displayedBytes;
					break;
			}

			if (e.altKey) {
				delta *= 8;
			}

			const next = new FocusedElement(
				current.char,
				// Clamp on fileSize due to the added data cell for appending bytes at eof
				clamp(0, current.byte + delta, fileSize !== undefined ? fileSize : Infinity),
			);
			if (next.key === current.key) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			ctx.focusedElement = next;

			if (e.shiftKey) {
				const srange = ctx.selection[0];
				// On a shift key, expand the selection to include the byte. If there
				// was no previous selection, create one. If the old selection didn't
				// include the newly focused byte, expand it. Otherwise, adjust the
				// closer of the start or end of the selection to the focused byte
				// (allows shrinking the selection.)
				if (!srange) {
					ctx.setSelectionRanges([Range.inclusive(current.byte, next.byte)]);
				} else if (!srange.includes(next.byte)) {
					ctx.replaceLastSelectionRange(srange.expandToContain(next.byte));
				} else {
					const closerToEnd =
						Math.abs(srange.end - current.byte) < Math.abs(srange.start - current.byte);
					const nextRange = closerToEnd
						? new Range(srange.start, next.byte + 1)
						: new Range(next.byte, srange.end);
					ctx.replaceLastSelectionRange(nextRange);
				}
			} else {
				ctx.setSelectionRanges([Range.single(next.byte)]);
			}
		},
		[dimensions, columnWidth, fileSize],
	);

	useGlobalHandler<ClipboardEvent>("paste", evt => {
		const target = document.activeElement;
		if (!(target instanceof HTMLElement) || !target.classList.contains(dataCellCls)) {
			return;
		}

		const pasteData = evt.clipboardData?.getData("text");
		if (pasteData && ctx.focusedElement) {
			setPasting({ target, offset: ctx.focusedElement.byte, data: pasteData });
		}
	});

	useGlobalHandler<ClipboardEvent>("copy", () => {
		if (ctx.focusedElement) {
			select.messageHandler.sendEvent({
				type: MessageType.DoCopy,
				selections: ctx.selection.map(r => [r.start, r.end]),
				format: ctx.focusedElement.char ? CopyFormat.Utf8 : copyType,
			});
		}
	});

	const clearPasting = useCallback(() => setPasting(undefined), []);

	return (
		<div ref={containerRef} className={style.dataDisplay}>
			<DataRows />
			<PastePopup context={pasting} hide={clearPasting} />
			<NvmHoverPopover />
		</div>
	);
};

/**
 * The single, shared NVM hover popover. Instead of every data cell owning a
 * popover (which spawned overlapping popovers + afterimages while scanning), one
 * instance listens to `ctx.nvmHover` and renders at most one popover, anchored
 * stably per unit/note so it doesn't chase the pointer byte-by-byte.
 */
const NvmHoverPopover: React.FC = () => {
	const ctx = useDisplayContext();
	const fields = useRecoilValue(select.nvmFieldRanges);
	const selectedUnit = useRecoilValue(select.selectedNvmUnitAtom);
	const annotations = useRecoilValue(select.nvmAnnotationsAtom);
	const setSelectedNvmBlock = useSetRecoilState(select.selectedNvmBlockAtom);
	const setOffset = useSetRecoilState(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);

	const [byte, setByte] = useState<number | null>(null);
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
	const shownKey = useRef<string | null>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout>>();

	const cancelHide = useCallback(() => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = undefined;
		}
	}, []);
	const hideNow = useCallback(() => {
		cancelHide();
		setByte(null);
		setAnchorEl(null);
		shownKey.current = null;
	}, [cancelHide]);
	const scheduleHide = useCallback(() => {
		cancelHide();
		hideTimer.current = setTimeout(hideNow, 250);
	}, [cancelHide, hideNow]);

	const keyForByte = useCallback(
		(b: number): string => {
			const note = annotations.notes.find(n => b >= n.start && b < n.end);
			if (note) {
				return `note:${note.id}`;
			}
			const field = fields.find(f => b >= f.start && b < f.end);
			return field ? `unit:${field.unit}` : `byte:${b}`;
		},
		[annotations, fields],
	);

	useEffect(() => {
		const d = ctx.onDidChangeNvmHover(target => {
			if (!target) {
				scheduleHide();
				return;
			}
			cancelHide();
			setByte(target.byte);
			// Only re-anchor when moving to a different unit/note, so the popover
			// stays put while scanning within one block.
			const key = keyForByte(target.byte);
			if (key !== shownKey.current) {
				shownKey.current = key;
				setAnchorEl(target.el);
			}
		});
		return () => d.dispose();
	}, [ctx, scheduleHide, cancelHide, keyForByte]);
	useEffect(() => cancelHide, [cancelHide]);

	if (byte === null || !anchorEl) {
		return null;
	}

	const field = fields.find(f => byte >= f.start && byte < f.end);
	const block = field?.block;
	const isSelectedUnit = !!field && field.unit === selectedUnit;
	const note = annotations.notes.find(n => byte >= n.start && byte < n.end);

	if (!note && !(isSelectedUnit && block)) {
		return null;
	}

	const jumpTo = (target: number) => {
		setOffset(select.startOfRowContainingByte(target, columnWidth));
		ctx.focusedElement = new FocusedElement(false, target);
	};

	return (
		<VsTooltipPopover
			anchor={anchorEl}
			hide={hideNow}
			visible
			className={style.nvmTooltip}
			onMouseEnter={cancelHide}
			onMouseLeave={scheduleHide}
		>
			<div className={style.nvmTooltipContent}>
				{note && (
					<>
						<div className={style.nvmTooltipTitle}>{note.title ?? "Note"}</div>
						<div className={style.nvmNoteBody}>
							{(note.body ?? "").slice(0, 600) || "(empty note)"}
						</div>
						<div className={style.nvmTooltipActions}>
							<button
								className={style.nvmActionButton}
								onClick={() => {
									select.sendAnnotationCommand({ kind: "openNote", id: note.id });
									hideNow();
								}}
							>
								<EditIcon />
								Open / edit
							</button>
						</div>
					</>
				)}
				{isSelectedUnit && block && (
					<>
						<div className={style.nvmTooltipTitle}>{block.name ?? block.id}</div>
						{field && (
							<div className={style.nvmTooltipSubtitle}>
								{field.fieldName} ({field.kind})
							</div>
						)}
						<div className={style.nvmTooltipDetails}>
							Offset: 0x{block.offset.toString(16).toUpperCase()} • {block.length} bytes
						</div>
						<div className={style.nvmTooltipActions}>
							<button
								className={style.nvmActionButton}
								title="Select this block"
								onClick={() => {
									setSelectedNvmBlock(block);
									hideNow();
								}}
							>
								<CheckIcon />
								Select
							</button>
							<button
								className={style.nvmActionButton}
								title="Reveal the block start"
								onClick={() => {
									setOffset(block.offset);
									hideNow();
								}}
							>
								<EyeIcon />
								Reveal
							</button>
							{field?.link && (
								<button
									className={style.nvmActionButton}
									title={
										field.link.label
											? `Jump to ${field.link.label}`
											: "Jump to linked address"
									}
									onClick={() => {
										jumpTo(field.link!.targetOffset);
										hideNow();
									}}
								>
									<ArrowRight />
									Jump
								</button>
							)}
							{(() => {
								// If a bookmark already sits at this block's start, offer to
								// edit its label; otherwise create one (prompting for a label).
								// The host shows the input box — the webview can't.
								const existing = annotations.bookmarks.find(
									b => b.offset === block.offset,
								);
								return existing ? (
									<button
										className={style.nvmActionButton}
										title="Edit this bookmark's label"
										onClick={() => {
											select.sendAnnotationCommand({
												kind: "renameBookmark",
												id: existing.id,
												label: "__prompt__",
											});
											hideNow();
										}}
									>
										<EditIcon />
										Edit bookmark
									</button>
								) : (
									<button
										className={style.nvmActionButton}
										title="Add a bookmark at this block"
										onClick={() => {
											select.sendAnnotationCommand({
												kind: "addBookmark",
												offset: block.offset,
												label: block.name ?? block.id,
												prompt: true,
											});
											hideNow();
										}}
									>
										<BookmarkIcon />
										Bookmark
									</button>
								);
							})()}
							<button
								className={style.nvmActionButton}
								title="Attach a note to this block"
								onClick={() => {
									select.sendAnnotationCommand({
										kind: "addNote",
										start: field?.start ?? block.offset,
										end: field?.end ?? block.offset + block.length,
										title: block.name ?? block.id,
									});
									hideNow();
								}}
							>
								<NoteIcon />
								Note
							</button>
							<button
								className={style.nvmActionButton}
								title="Tag this range (choose/create a tag)"
								onClick={() => {
									select.sendAnnotationCommand({
										kind: "assignTag",
										tagId: "__prompt__",
										start: field?.start ?? block.offset,
										end: field?.end ?? block.offset + block.length,
									});
									hideNow();
								}}
							>
								<TagIcon />
								Tag
							</button>
						</div>
					</>
				)}
			</div>
		</VsTooltipPopover>
	);
};

const DataRows: React.FC = () => {
	const offset = useRecoilValue(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);
	const showDecodedText = useRecoilValue(select.showDecodedText);
	const dimensions = useRecoilValue(select.dimensions);
	const fileSize = useRecoilValue(select.fileSize) ?? Infinity;

	const displayedBytes = select.getDisplayedBytes(dimensions, columnWidth);
	const dataPageSize = useRecoilValue(select.dataPageSize);

	const startPageNo = Math.floor(offset / dataPageSize);
	const startPageStartsAt = startPageNo * dataPageSize;
	const endPageNo = Math.floor((offset + displayedBytes) / dataPageSize);
	const endPageStartsAt = endPageNo * dataPageSize;

	const rows: React.ReactChild[] = [];
	// i === startPageStartsAt so that we always show at least 1 page, allowing users to append to empty files (#534)
	for (let i = startPageStartsAt; i <= endPageStartsAt && (i === startPageStartsAt || i < fileSize); i += dataPageSize) {
		rows.push(
			<DataPage
				key={i}
				pageNo={i / dataPageSize}
				pageStart={i}
				rowsStart={Math.max(i, offset)}
				rowsEnd={Math.min(i + dataPageSize, offset + displayedBytes)}
				top={((i - offset) / columnWidth) * dimensions.rowPxHeight}
				columnWidth={columnWidth}
				showDecodedText={showDecodedText}
				fileSize={fileSize}
				dimensions={dimensions}
			/>,
		);
	}

	return <>{rows}</>;
};

const LoadingDataRow: React.FC<{ width: number; showDecodedText: boolean }> = ({
	width,
	showDecodedText,
}) => {
	const cells: React.ReactNode[] = [];
	const text = strings.loadingUpper;
	for (let i = 0; i < width; i++) {
		const str = (text[i * 2] || ".") + (text[i * 2 + 1] || ".");
		cells.push(
			<span className={dataCellCls} aria-hidden style={{ opacity: 0.5 }} key={i}>
				{str}
			</span>,
		);
	}

	return (
		<>
			<DataCellGroup>{cells}</DataCellGroup>
			{showDecodedText && <DataCellGroup>{cells}</DataCellGroup>}
		</>
	);
};

interface IDataPageProps {
	// Page number
	pageNo: number;
	// Start of the page
	pageStart: number;
	// the offset rows should start displaying at
	rowsStart: number;
	// the offset rows should finish displaying at
	rowsEnd: number;
	// count of many rows are displayed before this data page
	top: number;

	// common properties:
	columnWidth: number;
	fileSize: number;
	showDecodedText: boolean;
	dimensions: select.IDimensions;
}

const DataPage: React.FC<IDataPageProps> = props => (
	<div className={style.dataPage} style={{ transform: `translateY(${props.top}px)` }}>
		<Suspense fallback={<LoadingDataRows {...props} />}>
			<DataPageContents {...props} />
		</Suspense>
	</div>
);

const generateRows = (
	props: IDataPageProps,
	fn: (offset: number, isRowWithInsertDataCell: boolean) => React.ReactChild,
) => {
	const rows: React.ReactNode[] = [];
	let row = (props.rowsStart - props.pageStart) / props.columnWidth;
	const lastRowIndex = props.columnWidth * Math.floor(props.fileSize / props.columnWidth);
	for (let i = props.rowsStart; i < props.rowsEnd && i <= lastRowIndex; i += props.columnWidth) {
		rows.push(
			<div
				key={i}
				className={style.dataRow}
				style={{ top: `${row++ * props.dimensions.rowPxHeight}px` }}
			>
				<DataCellGroup>
					<Address>{i.toString(16).padStart(8, "0")}</Address>
				</DataCellGroup>
				{fn(i, i === lastRowIndex)}
			</div>,
		);
	}

	return rows;
};

const LoadingDataRows: React.FC<IDataPageProps> = props => (
	<>
		{generateRows(props, () => (
			<LoadingDataRow width={props.columnWidth} showDecodedText={props.showDecodedText} />
		))}
	</>
);

const DataPageContents: React.FC<IDataPageProps> = props => {
	const decorators = useRecoilValue(select.decoratorsPage(props.pageNo));
	const nvmFields = useRecoilValue(select.nvmFieldRangesPage(props.pageNo));
	const selectedUnit = useRecoilValue(select.selectedNvmUnitAtom);
	const tagBadges = useRecoilValue(select.nvmTagBadgesPage(props.pageNo));
	const notes = useRecoilValue(select.nvmNotesPage(props.pageNo));
	const tagsById = useRecoilValue(select.nvmTagsById);
	const dataPageSelector = select.editedDataPages(props.pageNo);
	const [data] = useLastAsyncRecoilValue(dataPageSelector);

	return (
		<>
			{generateRows(props, (offset, isRowWithInsertDataCell) => (
				<DataRowContents
					offset={offset}
					rawBytes={data.subarray(
						offset - props.pageStart,
						offset - props.pageStart + props.columnWidth,
					)}
					width={props.columnWidth}
					showDecodedText={props.showDecodedText}
					isRowWithInsertDataCell={isRowWithInsertDataCell}
					decorators={decorators}
					nvmFields={nvmFields}
					selectedUnit={selectedUnit}
					tagBadges={tagBadges}
					notes={notes}
					tagsById={tagsById}
				/>
			))}
		</>
	);
};

const DataCell: React.FC<{
	offset: number;
	value: number;
	isChar: boolean;
	isAppend: boolean;
	className?: string;
	// optional nvm field (colored attribute) this cell belongs to
	nvmField?: select.NvmFieldRange;
	// whether this cell's unit is the currently selected (rendered) one
	isSelectedUnit?: boolean;
	// annotation overlays (bookmarks/tags/notes)
	tagColor?: string;
	tagTitle?: string;
	note?: NvmNoteView;
}> = ({ offset, value, className, children, isChar, isAppend, nvmField, isSelectedUnit, tagColor, tagTitle, note }) => {
	const elRef = useRef<HTMLSpanElement | null>(null);
	const focusedElement = new FocusedElement(isChar, offset);
	const ctx = useDisplayContext();
	const setReadonlyWarning = useSetRecoilState(select.showReadonlyWarningForEl);
	const editMode = useRecoilValue(select.editMode);

	const nvmBlock = nvmField?.block;
	const setSelectedNvmBlock = useSetRecoilState(select.selectedNvmBlockAtom);
	const setSelectedNvmUnit = useSetRecoilState(select.selectedNvmUnitAtom);
	const setOffset = useSetRecoilState(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);

	// Navigate to an in-file link target: reveal the row and focus the byte.
	const jumpTo = useCallback(
		(target: number) => {
			setOffset(select.startOfRowContainingByte(target, columnWidth));
			ctx.focusedElement = new FocusedElement(false, target);
			ctx.setSelectionRanges([Range.single(target)]);
		},
		[columnWidth],
	);
	// Whether this cell has hover content worth a popover (a note, or a byte of
	// the currently selected NVM unit). The popover itself is a single, shared
	// component (`NvmHoverPopover`) driven through the display context, so moving
	// the pointer across bytes never spawns one popover per cell (which caused
	// afterimages + jank).
	const hasHoverPopover = (isSelectedUnit && !!nvmBlock) || !!note;
	const onMouseEnter = useCallback(() => {
		ctx.hoveredByte = focusedElement;
		if (!isAppend && ctx.isSelecting !== undefined) {
			ctx.replaceLastSelectionRange(Range.inclusive(ctx.isSelecting, offset));
		}
		ctx.nvmHover = hasHoverPopover && elRef.current ? { el: elRef.current, byte: offset } : undefined;
	}, [offset, focusedElement, hasHoverPopover]);

	const onMouseLeave = useCallback(
		(e: React.MouseEvent) => {
			ctx.hoveredByte = undefined;
			if (hasHoverPopover) {
				ctx.nvmHover = undefined;
			}
			if (!isAppend && e.buttons & 1 && ctx.isSelecting === undefined) {
				ctx.isSelecting = offset;
				if (e.ctrlKey || e.metaKey) {
					ctx.addSelectionRange(Range.single(offset));
				} else {
					ctx.setSelectionRanges([Range.single(offset)]);
				}
			}
		},
		[offset, isAppend, hasHoverPopover],
	);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.buttons === 2) {
				// Sets a new range and focused when the user opens
				// the context menu outside the selected range, just
				// like the text editor.
				if (!ctx.isSelected(focusedElement.byte)) {
					ctx.focusedElement = focusedElement;
					ctx.isSelecting = undefined;
					ctx.setSelectionRanges([Range.single(offset)]);
				}
				return;
			}
			if (!(e.buttons & 1)) {
				return;
			}

			const prevFocused = ctx.focusedElement;
			ctx.focusedElement = focusedElement;

			if (ctx.isSelecting !== undefined) {
				ctx.isSelecting = undefined;
			} else if (e.shiftKey && prevFocused) {
				// on a shift key, the user is expanding the selection (or deselection)
				// of an existing offset. We *don't* include that offset since we don't want
				// to swap the offset.
				if (e.ctrlKey || e.metaKey) {
					ctx.addSelectionRange(Range.inclusive(prevFocused.byte, offset));
				} else {
					ctx.setSelectionRanges([Range.inclusive(prevFocused.byte, offset)]);
				}
			} else if (e.ctrlKey || e.metaKey) {
				ctx.addSelectionRange(Range.single(offset));
			} else {
				ctx.setSelectionRanges([Range.single(offset)]);
			}
		},
		[focusedElement.key, offset],
	);

	const onClick = useCallback(
		(e: React.MouseEvent) => {
			// Ctrl/Cmd-click on a linked field jumps to its in-file target
			// (plain click is reserved for unit selection / cursor placement).
			if ((e.ctrlKey || e.metaKey) && nvmField?.link) {
				jumpTo(nvmField.link.targetOffset);
				return;
			}
			// Clicking selects the whole unit under the cursor (a data block, the
			// sector header, or a single sector-table slot); clicking elsewhere
			// clears the highlight so the view returns to the plain hex editor.
			if (nvmField) {
				setSelectedNvmUnit(nvmField.unit);
				setSelectedNvmBlock(nvmField.block);
			} else {
				setSelectedNvmUnit(undefined);
				setSelectedNvmBlock(undefined);
			}
		},
		[nvmField, jumpTo],
	);

	const isFocused = useIsFocused(focusedElement);
	useEffect(() => {
		if (isFocused) {
			if (document.hasFocus()) {
				elRef.current?.focus();
			}
		} else {
			setFirstOctetOfEdit(undefined);
		}
	}, [isFocused]);

	// Filling in a byte cell requires two octets to be entered. This stores
	// the first octet, and is reset if the user stops editing.
	const [firstOctetOfEdit, setFirstOctetOfEdit] = useState<number>();
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) {
				return;
			}

			if (e.key === "Delete") {
				// this is a bit of a hack, but this is kind of tricky: we got a delete
				// for a range, and the edit must be undoable, but we aren't ensured to
				// have the data paged in for the range. So make a separate request
				// that will result in the extension host sending the edit to us.
				select.messageHandler
					.sendRequest<DeleteAcceptedMessage>({
						type: MessageType.RequestDeletes,
						deletes: ctx.getSelectionRanges().map(r => ({ start: r.start, end: r.end })),
					})
					.then(() => ctx.setSelectionRanges([]));
			}

			let newValue = isChar && e.key.length === 1 ? e.key.charCodeAt(0) : parseHexDigit(e.key);
			if (newValue === undefined) {
				return;
			}

			e.stopPropagation();

			if (ctx.isReadonly) {
				setReadonlyWarning(elRef.current);
				return;
			}
			// Inserting at eof
			if (isAppend) {
				if (isChar) {
					// b is final
				} else if (firstOctetOfEdit !== undefined) {
					newValue = firstOctetOfEdit | newValue;
				} else {
					return setFirstOctetOfEdit(newValue << 4);
				}
				ctx.edit({
					op: HexDocumentEditOp.Insert,
					value: new Uint8Array([newValue]),
					offset: offset,
				});
				ctx.focusedElement = ctx.focusedElement?.shift(1);
				return setFirstOctetOfEdit(undefined);

				// Inserting in the middle or at the beginning
			} else if (editMode === HexDocumentEditOp.Insert) {
				if (isChar) {
					ctx.focusedElement = ctx.focusedElement?.shift(1);
					// Finishes byte insertion
				} else if (firstOctetOfEdit !== undefined) {
					ctx.edit({
						op: HexDocumentEditOp.Replace,
						previous: new Uint8Array([firstOctetOfEdit]),
						value: new Uint8Array([firstOctetOfEdit | newValue]),
						offset: offset,
					});
					ctx.focusedElement = ctx.focusedElement?.shift(1);
					return setFirstOctetOfEdit(undefined);
					// Starts byte insertion
				} else {
					setFirstOctetOfEdit(newValue << 4);
				}

				ctx.edit({
					op: HexDocumentEditOp.Insert,
					value: new Uint8Array([newValue]),
					offset: offset,
				});

				// Replaces bytes
			} else if (editMode === HexDocumentEditOp.Replace) {
				if (isChar) {
					// b is final
				} else if (firstOctetOfEdit !== undefined) {
					newValue = (firstOctetOfEdit << 4) | newValue;
				} else {
					return setFirstOctetOfEdit(newValue);
				}

				ctx.focusedElement = ctx.focusedElement?.shift(1);
				setFirstOctetOfEdit(undefined);
				ctx.edit({
					op: HexDocumentEditOp.Replace,
					previous: new Uint8Array([value]),
					value: new Uint8Array([newValue]),
					offset: offset,
				});
			}
		},
		[offset, isChar, firstOctetOfEdit, isAppend, editMode],
	);

	const onFocus = useCallback(() => {
		ctx.focusedElement = focusedElement;
	}, [focusedElement]);

	const onBlur = useCallback(() => {
		queueMicrotask(() => {
			if (ctx.focusedElement?.key === focusedElement.key) {
				ctx.focusedElement = undefined;
			}
		});
	}, [focusedElement]);

	const isHovered = useIsHovered(focusedElement);
	const isSelected = useIsSelected(offset);
	const isFlashing = useIsFlashing(offset);

	const editStyle =
		editMode === HexDocumentEditOp.Replace
			? style.dataCellReplace
			: firstOctetOfEdit === undefined // Assumes HexDocumentEditOp.Insert
				? style.dataCellInsertBefore
				: style.dataCellInsertMiddle;
	return (
		<span
			ref={elRef}
			tabIndex={0}
			onFocus={onFocus}
			onBlur={onBlur}
			onClick={onClick}
			className={clsx(
				isChar && style.dataCellChar,
				dataCellCls,
				className,
				isAppend && style.dataCellAppend,
				isFocused && editStyle,
				isHovered && style.dataCellHovered,
				isSelected && style.dataCellSelected,
				isHovered && isSelected && style.dataCellSelectedHovered,
				isFlashing && style.dataCellFlash,
				useIsUnsaved(offset) && style.dataCellUnsaved,
			)}
			onMouseEnter={onMouseEnter}
			onMouseDown={onMouseDown}
			onMouseLeave={onMouseLeave}
			onKeyDown={onKeyDown}
			data-key={focusedElement.key}
			style={{
				position: tagColor || note ? "relative" : undefined,
				...(isSelectedUnit && nvmField
					? {
							background: colorForNvmField(nvmField.kind, nvmField.color),
							color: "#1f1f1f",
							fontWeight: 600,
							// Linked fields advertise the Ctrl/Cmd-click jump affordance.
							...(nvmField.link
								? { cursor: "pointer", textDecoration: "underline" }
								: undefined),
						}
					: undefined),
			}}
			title={
				tagTitle
					? `Tags: ${tagTitle}`
					: isSelectedUnit && nvmField?.link
						? `Ctrl/Cmd-click to jump${nvmField.link.label ? ` to ${nvmField.link.label}` : ""}`
						: undefined
			}
		>
			{tagColor && (
				<span
					aria-hidden
					className={style.nvmTagBadge}
					style={{ borderTopColor: tagColor }}
				/>
			)}
			{note && <span aria-hidden className={style.nvmNoteDot} />}
			{firstOctetOfEdit !== undefined ? firstOctetOfEdit.toString(16).toUpperCase() : children}
	</span>
	);
};

const DataRowContents: React.FC<{
	offset: number;
	width: number;
	showDecodedText: boolean;
	rawBytes: Uint8Array;
	isRowWithInsertDataCell: boolean;
	decorators: HexDecorator[];
	nvmFields: select.NvmFieldRange[];
	selectedUnit?: string;
	tagBadges: NvmTagBadge[];
	notes: NvmNoteView[];
	tagsById: Map<string, NvmTagView>;
}> = ({
	offset,
	width,
	showDecodedText,
	rawBytes,
	isRowWithInsertDataCell,
	decorators,
	nvmFields,
	selectedUnit,
	tagBadges,
	notes,
	tagsById,
}) => {
	let memoValue = "";
	const ctx = useDisplayContext();
	for (const byte of rawBytes) {
		memoValue += "," + byte;
	}

	// A cheap signature so the row re-renders when annotations for it change.
	const annoSig =
		tagBadges.map(b => `${b.start}:${b.end}:${b.tagIds.join("+")}`).join("|") +
		"#" +
		notes.map(n => `${n.start}:${n.end}`).join("|");

	const { bytes, chars } = useMemo(() => {
		const bytes: React.ReactChild[] = [];
		const chars: React.ReactChild[] = [];
		const searcher = binarySearch<HexDecorator>(d => d.range.end);
		let j = searcher(offset, decorators);
		for (let i = 0; i < width; i++) {
			const boffset = offset + i;
			const value = rawBytes[i];
			let decorator: HexDecorator | undefined = undefined;
			// Searches for the decorator, if any. Leverages the fact that
			// the decorators are sorted by range.
			while (j < decorators.length && decorators[j].range.start <= boffset) {
				if (boffset >= decorators[j].range.start && boffset < decorators[j].range.end) {
					decorator = decorators[j];
					break;
				}
				j++;
			}

			if (value === undefined) {
				if (isRowWithInsertDataCell && !ctx.isReadonly) {
					bytes.push(
						<DataCell key={i} offset={boffset} isChar={false} isAppend={true} value={value}>
							+
						</DataCell>,
					);
					chars.push(
						<DataCell key={i} offset={boffset} isChar={true} isAppend={true} value={value}>
							+
						</DataCell>,
					);
					isRowWithInsertDataCell = false;
				} else {
					bytes.push(<EmptyDataCell key={i} />);
					chars.push(<EmptyDataCell key={i} />);
				}
				continue;
			}

			// find the NVM field (colored attribute) covering this byte, if any
			const nvmField = nvmFields.find(f => boffset >= f.start && boffset < f.end);
			const isSelectedUnit = nvmField !== undefined && nvmField.unit === selectedUnit;

			// annotations covering this byte: tag badge (corner) + note (indicator)
			const tagBadge = tagBadges.find(b => boffset >= b.start && boffset < b.end);
			const tagColor = tagBadge
				? tagsById.get(tagBadge.tagIds[0])?.color ?? "var(--vscode-charts-orange)"
				: undefined;
			const tagTitle = tagBadge
				? tagBadge.tagIds.map(id => tagsById.get(id)?.label ?? id).join(", ")
				: undefined;
			const note = notes.find(n => boffset >= n.start && boffset < n.end);

			bytes.push(
				<DataCell
					key={i}
					className={clsx(decorator !== undefined && HexDecoratorStyles[decorator.type])}
					offset={boffset}
					isChar={false}
					isAppend={false}
					value={value}
					nvmField={nvmField}
					isSelectedUnit={isSelectedUnit}
					tagColor={tagColor}
					tagTitle={tagTitle}
					note={note}
				>
					{value.toString(16).padStart(2, "0").toUpperCase()}
				</DataCell>,
			);

			if (showDecodedText) {
				const char = getAsciiCharacter(value);
				chars.push(
					<DataCell
						key={i}
						offset={boffset}
						isChar={true}
						isAppend={false}
						className={clsx(
							char === undefined ? style.nonGraphicChar : undefined,
							decorator !== undefined && HexDecoratorStyles[decorator.type],
						)}
						value={value}
						nvmField={nvmField}
						isSelectedUnit={isSelectedUnit}
					>
						{char === undefined ? "." : char}
					</DataCell>,
				);
			}
		}

		return { bytes, chars };
	}, [memoValue, showDecodedText, isRowWithInsertDataCell, nvmFields, selectedUnit, decorators, annoSig]);

	return (
		<>
			<DataCellGroup>{bytes}</DataCellGroup>
			<DataCellGroup>{chars}</DataCellGroup>
		</>
	);
};
