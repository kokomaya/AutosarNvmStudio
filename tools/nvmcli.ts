// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * nvmcli — standalone command line interface for the NVM parse kernel.
 *
 * It reuses `shared/nvm` and has no VS Code dependency so it can run in CI or
 * be driven by an agent. Bundle it with:
 *   npm run nvmcli:build
 * then run:
 *   node dist/nvmcli.js parse image.nvm --profile tools/profiles/example.linear.crc16.json
 *
 * See docs/design.md §8.3.
 */

import * as fs from "fs";
import {
    computeCrc,
    crcPresets,
    decodeStruct,
    importNvmCatalog,
    loadHexImage,
    MemoryImage,
    NvmModel,
    parseBlkStruct,
    parseNvm,
    resolveCrcPreset,
    structByteLength,
    validateProfile,
} from "../shared/nvm";

interface ParsedArgs {
	command: string;
	positionals: string[];
	options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command = "help", ...rest] = argv;
	const positionals: string[] = [];
	const options: Record<string, string | boolean> = {};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				options[key] = next;
				i++;
			} else {
				options[key] = true;
			}
		} else {
			positionals.push(arg);
		}
	}
	return { command, positionals, options };
}

function loadProfile(path: string) {
	const text = fs.readFileSync(path, "utf8");
	return validateProfile(JSON.parse(text));
}

function summarize(model: NvmModel): string {
	const lines: string[] = [];
	lines.push(`profile: ${model.profileId}`);
	lines.push(`blocks:  ${model.blocks.length}`);
	lines.push(`issues:  ${model.issues.length}`);
	lines.push("");
	lines.push("  ID        offset      length   crc");
	for (const block of model.blocks) {
		const a = block.active;
		const len = a.payloadRange.end - a.payloadRange.start;
		const crc =
			a.crc.valid === undefined ? "-" : a.crc.valid ? "ok" : "MISMATCH";
		lines.push(
			`  ${String(a.logicalId).padEnd(8)}  0x${a.fileRange.start
				.toString(16)
				.padStart(8, "0")}  ${String(len).padStart(6)}   ${crc}`,
		);
	}
	if (model.issues.length > 0) {
		lines.push("");
		lines.push("issues:");
		for (const issue of model.issues) {
			lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
		}
	}
	return lines.join("\n");
}

function parseIntFlexible(value: string): number {
	return value.startsWith("0x") || value.startsWith("0X")
		? parseInt(value, 16)
		: parseInt(value, 10);
}

function cmdParse(args: ParsedArgs): number {
	const image = args.positionals[0];
	const profilePath = args.options.profile;
	if (!image || typeof profilePath !== "string") {
		console.error("usage: nvmcli parse <image> --profile <profile.json> [--json]");
		return 2;
	}
	const data = new Uint8Array(fs.readFileSync(image));
	const profile = loadProfile(profilePath);
	const model = parseNvm(data, profile);
	if (args.options.json) {
		console.log(JSON.stringify(model, null, 2));
	} else {
		console.log(summarize(model));
	}
	return model.issues.some(i => i.severity === "error") ? 1 : 0;
}

function cmdCrc(args: ParsedArgs): number {
	const image = args.positionals[0];
	const presetName = typeof args.options.preset === "string" ? args.options.preset : "CRC32";
	if (!image) {
		console.error(
			"usage: nvmcli crc <image> [--preset <name>] [--range <start:end>]\n" +
				`presets: ${Object.keys(crcPresets).join(", ")}`,
		);
		return 2;
	}
	const data = new Uint8Array(fs.readFileSync(image));
	const model = resolveCrcPreset(presetName);
	let start = 0;
	let end = data.length;
	if (typeof args.options.range === "string") {
		const [s, e] = args.options.range.split(":");
		start = parseIntFlexible(s);
		end = e ? parseIntFlexible(e) : data.length;
	}
	const value = computeCrc(data, model, start, end);
	const hex = value.toString(16).padStart(model.width / 4, "0");
	console.log(`${presetName} [${start}:${end}] = 0x${hex}`);
	return 0;
}

/** Load a raw binary, or auto-decode an S-record / Intel HEX text file. */
function loadImageFile(path: string): MemoryImage {
	const buffer = fs.readFileSync(path);
	const head = buffer.subarray(0, 1).toString("ascii");
	if (head === "S" || head === ":") {
		return loadHexImage(buffer.toString("ascii"));
	}
	return new MemoryImage([{ address: 0, data: new Uint8Array(buffer) }]);
}

