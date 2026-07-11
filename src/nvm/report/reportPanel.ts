// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Report preview: a webview panel that renders the Markdown analysis report as
 * styled HTML and can export it as Markdown, standalone HTML, PDF (via the
 * system print dialog) or a single long PNG image. Vendor-agnostic — it only
 * consumes the generic report markdown.
 */

import * as vscode from "vscode";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "../annotations/annotationService";
import { buildActiveReport } from "./reportCommands";

let currentPanel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the report preview for the active dump. */
export async function openReportPreview(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): Promise<void> {
	const report = await buildActiveReport(registry, annotations);
	if (!report) {
		void vscode.window.showWarningMessage("Open an NVM dump first to preview a report.");
		return;
	}

	const bodyHtml = markdownToHtml(report.markdown);
	const baseName = report.fileName.replace(/\.[^.]+$/, "");

	if (!currentPanel) {
		currentPanel = vscode.window.createWebviewPanel(
			"nvmStudio.nvmReport",
			`NVM Report — ${report.fileName}`,
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		currentPanel.onDidDispose(() => (currentPanel = undefined));
		currentPanel.webview.onDidReceiveMessage(msg =>
			handleMessage(msg, () => ({ report, bodyHtml, baseName })),
		);
	} else {
		currentPanel.reveal(vscode.ViewColumn.Beside);
	}

	currentPanel.title = `NVM Report — ${report.fileName}`;
	currentPanel.webview.html = renderPage(currentPanel.webview, bodyHtml);
}

interface ReportCtx {
	report: { fileName: string; markdown: string; docUri: vscode.Uri };
	bodyHtml: string;
	baseName: string;
}

async function handleMessage(
	msg: { type: string; dataUrl?: string },
	getCtx: () => ReportCtx,
): Promise<void> {
	const { report, bodyHtml, baseName } = getCtx();
	const dir = report.docUri.with({ path: report.docUri.path.replace(/\/[^/]+$/, "") });
	const save = (ext: string, filters: Record<string, string[]>) =>
		vscode.window.showSaveDialog({
			title: "Export NVM report",
			defaultUri: vscode.Uri.joinPath(dir, `${baseName}.report.${ext}`),
			filters,
		});

	switch (msg.type) {
		case "exportMd": {
			const target = await save("md", { Markdown: ["md"] });
			if (target) {
				await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(report.markdown));
				void vscode.window.showInformationMessage(`Report exported: ${target.fsPath}`);
			}
			break;
		}
		case "exportHtml": {
			const target = await save("html", { HTML: ["html"] });
			if (target) {
				const html = standaloneHtml(report.fileName, bodyHtml);
				await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
				void vscode.window.showInformationMessage(`Report exported: ${target.fsPath}`);
			}
			break;
		}
		case "exportImage": {
			if (!msg.dataUrl) {
				void vscode.window.showErrorMessage("Image capture failed (empty).");
				return;
			}
			const target = await save("png", { PNG: ["png"] });
			if (target) {
				const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, "");
				await vscode.workspace.fs.writeFile(target, Buffer.from(base64, "base64"));
				void vscode.window.showInformationMessage(`Report image exported: ${target.fsPath}`);
			}
			break;
		}
		case "imageError":
			void vscode.window.showErrorMessage(
				"Could not capture a long image of this report. Try exporting HTML or PDF instead.",
			);
			break;
	}
}

/** Register the report preview + export commands. */
export function registerReportPreview(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand("nvmStudio.nvm.openReportPreview", () =>
			openReportPreview(registry, annotations),
		),
	];
}

// --- rendering helpers ---

