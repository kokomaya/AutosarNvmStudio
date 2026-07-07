const esbuild = require("esbuild");
const svgr = require("esbuild-plugin-svgr");
const css = require("esbuild-css-modules-plugin");

const watch = process.argv.includes("--watch");
const minify = !watch || process.argv.includes("--minify");
const defineProd = process.argv.includes("--defineProd");

function build(options) {
	(async () => {
		if (watch) {
			const context = await esbuild.context(options);
			await context.watch();
		} else {
			await esbuild.build(options);
		}
	})().catch(() => process.exit(1));
}

// Build the editor provider
build({
	entryPoints: ["src/extension.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode"],
	sourcemap: watch,
	minify,
	platform: "node",
	outfile: "dist/extension.js",
});

// Build the test cases
build({
	entryPoints: ["src/test/index.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode", "mocha", "chai"],
	sourcemap: watch,
	minify,
	platform: "node",
	outfile: "dist/test.js",
});

build({
	entryPoints: ["src/extension.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	format: "cjs",
	external: ["vscode", "fs", "worker_threads"],
	minify,
	platform: "browser",
	outfile: "dist/web/extension.js",
});

build({
	entryPoints: ["shared/diffWorker.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	format: "cjs",
	external: ["vscode", "worker_threads"],
	minify,
	platform: "browser",
	outfile: "dist/diffWorker.js",
});

// Build the reference external NVM engine pack (self-contained, loaded at
// runtime by the desktop host — NOT linked into the extension bundle). Proves
// the vendor-free core: all Vector layout logic lives here, none in src/shared.
build({
	entryPoints: ["engines/vector-fee-v3/src/index.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	format: "cjs",
	platform: "node",
	minify,
	sourcemap: watch,
	outfile: "dist/engines/vector-fee-v3/vectorFeeV3.engine.js",
});


// Build the data inspector
build({
	entryPoints: ["media/data_inspector/inspector.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode"],
	sourcemap: watch ? "inline" : false,
	minify,
	platform: "browser",
	outfile: "dist/inspector.js",
});

// Build the NVM Blocks Table webview (plain DOM renderer).
build({
	entryPoints: ["media/nvm-blocks/blocksTable.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode"],
	sourcemap: watch ? "inline" : false,
	minify,
	platform: "browser",
	outfile: "dist/nvmBlocksTable.js",
});

// Build the NVM Custom Views webview (plain DOM renderer).
build({
	entryPoints: ["media/nvm-custom/customViews.ts"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode"],
	sourcemap: watch ? "inline" : false,
	minify,
	platform: "browser",
	outfile: "dist/nvmCustomViews.js",
});

// Build the webview editors
build({
	entryPoints: ["media/editor/hexEdit.tsx"],
	tsconfig: "./tsconfig.json",
	bundle: true,
	external: ["vscode"],
	sourcemap: watch,
	minify,
	platform: "browser",
	outfile: "dist/editor.js",
	define: defineProd
		? {
				"process.env.NODE_ENV": defineProd ? '"production"' : '"development"',
			}
		: undefined,
	plugins: [svgr(), css({ v2: true, filter: /\.css$/i })],
});

// Ship the reference engine pack manifest next to its built entry so the engine
// manager can install/resolve it like any other pack.
const fs = require("fs");
fs.mkdirSync("dist/engines/vector-fee-v3", { recursive: true });
fs.copyFileSync(
	"engines/vector-fee-v3/engine.json",
	"dist/engines/vector-fee-v3/engine.json",
);

// Ship the standard layout descriptor(s) alongside the engine so the pack is
// self-describing (dist/engines/vector-fee-v3/conf/*.nvmlayout.json). Point the
// engine server's conf root here, or copy them next to a dump.
const engineConfSrc = "engines/vector-fee-v3/conf";
if (fs.existsSync(engineConfSrc)) {
	const engineConfDst = "dist/engines/vector-fee-v3/conf";
	fs.mkdirSync(engineConfDst, { recursive: true });
	for (const name of fs.readdirSync(engineConfSrc)) {
		if (name.toLowerCase().endsWith(".nvmlayout.json")) {
			fs.copyFileSync(`${engineConfSrc}/${name}`, `${engineConfDst}/${name}`);
		}
	}
}

// Ship the Blocks Table stylesheet (static file, referenced by the webview).
fs.copyFileSync("media/nvm-blocks/blocksTable.css", "dist/nvmBlocksTable.css");

// Ship the Custom Views stylesheet (static file, referenced by the webview).
fs.copyFileSync("media/nvm-custom/customViews.css", "dist/nvmCustomViews.css");

