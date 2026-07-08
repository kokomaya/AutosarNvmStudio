import AddIcon from "@vscode/codicons/src/icons/add.svg";
import CloseIcon from "@vscode/codicons/src/icons/close.svg";
import EyeIcon from "@vscode/codicons/src/icons/eye.svg";
import TrashIcon from "@vscode/codicons/src/icons/trash.svg";
import React, { Suspense, useEffect, useMemo, useState } from "react";
// recoil imports below
import { useRecoilValue, useSetRecoilState } from "recoil";
import { Endianness } from "../../shared/protocol";
import { NvmDecodedNode } from "../../shared/nvm/structRich";
import { Range } from "../../shared/util/range";
import { FocusedElement, getDataCellElement, useDisplayContext } from "./dataDisplayContext";
import _style from "./dataInspector.css";
import { inspectableTypes } from "./dataInspectorProperties";
import { useFileBytes, usePersistedState } from "./hooks";
import * as select from "./state";
import { strings } from "./strings";
import { throwOnUndefinedAccessInDev } from "./util";
import { VsTooltipPopover } from "./vscodeUi";

const style = throwOnUndefinedAccessInDev(_style);

/** Component that shows a data inspector when bytes are hovered. */
export const DataInspectorHover: React.FC = () => {
	const ctx = useDisplayContext();
	const [inspected, setInspected] = useState<FocusedElement>();
	const anchor = useMemo(() => inspected && getDataCellElement(inspected), [inspected]);

	useEffect(() => {
		let hoverTimeout: NodeJS.Timeout | undefined;

		const disposable = ctx.onDidHover(target => {
			if (hoverTimeout) {
				clearTimeout(hoverTimeout);
				hoverTimeout = undefined;
			}
			if (target && ctx.isSelecting === undefined) {
				setInspected(undefined);
				hoverTimeout = setTimeout(() => setInspected(target), 500);
			}
		});

		return () => disposable.dispose();
	}, []);

	if (!inspected || !anchor) {
		return null;
	}

	return (
		<VsTooltipPopover anchor={anchor} hide={() => setInspected(undefined)} visible={true}>
			<Suspense fallback={strings.loadingDotDotDot}>
				<InspectorContents columns={4} offset={inspected.byte} />
			</Suspense>
		</VsTooltipPopover>
	);
};

/** Data inspector view shown to the right hand side of the hex editor. */
export const DataInspectorAside: React.FC<{ onInspecting?(isInspecting: boolean): void }> = ({
	onInspecting,
}) => {
	const ctx = useDisplayContext();
	const [inspected, setInspected] = useState<FocusedElement | undefined>(ctx.focusedElement);
	const selectedBlock = useRecoilValue(select.selectedNvmBlockAtom);
	const setOffset = useSetRecoilState(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);

	useEffect(() => {
		const disposable = ctx.onDidFocus(focused => {
			if (!inspected) {
				onInspecting?.(true);
			}
			if (focused) {
				setInspected(focused);
			}
		});
		return () => disposable.dispose();
	}, []);

	if (!inspected && !selectedBlock) {
		return null;
	}

	return (
		<Suspense fallback={null}>
			{/* Show NVM block details if one is selected */}
			{selectedBlock ? (
				<div className={style.nvmInspector}>
					<div className={style.nvmBlockHeader}>
						<h3>{selectedBlock.name ?? selectedBlock.id}</h3>
						{selectedBlock.decoded && selectedBlock.decoded.length > 0 && (
							<button
								className={style.nvmAddToViewBtn}
								title="Add this block (and structurally-matching blocks) to a custom view"
								onClick={() =>
									select.sendCustomViewCommand({
										kind: "addBlock",
										viewId: "__new__",
										blockId: selectedBlock.id,
										by: "fingerprint",
									})
								}
							>
								<AddIcon />
								Add to Custom View
							</button>
						)}
					</div>
					<div className={style.nvmMeta}>
						<span>
							<span className={style.nvmMetaKey}>Offset</span> {selectedBlock.offset}
						</span>
						<span>
							<span className={style.nvmMetaKey}>Length</span> {selectedBlock.length}
						</span>
					</div>
					{selectedBlock.decoded && selectedBlock.decoded.length > 0 && (
						<NvmDecodedTree nodes={selectedBlock.decoded} />
					)}
					<details className={style.nvmRawDetails}>
						<summary>Raw metadata</summary>
						<div style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 200 }}>
							<code>{JSON.stringify(selectedBlock.raw ?? {}, null, 2)}</code>
						</div>
					</details>
					<div className={style.nvmActionRow}>
						<button
							className={style.nvmActionBtn}
							title="Scroll to and select this block's first byte"
							onClick={() => {
								// reveal block start in view and focus it
								setOffset(select.startOfRowContainingByte(selectedBlock.offset, columnWidth));
								ctx.focusedElement = new FocusedElement(false, selectedBlock.offset);
							}}
						>
							<EyeIcon />
							Reveal Block
						</button>
					</div>
				</div>
			) : null}

			{/* Tag manager for the current block/byte target */}
			{selectedBlock ? (
				<NvmTagSection
					start={selectedBlock.offset}
					end={selectedBlock.offset + selectedBlock.length}
				/>
			) : inspected ? (
				<NvmTagSection start={inspected.byte} end={inspected.byte + 1} />
			) : null}

			{inspected ? (
				<InspectorContents
					columns={2}
					offset={inspected.byte}
					preferDecoded={!!(selectedBlock?.decoded && selectedBlock.decoded.length > 0)}
				/>
			) : null}
		</Suspense>
	);
};

