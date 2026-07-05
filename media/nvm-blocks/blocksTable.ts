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

/** Cap on rows rendered to the DOM at once — keeps large dumps (hundreds of
 * historical chunks) responsive without full virtualization. */
const MAX_RENDERED_ROWS = 500;

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

function render(): void {
	if (columns.length === 0) {
		tableWrap.innerHTML = "";
		statusEl.textContent = "No blocks loaded for the active dump.";
		return;
	}
	const visible = sortRows(rows.filter(matches));
	const shown = visible.length > MAX_RENDERED_ROWS ? visible.slice(0, MAX_RENDERED_ROWS) : visible;
	statusEl.textContent =
		shown.length < visible.length
			? `showing ${shown.length} of ${visible.length} (filtered from ${rows.length}) — refine search to see more`
			: `${visible.length} / ${rows.length} blocks`;

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const htr = document.createElement("tr");
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

	const tbody = document.createElement("tbody");
	for (const row of shown) {
		const tr = document.createElement("tr");
		if (row.isLatest) {
			tr.classList.add("latest");
		}
		tr.addEventListener("click", () => {
			vscodeApi.postMessage({ type: "jump", offset: row.offset });
		});
		for (const c of columns) {
			const td = document.createElement("td");
			td.textContent = String(row.cells[c.key] ?? "");
			if (c.numeric) {
				td.classList.add("numeric");
			}
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);

	tableWrap.replaceChildren(table);
}

vscodeApi.postMessage({ type: "ready" });
root.classList.add("ready");
