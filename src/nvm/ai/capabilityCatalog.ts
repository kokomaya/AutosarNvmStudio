// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The single, vendor-blind catalog of what NVM Studio can do, grouped for the
 * "NVM: Show Capabilities" quick pick. This is the ONE source of truth for the
 * user-facing capability list — adding a capability means adding an entry here
 * (OCP), never scattering descriptions across the UI.
 *
 * It is pure data (no vscode import) so it can be unit-tested and reused. Entries
 * name generic capabilities only; nothing here encodes a vendor or use-case.
 */

/** A functional grouping shown as a separator in the quick pick. */
export type CapabilityGroup =
	| "AI tools (Copilot)"
	| "Views"
	| "Annotations"
	| "Layout & configuration";

/** One capability the plugin exposes. */
export interface CapabilityEntry {
	group: CapabilityGroup;
	/** Short label, e.g. "Search blocks". */
	label: string;
	/** One-line description of what it does. */
	detail: string;
	/** A Copilot `#tool` reference, when this capability is an LM tool. */
	toolRef?: string;
	/** A command id to run when the user selects this entry. */
	commandId?: string;
	/** A repo-relative doc path to open when selected (if no commandId). */
	docPath?: string;
}

/**
 * The catalog. Kept in declaration order within each group; the quick pick adds
 * group separators. Descriptions mirror the LM tool `modelDescription`s and the
 * facade methods so the list stays truthful to what actually ships.
 */
export const CAPABILITY_CATALOG: readonly CapabilityEntry[] = [
	// --- AI tools (the NvmCapabilities facade, surfaced as Language Model Tools) ---
	{
		group: "AI tools (Copilot)",
		label: "List blocks",
		detail: "List parsed NVM blocks (paged, capped).",
		toolRef: "#nvmListBlocks",
	},
	{
		group: "AI tools (Copilot)",
		label: "Search blocks",
		detail: "Filter blocks by name/id substring or a byte offset (paged).",
		toolRef: "#nvmSearchBlocks",
	},
	{
		group: "AI tools (Copilot)",
		label: "Analyze block",
		detail: "Fields + capped metadata of one block by name.",
		toolRef: "#nvmAnalyzeBlock",
	},
	{
		group: "AI tools (Copilot)",
		label: "Get decoded fields",
		detail: "A depth/node-capped decoded value tree for one block.",
		toolRef: "#nvmGetDecoded",
	},
	{
		group: "AI tools (Copilot)",
		label: "Read bytes",
		detail: "Read a bounded byte window (≤4096 B) as hex.",
		toolRef: "#nvmReadBytes",
	},
	{
		group: "AI tools (Copilot)",
		label: "List annotations",
		detail: "List your bookmarks, tags and notes (capped).",
		toolRef: "#nvmListAnnotations",
	},
	{
		group: "AI tools (Copilot)",
		label: "Create note",
		detail: "Create one anchored note (asks for confirmation before writing).",
		toolRef: "#nvmCreateNote",
	},
	{
		group: "AI tools (Copilot)",
		label: "Export report",
		detail: "Generate the Markdown analysis report (truncated if long).",
		toolRef: "#nvmExportReport",
	},
	{
		group: "AI tools (Copilot)",
		label: "Risk detection",
		detail: "Heuristic checks (unresolved names, zero-length, overlaps).",
		toolRef: "#nvmRiskDetection",
	},
	{
		group: "AI tools (Copilot)",
		label: "Ask NVM AI",
		detail: "Open Copilot Chat prefilled with @nvm (edit, then send).",
		commandId: "hexEditor.nvm.openChat",
	},

	// --- Views ---
	{
		group: "Views",
		label: "Blocks table",
		detail: "Sortable, searchable, lazy-loaded table of all blocks.",
	},
	{
		group: "Views",
		label: "Custom views",
		detail: "Compose blocks into comparison tables (fingerprint / name family / manual union).",
		docPath: "docs/features_list.md",
	},
	{
		group: "Views",
		label: "Data inspector",
		detail: "Per-byte primitives + a block's decoded business fields.",
	},

	// --- Annotations ---
	{
		group: "Annotations",
		label: "Add bookmark",
		detail: "Bookmark the focused byte for quick jump.",
		commandId: "hexEditor.nvm.addBookmarkHere",
	},
	{
		group: "Annotations",
		label: "Add note",
		detail: "Attach a rich Markdown note to the current selection.",
		commandId: "hexEditor.nvm.addNoteHere",
	},

	// --- Layout & configuration ---
	{
		group: "Layout & configuration",
		label: "Layout providers & config",
		detail: "How *.nvmlayout.json descriptors, adapters and engines drive parsing.",
		docPath: "docs/nvm-layout-providers.md",
	},
	{
		group: "Layout & configuration",
		label: "AI capabilities reference",
		detail: "The full capability facade: inputs, output shapes, data caps, ownership.",
		docPath: "docs/nvm-ai-capabilities.md",
	},
];