const reportCss = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); padding: 0; margin: 0; }
.toolbar {
	position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; padding: 8px 12px;
	background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border);
}
.toolbar button {
	background: var(--vscode-button-background); color: var(--vscode-button-foreground);
	border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px;
}
.toolbar button:hover { background: var(--vscode-button-hoverBackground); }
#report { padding: 16px 24px; max-width: 960px; }
#report h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
#report table { border-collapse: collapse; margin: 8px 0; }
#report th, #report td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
#report code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
#report blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 8px 0; padding-left: 10px; opacity: .85; }
@media print { .toolbar { display: none; } }
`;

function renderPage(webview: vscode.Webview, bodyHtml: string): string {
	const nonce = String(Math.random()).slice(2);
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${reportCss}</style>
</head>
<body>
<div class="toolbar">
	<button id="md">Export MD</button>
	<button id="html">Export HTML</button>
	<button id="pdf">Export PDF</button>
	<button id="img">Export Long Image</button>
</div>
<div id="report">${bodyHtml}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('md').onclick = () => vscode.postMessage({ type: 'exportMd' });
document.getElementById('html').onclick = () => vscode.postMessage({ type: 'exportHtml' });
document.getElementById('pdf').onclick = () => window.print();
document.getElementById('img').onclick = async () => {
	try {
		const node = document.getElementById('report');
		const rect = node.getBoundingClientRect();
		const width = Math.ceil(rect.width);
		const height = Math.ceil(node.scrollHeight);
		const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
		// Serialize the report DOM into an SVG foreignObject, then rasterize to canvas.
		const clone = node.cloneNode(true);
		const styleEl = document.createElement('style');
		styleEl.textContent = \`${reportCss.replace(/`/g, "\\`")}\`;
		const wrapper = document.createElement('div');
		wrapper.appendChild(styleEl);
		wrapper.appendChild(clone);
		const xhtml = new XMLSerializer().serializeToString(wrapper);
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
			'<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">' + xhtml + '</div></foreignObject></svg>';
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = width; canvas.height = height;
			const c = canvas.getContext('2d');
			c.fillStyle = bg; c.fillRect(0, 0, width, height);
			c.drawImage(img, 0, 0);
			vscode.postMessage({ type: 'exportImage', dataUrl: canvas.toDataURL('image/png') });
		};
		img.onerror = () => vscode.postMessage({ type: 'imageError' });
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	} catch (e) {
		vscode.postMessage({ type: 'imageError' });
	}
};
</script>
</body>
</html>`;
}

function standaloneHtml(title: string, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; }
h1 { border-bottom: 1px solid #ccc; padding-bottom: 6px; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; }
code { background: #f3f3f3; padding: 1px 4px; border-radius: 3px; }
blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding-left: 10px; color: #555; }
</style></head><body>${bodyHtml}</body></html>`;
}

// --- minimal Markdown → HTML (headings, bold/italic/code, tables, lists, quotes) ---

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inline(s: string): string {
	return escapeHtml(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
		.replace(/_([^_]+)_/g, "<em>$1</em>");
}

export function markdownToHtml(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let i = 0;
	let inList = false;
	const closeList = () => {
		if (inList) {
			out.push("</ul>");
			inList = false;
		}
	};

	while (i < lines.length) {
		const line = lines[i];

		// Table: header row followed by a separator row.
		if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
			closeList();
			const header = splitRow(line);
			i += 2;
			out.push("<table><thead><tr>", ...header.map(h => `<th>${inline(h)}</th>`), "</tr></thead><tbody>");
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
				const cells = splitRow(lines[i]);
				out.push("<tr>", ...cells.map(c => `<td>${inline(c)}</td>`), "</tr>");
				i++;
			}
			out.push("</tbody></table>");
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			closeList();
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			i++;
			continue;
		}

		if (/^\s*[-*]\s+/.test(line)) {
			if (!inList) {
				out.push("<ul>");
				inList = true;
			}
			out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
			i++;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			closeList();
			out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
			i++;
			continue;
		}

		if (line.trim() === "") {
			closeList();
			i++;
			continue;
		}

		closeList();
		out.push(`<p>${inline(line)}</p>`);
		i++;
	}
	closeList();
	return out.join("\n");
}

function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map(c => c.trim().replace(/\\\|/g, "|"));
}