/**
 * Full tag manager scoped to the current inspector target ([start, end)):
 * lists tags covering the range with quick removal, assigns existing/new tags,
 * and (collapsed) lets the user rename, recolor or delete tag definitions.
 */
const NvmTagSection: React.FC<{ start: number; end: number }> = ({ start, end }) => {
	const annotations = useRecoilValue(select.nvmAnnotationsAtom);
	const tagsById = useMemo(() => {
		const m = new Map<string, (typeof annotations.tags)[number]>();
		for (const t of annotations.tags) {
			m.set(t.id, t);
		}
		return m;
	}, [annotations.tags]);

	// Assignments overlapping the current target range.
	const covering = useMemo(
		() => annotations.assignments.filter(a => a.start < end && a.end > start),
		[annotations.assignments, start, end],
	);

	const [pendingTag, setPendingTag] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [newColor, setNewColor] = useState("#4e9cff");

	const assignExisting = (tagId: string) => {
		if (tagId) {
			select.sendAnnotationCommand({ kind: "assignTag", tagId, start, end });
			setPendingTag("");
		}
	};

	const createAndAssign = () => {
		const label = newLabel.trim();
		if (!label) {
			return;
		}
		select.sendAnnotationCommand({ kind: "createAndAssignTag", label, color: newColor, start, end });
		setNewLabel("");
	};

	const unassigned = annotations.tags.filter(t => !covering.some(a => a.tagId === t.id));

	// The tag manager is a secondary tool, so keep it collapsed by default (it
	// otherwise leads with "No tags on this range"). Persist the open state like
	// the primitive-types section does.
	const [tagsOpen, setTagsOpen] = usePersistedState("dataInspectorTagsOpen", false);

	return (
		<details
			className={style.nvmTagSection}
			open={tagsOpen}
			onToggle={e => setTagsOpen((e.target as HTMLDetailsElement).open)}
		>
			<summary className={style.nvmTagHeader}>
				Tags{covering.length ? ` (${covering.length})` : ""}
			</summary>

			<div className={style.nvmTagChips}>
				{covering.length === 0 && (
					<span className={style.nvmTagEmpty}>No tags on this range</span>
				)}
				{covering.map(a => {
					const tag = tagsById.get(a.tagId);
					return (
						<span key={a.id} className={style.nvmTagChip} title={tag?.label}>
							<span
								className={style.nvmTagDot}
								style={{ background: tag?.color ?? "#c8c8c8" }}
							/>
							<span className={style.nvmTagChipLabel}>{tag?.label ?? "?"}</span>
							<button
								className={style.nvmTagIconBtn}
								title="Remove tag from this range"
								onClick={() =>
									select.sendAnnotationCommand({ kind: "unassignTag", assignmentId: a.id })
								}
							>
								<CloseIcon />
							</button>
						</span>
					);
				})}
			</div>

			<div className={style.nvmTagRow}>
				<select
					className={style.nvmTagInput}
					value={pendingTag}
					onChange={e => assignExisting(e.target.value)}
					disabled={unassigned.length === 0}
				>
					<option value="">
						{unassigned.length === 0 ? "No more tags to add" : "Add existing tag…"}
					</option>
					{unassigned.map(t => (
						<option key={t.id} value={t.id}>
							{t.label}
						</option>
					))}
				</select>
			</div>

			<div className={style.nvmTagRow}>
				<input
					className={style.nvmTagColor}
					type="color"
					value={newColor}
					title="New tag color"
					onChange={e => setNewColor(e.target.value)}
				/>
				<input
					className={style.nvmTagInput}
					type="text"
					placeholder="New tag name"
					value={newLabel}
					onChange={e => setNewLabel(e.target.value)}
					onKeyDown={e => e.key === "Enter" && createAndAssign()}
				/>
				<button
					className={style.nvmTagBtn}
					title="Create and apply tag"
					disabled={!newLabel.trim()}
					onClick={createAndAssign}
				>
					<AddIcon />
					Add
				</button>
			</div>

			<details className={style.nvmTagManage}>
				<summary>Manage tags ({annotations.tags.length})</summary>
				{annotations.tags.length === 0 && (
					<div className={style.nvmTagEmpty}>No tags defined yet</div>
				)}
				{annotations.tags.map(t => (
					<div key={t.id} className={style.nvmTagRow}>
						<input
							className={style.nvmTagColor}
							type="color"
							value={t.color ?? "#c8c8c8"}
							title="Recolor"
							onChange={e =>
								select.sendAnnotationCommand({
									kind: "recolorTag",
									tagId: t.id,
									color: e.target.value,
								})
							}
						/>
						<input
							className={style.nvmTagInput}
							type="text"
							defaultValue={t.label}
							title="Rename (press Enter)"
							onKeyDown={e => {
								if (e.key === "Enter") {
									const label = (e.target as HTMLInputElement).value.trim();
									if (label) {
										select.sendAnnotationCommand({ kind: "renameTag", tagId: t.id, label });
									}
								}
							}}
						/>
						<button
							className={style.nvmTagIconBtn}
							title="Delete tag and all its assignments"
							onClick={() => select.sendAnnotationCommand({ kind: "deleteTag", tagId: t.id })}
						>
							<TrashIcon />
						</button>
					</div>
				))}
			</details>
		</details>
	);
};

