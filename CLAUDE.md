# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Microsoft's `vscode-hexeditor` VS Code extension (a custom editor for viewing/editing files as
hex), **extended into "NVM Studio"** — a config-driven, vendor-agnostic, AI-assisted AUTOSAR
NVM (non-volatile memory) dump analysis platform. Most active development is in the NVM layers;
the stock hex editor is the substrate it renders on.

## Commands

```bash
npm install                # deps (Node >= 12.x, x64)
npm run watch              # esbuild file-watcher; then press F5 ("Run Extension") to launch the Extension Development Host
npm run compile            # tsc --noEmit + esbuild → dist/   (the prepublish build)
npm run lint               # eslint src
npm run fmt                # prettier (src, media, shared) + eslint --fix
npm test                   # tsc --noEmit + build + @vscode/test-electron run (see caveat below)
npm run nvmcli:build       # bundle the standalone NVM CLI → dist/nvmcli.js
npm run package:vsix       # compile + vsce package → dist/nvm-studio-hexeditor.vsix
```

- **Type-check only:** `npx tsc --noEmit`.
- **After any source change** you must rebuild (`npm run compile` or keep `npm run watch`
  running) **and reload** — in the Extension Development Host use "Developer: Reload Window", or
  relaunch with F5. The installed marketplace extension does **not** use your `dist/`.
- **Running a single test:** tests are enumerated in `src/test/index.ts` (an explicit
  `fileImports` list, no glob) and run under `@vscode/test-electron` via `src/test/runTest.js`.
  To run one spec, comment out the others in that list, or use Mocha `.only` inside the spec.
- **CLI for fast iteration without the editor UI:** `node dist/nvmcli.js <parse|crc|image|decode|import|feev3> ...`
  (build it first with `npm run nvmcli:build`). Example:
  `node dist/nvmcli.js feev3 <dump.mot> --lcfg <Fee_Lcfg.c>` (add `--json`), or
  `node dist/nvmcli.js image <dump.mot> --at 0x3d0000 --len 64`.

## Build system

`.esbuild.config.js` builds **many independent bundles** (not a single entry). When adding a new
webview or worker you must add its entry here:
- Extension host: `src/extension.ts` → `dist/extension.js` (node) and `dist/web/extension.js` (browser).
- Webviews (browser): `media/editor/hexEdit.tsx` → `dist/editor.js` (React+Recoil, with SVGR + CSS-modules plugins);
  `media/data_inspector/inspector.ts`; `media/nvm-blocks/blocksTable.ts`; `media/nvm-custom/customViews.ts`.
- Workers: `shared/diffWorker.ts` → `dist/diffWorker.js`.
- **External engine packs**: `engines/vector-fee-v3/src/index.ts` is built to
  `dist/engines/vector-fee-v3/` and its `engine.json` copied alongside. These are **loaded at
  runtime by the desktop host, not linked into the extension bundle** — this is deliberate (see
  vendor-free core below).

TypeScript is `strict`. ESLint disables `no-explicit-any` / `no-non-null-assertion`; `no-var` and
unused-vars are warnings (args matching `^_` or `h` are ignored). Prettier: printWidth 100, 2-space
tabs, avoid arrow parens.

## Architecture

### Base hex editor (custom editor + webview)
- **Extension host** (`src/`) owns the document. `HexEditorProvider` (`src/hexEditorProvider.ts`)
  is the `CustomEditorProvider` registered for `hexEditor.hexedit`. `HexEditorRegistry` tracks the
  active document/messaging. Document model + edits live in `shared/hexDocumentModel.ts` and
  `src/hexDocument.ts`; byte access is abstracted behind `shared/fileAccessor.ts` /
  `src/fileSystemAdaptor.ts`.
- **Webview** (`media/editor/`, React + Recoil) renders the grid. Host↔webview communicate only
  through message types in **`shared/protocol.ts`** (`MessageType` enum) — this file is the
  contract; changing rendering usually means adding a message + a handler on both sides.
- **`shared/`** is code safe for both node and browser bundles. Don't import node-only APIs there.

### NVM Studio (the main extension surface)
Layered, **vendor-blind core**. The core speaks only in *capabilities* (`image` / `symbols` /
`layout` / `struct` / `annotations`) and never names a vendor or file format; all vendor knowledge
lives in adapters/engines/descriptors. See `docs/nvm-layout-providers.md` and
`docs/nvm-capabilities.md` for the authoritative design.

- **`shared/nvm/`** — the browser+node-safe kernel: `model.ts` (`NvmModel`/`NvmBlock`/…),
  `crc.ts`, `expr.ts` (safe whitelist evaluator, no `eval`), `struct.ts`/`cstruct.ts`/`structRich.ts`
  (struct decoders), `arxml/` (dependency-free AUTOSAR ARXML parser + `importNvmCatalog`),
  `capabilities.ts`, `engine.ts`. `index.ts` is the barrel.
