// Template NVM layout engine — copy, rename to `<something>.engine.js`, edit.
//
// An engine turns an opened dump into colored NVM blocks. Enable runtime engines
// with the setting `hexeditor.nvm.allowExternalEngines` (trusted workspace,
// desktop only), then reference this file from a `*.nvmlayout.json`:
//
//   {
//     "vendor": "My Format",
//     "match": { "ext": [".bin", ".mot"] },
//     "engineScript": "./my.engine.js",
//     "sources": { "table": "layout.csv" },   // optional aux files
//     "options": { "recordSize": 32 }         // free-form, passed to parse()
//   }
//
// Save the file while a dump is open and the editor hot-reloads your changes.

module.exports.createEngine = sdk => {
	// `sdk` is the injected, versioned NVM kernel. Available helpers include:
	//   sdk.version            - SDK contract version (guard on this if needed)
	//   sdk.loadHexImage(text) - decode S-record / Intel HEX -> MemoryImage
	//   sdk.parseVectorFeeV3   - Vector FEE V3 link-table walk
	//   sdk.parseFeeLcfg / sdk.feeLcfgByTag - Fee_Lcfg.c helpers
	//   sdk.computeCrc         - Rocksoft CRC (all presets)
	//   sdk.evaluateExpression - safe arithmetic evaluator (no eval)
	//   sdk.resolveFieldLink   - decode + range-check an in-file address
	//   sdk.buildFeeV3Blocks   - the full built-in Vector pipeline

	return {
		id: "my-engine",

		// `input`  : { fileName, ext, text, configs, sources, arxml }
		// `options`: the descriptor's `options` object (may be undefined)
		// returns  : NvmBlockInfo[]
		parse(input, options) {
			const image = sdk.loadHexImage(input.text);
			const { baseAddress, bytes } = image.toFlat(0xff);
			const recordSize = (options && options.recordSize) || 16;

			const blocks = [];
			for (let i = 0, n = 0; i + recordSize <= bytes.length; i += recordSize, n++) {
				const unit = "record#" + n;
				blocks.push({
					id: unit,
					name: "Record " + n,
					offset: i,
					length: recordSize,
					fields: [
						// offsets are EDITOR byte offsets (0 = image base = baseAddress)
						{ name: "header", kind: "header", offset: i, length: 2, unit },
						{ name: "payload", kind: "payload", offset: i + 2, length: recordSize - 2, unit },
					],
				});
			}
			return blocks;
		},
	};
};