function cmdImage(args: ParsedArgs): number {
	const path = args.positionals[0];
	if (!path) {
		console.error("usage: nvmcli image <file.mot|file.hex> [--at <addr>] [--len <n>]");
		return 2;
	}
	const image = loadImageFile(path);
	console.log(`base:     0x${image.baseAddress.toString(16)}`);
	console.log(`end:      0x${image.endAddress.toString(16)}`);
	console.log(`span:     ${image.span} bytes`);
	console.log(`segments: ${image.segments.length}`);
	for (const seg of image.segments.slice(0, 20)) {
		console.log(
			`  0x${seg.address.toString(16).padStart(8, "0")}  +${seg.data.length}`,
		);
	}
	if (typeof args.options.at === "string") {
		const at = parseIntFlexible(args.options.at);
		const len = typeof args.options.len === "string" ? parseIntFlexible(args.options.len) : 32;
		const bytes = image.read(at, len);
		if (!bytes) {
			console.error(`address range 0x${at.toString(16)}+${len} not covered`);
			return 1;
		}
		console.log(
			`\n0x${at.toString(16)}: ${Array.from(bytes)
				.map(b => b.toString(16).padStart(2, "0"))
				.join(" ")}`,
		);
	}
	return 0;
}

function cmdDecode(args: ParsedArgs): number {
	const path = args.positionals[0];
	const structPath = args.options.struct;
	if (!path || typeof structPath !== "string") {
		console.error(
			"usage: nvmcli decode <file.mot|bin> --struct <def.blk> [--at <addr>] [--json]",
		);
		return 2;
	}
	const image = loadImageFile(path);
	const struct = parseBlkStruct(fs.readFileSync(structPath, "utf8"), structPath);
	const length = structByteLength(struct);
	const at =
		typeof args.options.at === "string" ? parseIntFlexible(args.options.at) : image.baseAddress;
	const bytes = image.read(at, length);
	if (!bytes) {
		console.error(`address range 0x${at.toString(16)}+${length} not covered by the image`);
		return 1;
	}
	const fields = decodeStruct(bytes, struct);
	if (args.options.json) {
		console.log(JSON.stringify(fields, null, 2));
	} else {
		console.log(`struct: ${struct.name} @ 0x${at.toString(16)} (${length} bytes)\n`);
		for (const f of fields) {
			const unit = f.unit ? ` ${f.unit}` : "";
			console.log(`  ${f.path.padEnd(40)} ${String(f.value)}${unit}`);
		}
	}
	return 0;
}

function cmdImport(args: ParsedArgs): number {
	const nvmPath = args.options.nvm;
	if (typeof nvmPath !== "string") {
		console.error(
			"usage: nvmcli import --nvm <NvM_ecuc.arxml> [--fee <Fee_ecuc.arxml>] [--fls <Fls_ecuc.arxml>] [--json]",
		);
		return 2;
	}
	const catalog = importNvmCatalog({
		nvm: fs.readFileSync(nvmPath, "utf8"),
		fee: typeof args.options.fee === "string" ? fs.readFileSync(args.options.fee, "utf8") : undefined,
		fls: typeof args.options.fls === "string" ? fs.readFileSync(args.options.fls, "utf8") : undefined,
	});
	if (args.options.json) {
		console.log(JSON.stringify(catalog, null, 2));
		return 0;
	}
	if (catalog.memory) {
		console.log(
			`memory: base 0x${(catalog.memory.baseAddress ?? 0).toString(16)}, ${catalog.memory.sectors.length} sector group(s)`,
		);
		for (const s of catalog.memory.sectors) {
			console.log(
				`  start 0x${s.startAddress.toString(16)}  size 0x${s.sectorSize.toString(16)}  count ${s.numberOfSectors}`,
			);
		}
	}
	if (catalog.virtualPageSize !== undefined) {
		console.log(`virtualPageSize: ${catalog.virtualPageSize}`);
	}
	console.log(`\nblocks: ${catalog.blocks.length}\n`);
	console.log("  id     len   crc  mgmt      inst  feeNo  name");
	for (const b of catalog.blocks) {
		console.log(
			`  ${String(b.nvmId ?? "-").padStart(4)}  ${String(b.payloadLength ?? "-").padStart(5)}  ` +
				`${b.useCrc ? String(b.crcWidth ?? "?") : "-"}`.padStart(3) +
				`  ${(b.managementType ?? "-").padEnd(8)}  ${String(b.instances ?? "-").padStart(4)}  ` +
				`${String(b.feeBlockNumber ?? "-").padStart(5)}  ${b.name}`,
		);
	}
	return 0;
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	switch (args.command) {
		case "parse":
			return cmdParse(args);
		case "crc":
			return cmdCrc(args);
		case "image":
			return cmdImage(args);
		case "decode":
			return cmdDecode(args);
		case "import":
			return cmdImport(args);
		case "help":
		default:
			console.log(
				[
					"nvmcli — AUTOSAR NVM parse kernel CLI",
					"",
					"commands:",
					"  parse  <image> --profile <p.json> [--json]      Parse blocks and print a summary",
					"  crc    <image> [--preset <name>] [--range a:b]   Compute a CRC over the image",
					"  image  <file.mot|hex> [--at <addr>] [--len <n>]  Decode an S-record/Intel HEX image",
					"  decode <file> --struct <def.blk> [--at <addr>]   Decode a struct at an address",
					"  import --nvm <f> [--fee <f>] [--fls <f>] [--json] Import a block catalog from ECUC ARXML",
					"",
					`crc presets: ${Object.keys(crcPresets).join(", ")}`,
				].join("\n"),
			);
			return 0;
	}
}

process.exit(main());
