// Reference NVM layout engine — Vector MICROSAR FEE V3 (link table).
//
// This is a *runtime-loaded* engine: point a `*.nvmlayout.json` at it with
//   { "vendor": "...", "engineScript": "./vectorFeeV3.engine.js",
//     "sources": { "feeLcfg": "Fee_Lcfg.c" }, "options": { ... } }
// and enable `hexeditor.nvm.allowExternalEngines` in a trusted workspace.
//
// It proves the engine contract: the extension injects a stable `sdk` (the
// authoritative NVM kernel) so this file never bundles its own parser. Here we
// simply delegate to the built-in Vector pipeline via `sdk.buildFeeV3Blocks`,
// but you are free to replace `parse` with your own logic — edit this file and
// save; the editor hot-reloads it for any open dump.
//
// The engine returns `NvmBlockInfo[]`: blocks with colored `fields`
// (each `{ name, kind, offset /* editor byte offset */, length, unit, link? }`).

module.exports.createEngine = sdk => ({
	id: "vector-fee-v3-external",
	parse(input, options) {
		// `input.sources` is keyed by the logical names the descriptor declared
		// under `sources` (e.g. { "feeLcfg": "Fee_Lcfg.c" }).
		const feeLcfg = input.sources.feeLcfg || input.sources["fee_lcfg.c"];
		// `options` are the descriptor's `options` (alignment, sectorSize, …,
		// plus an optional `structure` describing each region's fields).
		return sdk.buildFeeV3Blocks(input.text, feeLcfg, options || {});
	},
});
