// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The "Export Report" command: renders a Markdown analysis report for the active
 * dump from its parsed blocks + the user's annotations, then saves/opens it.
 */

import * as vscode from "vscode";
import { NvmBlockInfo } from "../../../shared/protocol";
import { HexEditorRegistry } from "../../hexEditorRegistry";
import { AnnotationService } from "../annotations/annotationService";
import { generateReport } from "./reportGenerator";

/** Build the report markdown for the active dump. Exported for reuse by AI tools. */
export async function buildActiveReport(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
	aiSummary?: string,
): Promise<{ fileName: string; markdown: string; docUri: vscode.Uri } | undefined> {
	const doc = registry.activeDocument;
	if (!doc) {
		return undefined;
	}
	const blocks = registry.getNvmBlocks(doc) as NvmBlockInfo[];
	const set = await annotations.get(doc.uri);
	const noteBodies = new Map<string, string>();
	for (const note of set.notes) {
		noteBodies.set(note.id, await annotations.readNote(doc.uri, note.id));
	}
	const fileName = doc.uri.path.replace(/^.*\//, "");
	const markdown = generateReport({ fileName, blocks, annotations: set, noteBodies, aiSummary });
	return { fileName, markdown, docUri: doc.uri };
}

export function registerReportCommands(
	registry: HexEditorRegistry,
	annotations: AnnotationService,
): vscode.Disposable[] {
	const exportReport = vscode.commands.registerCommand("hexEditor.nvm.exportReport", async () => {
		const report = await buildActiveReport(registry, annotations);
		if (!report) {
			void vscode.window.showWarningMessage("Open an NVM dump first to export a report.");
			return;
		}
		const target = await vscode.window.showSaveDialog({
			title: "Export NVM report",
			defaultUri: report.docUri.with({ path: `${report.docUri.path}.report.md` }),
			filters: { Markdown: ["md"] },
		});
		if (!target) {
			return;
		}
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(report.markdown));
		await vscode.window.showTextDocument(target, { preview: false });
	});

	return [exportReport];
}