- **`src/nvm/layout/`** — the layout registry. `provider.ts` defines `NvmLayoutProvider`
  (`detect(ctx)`/`parse(ctx)→NvmBlockInfo[]`); `resolveNvmBlocks(input)` runs registered adapters
  and isolates throwing ones; `index.ts` registers them. Three tiers, all inert until a descriptor
  opts in: **T0 positional** (`configLayout.ts`, static offsets), **T1 structured**
  (`structuredLayout.ts`, declarative profile the core walks), **T2 engine** (`externalEngine.ts` +
  `engineSdk.ts`, arbitrary JS for algorithmic formats).
- **Config-driven activation:** nothing renders automatically. On open, `hexEditorProvider.ts` →
  `tryLoadNvmBlocks()` scans the dump folder, `./conf/`, `../conf/` for **`*.nvmlayout.json`**
  descriptors, reads the auxiliary `sources` files each descriptor *declares* (the core doesn't know
  what a file means — e.g. Vector declares `{ "feeLcfg": "Fee_Lcfg.c" }`), then calls
  `resolveNvmBlocks()`. Blocks are stashed in `HexEditorRegistry` and pushed to the webview via
  `SetNvmBlocks`. With no matching descriptor the file renders like the plain hex editor.
- **External engines** (`engines/`, e.g. `vector-fee-v3`) are self-contained packs loaded at
  runtime via `createEngine(sdk)`. The `engineSdk.ts` injects a stable vendor-neutral SDK
  (`ENGINE_SDK_VERSION`). Because this executes workspace JavaScript, it is gated behind Workspace
  Trust + `hexeditor.nvm.allowExternalEngines` + a per-file confirmation, and never runs in the web
  build (`isNodeHost` guard). Engine management commands live in `src/nvm/engines/`.
- **Feature modules under `src/nvm/`:** `annotations/` (bookmarks/tags/notes, sidecar or
  workspaceState per `hexeditor.nvm.annotationStorage`), `customViews/` + `blocks/` (NVM Studio tree
  + webview tables in the `nvmStudio` activity-bar container), `report/` (Markdown report generation
  + preview), `discovery/` (recursive dependency-file resolution across `hexeditor.nvm.workspaceRoots`),
  `ai/`.
- **Rendering** (`media/editor/`): `NvmBlockInfo`/`NvmFieldInfo` (in `shared/protocol.ts`) carry
  editor-relative `offset`/`length` (= `absoluteChipAddr − imageBase`) and per-field `kind`/`unit`.
  Coloring is **selection-driven** — clicking a byte sets `selectedNvmUnitAtom` and only that unit's
  fields color (`dataDisplay.tsx`); `dataInspector.tsx` `NvmByteExplain` shows the per-byte
  attribute. State/handlers are in `media/editor/state.ts` (the `SetNvmBlocks` handler is registered
  eagerly at module load to avoid a startup race).

### AI surfaces
One vendor-blind facade, `NvmCapabilities` (`src/nvm/ai/nvmCapabilities.ts`), backs both:
- **Chat participant** `@nvm` (`chatParticipant.ts`, id `hexEditor.nvm`).
- **Language Model Tools** (`lmTools.ts`) declared in `package.json` under `languageModelTools`
  (`nvm_listBlocks`, `nvm_searchBlocks`, `nvm_getDecoded`, `nvm_readBytes`, `nvm_createNote`,
  `nvm_analyzeBlock`, `nvm_listAnnotations`, `nvm_exportReport`, `nvm_riskDetection`).

When adding an AI capability, extend `NvmCapabilities` so both surfaces get it, then declare the tool
in `package.json`. See `docs/nvm-ai-capabilities.md`.

## Conventions specific to this repo

- **Keep the core vendor-free.** Do not add vendor/format-specific logic to `shared/` or
  `src/nvm/layout/` core files. A new vendor is either a `*.nvmlayout.json` descriptor (declarative)
  or a new adapter file + `registerLayoutProvider(...)` / an engine pack under `engines/`.
- Every host↔webview interaction goes through `shared/protocol.ts`. New webviews need an esbuild
  entry, a `contributes.views`/`viewsContainers` entry in `package.json`, and a registration in
  `src/extension.ts`.
- `docs/nvm-context.md` is a detailed handoff doc (verified FEE V3 format facts, demo data paths,
  status/next-steps, scenario prompts). Read it before doing NVM format work. `docs/design.md`,
  `docs/nvm-fee-v3-layout.md`, `docs/nvm-capabilities.md`, and `docs/nvmlayout.template.jsonc` are
  the other primary references.
- User-facing strings are localized via `%key%` in `package.json` → `package.nls.json` and l10n.

## Testing caveat

`npm test` may be blocked by a pre-existing `@vscode/extension-telemetry` named-import error in
unmodified files. `npx tsc --noEmit` and `npm run nvmcli:build` are reliable smoke checks. To
exercise NVM parsing logic quickly, prefer the CLI (`dist/nvmcli.js`) over the full editor test host.
