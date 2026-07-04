import React, { Suspense, useEffect, useMemo, useState } from "react";
// recoil imports below
import { useRecoilValue, useSetRecoilState } from "recoil";
import { Endianness } from "../../shared/protocol";
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
					<h3>{selectedBlock.name ?? selectedBlock.id}</h3>
					<dl>
						<dt>Offset</dt>
						<dd>{selectedBlock.offset}</dd>
						<dt>Length</dt>
						<dd>{selectedBlock.length}</dd>
					</dl>
					<div style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 200 }}>
						<code>{JSON.stringify(selectedBlock.raw ?? {}, null, 2)}</code>
					</div>
					<div style={{ marginTop: 8 }}>
						<button
							onClick={() => {
								// reveal block start in view and focus it
								setOffset(select.startOfRowContainingByte(selectedBlock.offset, columnWidth));
								ctx.focusedElement = new FocusedElement(false, selectedBlock.offset);
							}}
						>
							Reveal Block
						</button>
					</div>
				</div>
			) : null}

			{inspected ? <InspectorContents columns={2} offset={inspected.byte} /> : null}
		</Suspense>
	);
};

const lookahead = 16;

/**
 * Explains the byte at `offset` in terms of the parsed NVM layout: which block
 * and attribute (field) it belongs to, plus its raw value down to the bit.
 */
const NvmByteExplain: React.FC<{ offset: number }> = ({ offset }) => {
	const ranges = useRecoilValue(select.nvmFieldRanges);
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
		<div className={style.nvmInspector}>
			<h3>{field.block.name ?? field.block.id}</h3>
			<dl>
				<dt>Attribute</dt>
				<dd>{field.fieldName}</dd>
				<dt>Kind</dt>
				<dd>{field.kind}</dd>
				<dt>Byte</dt>
				<dd>
					0x{offset.toString(16).toUpperCase()} (field 0x{field.start.toString(16).toUpperCase()}–0x
					{field.end.toString(16).toUpperCase()}, {field.end - field.start} B)
				</dd>
				{value !== undefined && (
					<>
						<dt>Value</dt>
						<dd>
							0x{value.toString(16).padStart(2, "0").toUpperCase()} · {value} ·{" "}
							{value.toString(2).padStart(8, "0")}b
						</dd>
					</>
				)}
			</dl>
		</div>
	);
};

/** Inner contents of the data inspector, reused between the hover and aside inspector views. */
const InspectorContents: React.FC<{
	offset: number;
	columns: number;
}> = ({ offset, columns }) => {
	const defaultEndianness = useRecoilValue(select.editorSettings).defaultEndianness;
	const [endianness, setEndianness] = usePersistedState("endianness", defaultEndianness);
	const target = useFileBytes(offset, lookahead);
	const dv = new DataView(target.buffer);
	const le = endianness === Endianness.Little;

	return (
		<>
			<NvmByteExplain offset={offset} />
			<dl className={style.types} style={{ gridTemplateColumns: "max-content ".repeat(columns) }}>
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