const lookahead = 16;

/** Format a decoded leaf's value for display (dec · hex, enum label, unit). */
function formatNodeValue(node: NvmDecodedNode): string {
	const parts: string[] = [];
	if (typeof node.value === "boolean") {
		// Flag / bool leaves read better as TRUE/FALSE (matches the UDS-bit dump).
		parts.push(node.value ? "TRUE" : "FALSE");
	} else if (node.value !== undefined) {
		parts.push(String(node.value));
	}
	if (node.hex && node.value !== undefined && typeof node.value !== "string") {
		parts.push(`· ${node.hex}`);
	} else if (node.hex && node.value === undefined) {
		parts.push(node.hex);
	}
	if (node.enumLabel) {
		parts.push(`(${node.enumLabel})`);
	}
	if (node.unit) {
		parts.push(node.unit);
	}
	if (node.bits) {
		parts.push(`[${node.bits.width}b]`);
	}
	return parts.join(" ");
}

/**
 * One row of the decoded value tree. Branch nodes (structs / arrays) use a
 * native <details> so the tree is collapsible with zero extra state; leaves show
 * `name : value`. Clicking any row reveals and selects the node's bytes.
 */
const NvmDecodedRow: React.FC<{ node: NvmDecodedNode; depth: number; defaultOpen?: boolean }> = ({
	node,
	depth,
	defaultOpen,
}) => {
	const ctx = useDisplayContext();
	const setOffset = useSetRecoilState(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);
	const hasChildren = !!node.children && node.children.length > 0;

	const reveal = (e: React.MouseEvent) => {
		e.stopPropagation();
		setOffset(select.startOfRowContainingByte(node.offset, columnWidth));
		ctx.focusedElement = new FocusedElement(false, node.offset);
		if (node.length > 0) {
			ctx.setSelectionRanges([Range.inclusive(node.offset, node.offset + node.length - 1)]);
		}
	};

	const indent = { paddingLeft: `${depth * 12}px` };

	if (hasChildren) {
		// A node may carry BOTH a summary value (e.g. a bitflags byte `0x1B`) and
		// children (the expanded bits). Prefer showing that summary; else the type.
		const summary = formatNodeValue(node);
		return (
			<details className={style.nvmDecodedBranch} open={defaultOpen}>
				<summary style={indent} onClick={reveal}>
					<span className={style.nvmDecodedName}>{node.name}</span>
					<span className={style.nvmDecodedMeta}>
						{summary || node.type}
						{!summary && node.children!.length ? ` · ${node.children!.length}` : ""}
					</span>
				</summary>
				{node.children!.map((child, i) => (
					<NvmDecodedRow
						key={`${child.name}:${child.offset}:${i}`}
						node={child}
						depth={depth + 1}
						defaultOpen={defaultOpen}
					/>
				))}
			</details>
		);
	}

	return (
		<div className={style.nvmDecodedLeaf} style={indent} onClick={reveal} title="Reveal bytes">
			<span className={style.nvmDecodedName}>{node.name}</span>
			<span className={style.nvmDecodedValue}>{formatNodeValue(node)}</span>
		</div>
	);
};

/**
 * Renders a block's business-decoded value tree (produced by the engine from a
 * struct definition). Vendor-blind: the webview only lays out the tree the
 * engine emitted; it never decodes anything itself.
 */
