# Contributing

This is an internal fork of Microsoft's `vscode-hexeditor`, extended into NVM Studio (see
[README.md](README.md)). It is not distributed on the VS Code Marketplace and does not go
through the upstream project's CLA/PR process — the notes below are for working on this repo
directly.

## Getting the sources

```
git clone <this repo's URL>
cd vscode-hexeditor
npm install
```

Prerequisites: [Git](https://git-scm.com), [Node.js](https://nodejs.org/en/) (x64, `>= 12.x`).

## Build and run

```
npm run watch          # esbuild watcher
```

Then use the VS Code debugger to run "Run Extension" (F5) — this launches an Extension
Development Host with the extension loaded from `dist/`. After any source change, rebuild
(`npm run watch` picks it up automatically) and reload the dev host window
("Developer: Reload Window") to see the change; the marketplace-installed hex editor, if you also
have it, does **not** pick up local changes.

```
npm run compile        # one-shot type-check + build (what `vscode:prepublish` runs)
npm run package:vsix   # compile + package a .vsix for internal distribution
```

See [CLAUDE.md](CLAUDE.md) for a fuller architecture overview and the NVM CLI
(`npm run nvmcli:build`) used for fast iteration without the editor UI.

### Linting and formatting

```
npm run lint   # eslint src
npm run fmt    # prettier (src, media, shared) + eslint --fix
```

Install the [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
to lint as you type.

### Testing

```
npm test
```

Runs `tsc --noEmit`, builds, then runs the suite listed explicitly in `src/test/index.ts` under
`@vscode/test-electron`. Note: this can be blocked by a pre-existing
`@vscode/extension-telemetry` named-import error in unmodified files — `npx tsc --noEmit` and
`npm run nvmcli:build` are reliable fallbacks for a quick sanity check.

## Working on NVM Studio specifically

The NVM core is designed to stay **vendor-blind** — new vendor/layout support belongs in a
`*.nvmlayout.json` descriptor or a new adapter/engine, never as vendor-specific logic in
`shared/` or the layout registry core. Before changing layout, capability, or AI-tool code, read:

- [docs/nvm-context.md](docs/nvm-context.md) — project context, verified format facts, status
- [docs/nvm-layout-providers.md](docs/nvm-layout-providers.md) — layout provider architecture
- [docs/nvm-capabilities.md](docs/nvm-capabilities.md) — the vendor-blind capability boundary
- [docs/nvm-ai-capabilities.md](docs/nvm-ai-capabilities.md) — the Copilot/LM-tools boundary

## Branches and commits

Use feature branches off `main` (or `develop/*` for longer-lived work-in-progress, matching the
current branch naming). Keep commits scoped and describe *why* a change was made, not just what
changed. Squash noisy WIP history before merging where practical.

## Pull requests

Keep PRs focused — one topic per PR — and include a short description of the motivation and any
manual verification performed (this repo has no external CI beyond `.github/workflows/pr.yml`,
which runs `npm run compile`, `npm run lint`, and `npm test` on PRs against `main`).
