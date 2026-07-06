// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Webview script for the "Custom Views" panel — renders a user-composed view as
 * one sub-table per block group. Each group is a family of structurally-matching
 * blocks (e.g. Record0/1/2) laid out as rows with auto-derived columns. It is a
 * dumb renderer: the extension resolves the vendor-neutral view model and posts
 * it here; the webview switches views and asks the host to jump to a byte range
 * or mutate a view. Views are created/extended from the "Add to Custom View"
 * affordances (Blocks Table row +, Blocks tree menu, Data Inspector button).
 */

interface Cell {
	text: string;
	offset?: number;
	length?: number;
}
interface Column {
	key: string;
	label: string;
}
interface Row {
	blockLabel: string;
	blockOffset: number;
	cells: Record<string, Cell>;
}
interface Group {
	key: string;
	label: string;
	columns: Column[];
	rows: Row[];
	matchedBlocks: number;
}
interface ResolvedView {
	id: string;
	name: string;
	scope: "dump" | "template";
	groups: Group[];
}
interface Model {
	type: "model";
	views: ResolvedView[];
	activeId?: string;
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

let views: ResolvedView[] = [];
let activeId: string | undefined;

const select = document.getElementById("view-select") as HTMLSelectElement;
const tableWrap = document.getElementById("table-wrap") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const btnRename = document.getElementById("btn-rename") as HTMLButtonElement;
const btnPromote = document.getElementById("btn-promote") as HTMLButtonElement;
const btnDelete = document.getElementById("btn-delete") as HTMLButtonElement;

/** Cap on rows rendered per group (mirrors the Blocks Table). */
const MAX_RENDERED_ROWS = 500;

function active(): ResolvedView | undefined {
	return views.find(v => v.id === activeId);
}

select.addEventListener("change", () => {
	activeId = select.value;
	vscodeApi.postMessage({ type: "select", viewId: activeId });
});
btnRename.addEventListener("click", () => {
	const v = active();
	if (v) {
		vscodeApi.postMessage({ type: "rename", viewId: v.id });
	}
});
btnPromote.addEventListener("click", () => {
	const v = active();
	if (v) {
		vscodeApi.postMessage({ type: "promote", viewId: v.id });
	}
});
btnDelete.addEventListener("click", () => {
	const v = active();
	if (v) {
		vscodeApi.postMessage({ type: "delete", viewId: v.id });
	}
});

window.addEventListener("message", e => {
	const msg = e.data as Model;
	if (msg?.type === "model") {
		views = msg.views ?? [];
		activeId = msg.activeId ?? views[0]?.id;
		render();
	}
});

function renderSelect(): void {
	select.replaceChildren();
	for (const v of views) {
		const opt = document.createElement("option");
		opt.value = v.id;
		opt.textContent = v.scope === "template" ? `${v.name} (template)` : v.name;
		if (v.id === activeId) {
			opt.selected = true;
		}
		select.appendChild(opt);
	}
	const disabled = views.length === 0;
	select.disabled = disabled;
	btnRename.disabled = disabled;
	btnPromote.disabled = disabled;
	btnDelete.disabled = disabled;
}

function jump(offset: number | undefined): void {
	if (typeof offset === "number") {
		vscodeApi.postMessage({ type: "jump", offset });
	}
}

/** Render one group's sub-table. */
function renderGroup(view: ResolvedView, group: Group): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "group";

	const header = document.createElement("div");
	header.className = "group-header";
	const title = document.createElement("span");
	title.className = "group-title";
	title.textContent = `${group.label} · ${group.matchedBlocks} block${group.matchedBlocks === 1 ? "" : "s"}`;
	header.appendChild(title);
	const del = document.createElement("button");
	del.className = "group-del";
	del.textContent = "✕";
	del.title = "Remove this group from the view";
	del.addEventListener("click", () =>
		vscodeApi.postMessage({ type: "deleteGroup", viewId: view.id, groupKey: group.key }),
	);
	header.appendChild(del);
	wrap.appendChild(header);

	if (group.rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "group-empty";
		empty.textContent = "No matching blocks in the active dump.";
		wrap.appendChild(empty);
		return wrap;
	}

	const shown =
		group.rows.length > MAX_RENDERED_ROWS ? group.rows.slice(0, MAX_RENDERED_ROWS) : group.rows;

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const htr = document.createElement("tr");
	const blkTh = document.createElement("th");
	blkTh.textContent = "Block";
	htr.appendChild(blkTh);
	for (const c of group.columns) {
		const th = document.createElement("th");
		th.textContent = c.label;
		htr.appendChild(th);
	}
	thead.appendChild(htr);
	table.appendChild(thead);

	const tbody = document.createElement("tbody");
	for (const row of shown) {
		const tr = document.createElement("tr");
		const blkTd = document.createElement("td");
		blkTd.className = "block-cell";
		blkTd.textContent = row.blockLabel;
		blkTd.addEventListener("click", () => jump(row.blockOffset));
		tr.appendChild(blkTd);
		for (const c of group.columns) {
			const td = document.createElement("td");
			const cell = row.cells[c.key];
			td.textContent = cell?.text ?? "";
			if (cell && typeof cell.offset === "number") {
				td.classList.add("clickable");
				td.addEventListener("click", () => jump(cell.offset));
			}
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	wrap.appendChild(table);

	if (shown.length < group.rows.length) {
		const more = document.createElement("div");
		more.className = "group-empty";
		more.textContent = `showing ${shown.length} of ${group.rows.length} rows`;
		wrap.appendChild(more);
	}
	return wrap;
}

function render(): void {
	renderSelect();
	const view = active();
	if (!view) {
		tableWrap.replaceChildren();
		statusEl.textContent =
			views.length === 0
				? "No custom views yet — click + on a block in the Blocks Table, or right-click a block in Blocks, to start one."
				: "";
		return;
	}
	if (view.groups.length === 0) {
		tableWrap.replaceChildren();
		statusEl.textContent = "This view has no blocks yet.";
		return;
	}
	statusEl.textContent = `${view.groups.length} group${view.groups.length === 1 ? "" : "s"}`;
	const frag = document.createDocumentFragment();
	for (const g of view.groups) {
		frag.appendChild(renderGroup(view, g));
	}
	tableWrap.replaceChildren(frag);
}

vscodeApi.postMessage({ type: "ready" });
document.getElementById("root")?.classList.add("ready");

// Make this file a module so its top-level declarations don't collide with the
// other plain-DOM webview script (blocksTable.ts) in the shared global scope.
export {};