const NvmDecodedTree: React.FC<{ nodes: NvmDecodedNode[] }> = ({ nodes }) => (
	<div className={style.nvmDecoded}>
		<div className={style.nvmDecodedTitle}>Decoded</div>
		{nodes.map((node, i) => (
			<NvmDecodedRow key={`${node.name}:${node.offset}:${i}`} node={node} depth={0} defaultOpen />
		))}
	</div>
);

/**
 * Explains the byte at `offset` in terms of the parsed NVM layout: which block
 * and attribute (field) it belongs to, plus its raw value down to the bit.
 */
const NvmByteExplain: React.FC<{ offset: number }> = ({ offset }) => {
	const ranges = useRecoilValue(select.nvmFieldRanges);
	const ctx = useDisplayContext();
	const setOffset = useSetRecoilState(select.offset);
	const columnWidth = useRecoilValue(select.columnWidth);
	const field = useMemo(
		() => ranges.find(r => offset >= r.start && offset < r.end),
		[ranges, offset],
	);
	const bytes = useFileBytes(offset, 1);
	if (!field) {
		return null;
	}
	const value = bytes.length ? bytes[0] : undefined;
	return (
		<div className={style.nvmByteExplain}>
			<div className={style.nvmByteRow}>
				<span className={style.nvmByteName} title={field.block.name ?? field.block.id}>
					{field.fieldName}
				</span>
				<span className={style.nvmByteKind}>{field.kind}</span>
			</div>
			<div className={style.nvmByteSub}>
				byte 0x{offset.toString(16).toUpperCase()} · field 0x
				{field.start.toString(16).toUpperCase()}–0x{field.end.toString(16).toUpperCase()} (
				{field.end - field.start} B)
				{value !== undefined && (
					<>
						{" · "}
						<span className={style.nvmByteVal}>
							0x{value.toString(16).padStart(2, "0").toUpperCase()} · {value} ·{" "}
							{value.toString(2).padStart(8, "0")}b
						</span>
					</>
				)}
			</div>
			{field.link && (
				<button
					className={style.nvmLinkBtn}
					onClick={() => {
						setOffset(select.startOfRowContainingByte(field.link!.targetOffset, columnWidth));
						ctx.focusedElement = new FocusedElement(false, field.link!.targetOffset);
					}}
				>
					→ Jump to 0x{field.link.targetOffset.toString(16).toUpperCase()}
					{field.link.label ? ` (${field.link.label})` : ""}
				</button>
			)}
		</div>
	);
};

/** Inner contents of the data inspector, reused between the hover and aside inspector views. */
const InspectorContents: React.FC<{
	offset: number;
	columns: number;
	/** When a decoded block is in view, give it the spotlight and collapse the
	 * primitive-types grid by default (it is secondary to the business decode). */
	preferDecoded?: boolean;
}> = ({ offset, columns, preferDecoded }) => {
	const defaultEndianness = useRecoilValue(select.editorSettings).defaultEndianness;
	const [endianness, setEndianness] = usePersistedState("endianness", defaultEndianness);
	// Remember whether the primitive-types group is expanded. It defaults open in
	// plain-hex use, but collapsed when a decoded block is present so the decoded
	// tree gets the space; each mode persists its own open state.
	const [typesOpen, setTypesOpen] = usePersistedState(
		preferDecoded ? "dataInspectorTypesOpenNvm" : "dataInspectorTypesOpen",
		!preferDecoded,
	);
	const target = useFileBytes(offset, lookahead);
	const dv = new DataView(target.buffer);
	const le = endianness === Endianness.Little;

	return (
		<>
			<NvmByteExplain offset={offset} />
			<details
				className={style.typesSection}
				open={typesOpen}
				onToggle={e => setTypesOpen((e.target as HTMLDetailsElement).open)}
			>
				<summary>Primitive types</summary>
				<dl
					className={style.types}
					style={{ gridTemplateColumns: "max-content ".repeat(columns) }}
				>
					{inspectableTypes.map(({ label, convert, minBytes }) => (
						<React.Fragment key={label}>
							<dt>{label}</dt>
							<dd>
								{target.length < minBytes ? (
									<span style={{ opacity: 0.8 }}>End of File</span>
								) : (
									convert(dv, le)
								)}
							</dd>
						</React.Fragment>
					))}
				</dl>
				<EndiannessToggle endianness={endianness} setEndianness={setEndianness} />
			</details>
		</>
	);
};

/** Controlled checkbox that toggles between little and big endian. */
const EndiannessToggle: React.FC<{
	endianness: Endianness;
	setEndianness: (e: Endianness) => void;
}> = ({ endianness, setEndianness }) => (
	<div className={style.endiannessToggleContainer}>
		<input
			type="checkbox"
			id="endian-checkbox"
			checked={endianness === Endianness.Little}
			onChange={evt => setEndianness(evt.target.checked ? Endianness.Little : Endianness.Big)}
		/>
		<label htmlFor="endian-checkbox">{strings.littleEndian}</label>
	</div>
);
