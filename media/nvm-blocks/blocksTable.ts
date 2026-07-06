// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Webview script for the "Blocks Table" — a multi-column, sortable, searchable
 * table of the active dump's NVM blocks. It is a dumb renderer: the extension
 * computes the vendor-neutral column/row model and posts it here; clicking a row
 * asks the extension to jump the hex editor to that block.
 */

interface Column {
	key: string;
	label: string;
	numeric?: boolean;
}

interface Row {
	offset: number;
	isLatest?: boolean;
	cells: Record<string, string | number>;
}

interface Model {
	type: "model";
	columns: Column[];
	rows: Row[];
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

let columns: Column[] = [];
let rows: Row[] = [];
let sortKey: string | undefined;
let sortDir: 1 | -1 = 1;
let filterText = "";

const root = document.getElementById("root") as HTMLElement;
const search = document.getElementById("search") as HTMLInputElement;
const tableWrap = document.getElementById("table-wrap") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

/** How many rows to append per chunk while scrolling — keeps the initial paint
 * cheap on large dumps (thousands of chunks) yet makes every row reachable by
 * scrolling (incremental "lazy load", no hard cap). */
const RENDER_CHUNK = 400;
/** Start loading the next chunk when the viewport is within this many px of the
 * bottom, so appended rows are ready before the user reaches them. */
const SCROLL_THRESHOLD_PX = 300;

/** The current filtered+sorted rows and how many of them are in the DOM. */
let visibleRows: Row[] = [];
let renderedCount = 0;
let tbodyEl: HTMLTableSectionElement | undefined;

// Debounce the filter so typing over a large table doesn't rebuild the DOM on
// every keystroke.
let filterTimer: ReturnType<typeof setTimeout> | undefined;
search.addEventListener("input", () => {
	if (filterTimer !== undefined) {
		clearTimeout(filterTimer);
	}
	filterTimer = setTimeout(() => {
		filterText = search.value.trim().toLowerCase();
		render();
	}, 150);
});

window.addEventListener("message", e => {
	const msg = e.data as Model;
	if (msg?.type === "model") {
		columns = msg.columns ?? [];
		rows = msg.rows ?? [];
		if (sortKey && !columns.some(c => c.key === sortKey)) {
			sortKey = undefined;
		}
		render();
	}
});

function matches(row: Row): boolean {
	if (!filterText) {
		return true;
	}
	for (const c of columns) {
		if (String(row.cells[c.key] ?? "").toLowerCase().includes(filterText)) {
			return true;
		}
	}
	return false;
}

function sortRows(list: Row[]): Row[] {
	if (!sortKey) {
		return list;
	}
	const key = sortKey;
	const col = columns.find(c => c.key === key);
	const numeric = col?.numeric ?? false;
	return [...list].sort((a, b) => {
		const av = a.cells[key];
		const bv = b.cells[key];
		let cmp: number;
		if (numeric) {
			cmp = (Number(av) || 0) - (Number(bv) || 0);
		} else {
			cmp = String(av ?? "").localeCompare(String(bv ?? ""));
		}
		return cmp * sortDir;
	});
}

/** Build one table row element for a block. */
function buildRow(row: Row): HTMLTableRowElement {
	const tr = document.createElement("tr");
	if (row.isLatest) {
		tr.classList.add("latest");
	}
	tr.addEventListener("click", () => {
		vscodeApi.postMessage({ type: "jump", offset: row.offset });
	});
	// Leading "+" cell: add this block (and its structural family) to a view.
	const addTd = document.createElement("td");
	addTd.className = "add-cell";
	const addBtn = document.createElement("button");
	addBtn.className = "add-btn";
	addBtn.textContent = "+";
	addBtn.title = "Add this block (and matching blocks) to a custom view";
	addBtn.addEventListener("click", e => {
		e.stopPropagation();
		vscodeApi.postMessage({ type: "addToView", offset: row.offset });
	});
	addTd.appendChild(addBtn);
	tr.appendChild(addTd);
	for (const c of columns) {
		const td = document.createElement("td");
		td.textContent = String(row.cells[c.key] ?? "");
		if (c.numeric) {
			td.classList.add("numeric");
		}
		tr.appendChild(td);
	}
	return tr;
}

/** Update the status line to reflect how much of the filtered set is in the DOM. */
function updateStatus(): void {
	const total = visibleRows.length;
	if (renderedCount >= total) {
		statusEl.textContent =
			total === rows.length ? `${total} blocks` : `${total} / ${rows.length} blocks (filtered)`;
	} else {
		statusEl.textContent = `${renderedCount} of ${total} shown — scroll to load more`;
	}
}

/** Append the next chunk of filtered rows to the DOM (lazy load on scroll). */
function appendChunk(): void {
	if (!tbodyEl || renderedCount >= visibleRows.length) {
		return;
	}
	const end = Math.min(renderedCount + RENDER_CHUNK, visibleRows.length);
	const frag = document.createDocumentFragment();
	for (let i = renderedCount; i < end; i++) {
		frag.appendChild(buildRow(visibleRows[i]));
	}
	tbodyEl.appendChild(frag);
	renderedCount = end;
	updateStatus();
}

// Lazy-load the next chunk as the user nears the bottom of the scroll container.
tableWrap.addEventListener("scroll", () => {
	if (renderedCount >= visibleRows.length) {
		return;
	}
	const remaining = tableWrap.scrollHeight - tableWrap.scrollTop - tableWrap.clientHeight;
	if (remaining <= SCROLL_THRESHOLD_PX) {
		appendChunk();
	}
});

function render(): void {
	if (columns.length === 0) {
		tableWrap.replaceChildren();
		tbodyEl = undefined;
		statusEl.textContent = "No blocks loaded for the active dump.";
		return;
	}
	visibleRows = sortRows(rows.filter(matches));
	renderedCount = 0;

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const htr = document.createElement("tr");
	// Leading action column (the per-row "add to custom view" +).
	htr.appendChild(document.createElement("th"));
	for (const c of columns) {
		const th = document.createElement("th");
		th.textContent = c.label;
		if (c.key === sortKey) {
			th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
		}
		th.addEventListener("click", () => {
			if (sortKey === c.key) {
				sortDir = sortDir === 1 ? -1 : 1;
			} else {
				sortKey = c.key;
				sortDir = 1;
			}
			render();
		});
		htr.appendChild(th);
	}
	thead.appendChild(htr);
	table.appendChild(thead);

	tbodyEl = document.createElement("tbody");
	table.appendChild(tbodyEl);
	tableWrap.replaceChildren(table);
	tableWrap.scrollTop = 0;

	appendChunk();
	// After the first paint, keep filling until the container actually scrolls, so
	// short viewports with few rows don't get stuck waiting for a scroll event.
	while (
		renderedCount < visibleRows.length &&
		tableWrap.scrollHeight <= tableWrap.clientHeight + SCROLL_THRESHOLD_PX
	) {
		appendChunk();
	}
}

vscodeApi.postMessage({ type: "ready" });
root.classList.add("ready");
