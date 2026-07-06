# Security

This repository is an internal/personal fork of Microsoft's `vscode-hexeditor`, used and
distributed internally (not published to the VS Code Marketplace). It is **not** covered by
Microsoft's public MSRC vulnerability disclosure process described for the upstream project.

## Reporting a security issue

If you find a security issue in this fork (for example, in the NVM Studio external-engine
loading path, dependency-file auto-discovery, or ARXML/config parsing), report it directly to
the repository maintainer rather than filing a public issue. Include:

- Affected file(s)/commit
- Steps to reproduce and expected vs. actual behavior
- Impact (e.g. what a malicious workspace/config/dump/engine script could do)

## Notes on the extension's trust model

Some NVM Studio features intentionally execute workspace-provided code or read
workspace-provided files, and are gated accordingly:

- **External layout engines** (`*.nvmlayout.json` → `engineScript`/`engine`) run arbitrary
  JavaScript from the workspace. They only run in the desktop extension host, only in a
  **trusted workspace**, only when `hexeditor.nvm.allowExternalEngines` is enabled, and only
  after a one-time per-file confirmation. Set the setting to `false` to disable engines entirely.
- **Dependency auto-discovery** (`hexeditor.nvm.workspaceRoots`) only reads files under the
  configured roots — the extension never fetches remote files itself.

If you find a way to bypass any of these gates, treat it as a security issue and report it as
above.

## Upstream

For vulnerabilities that also affect the original, unmodified `vscode-hexeditor` (the base
custom-editor/webview code untouched by this fork), consider also reporting to Microsoft via
[MSRC](https://msrc.microsoft.com/create-report), per the
[upstream project's policy](https://github.com/microsoft/vscode-hexeditor/security/policy).
