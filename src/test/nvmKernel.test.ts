/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import {
    computeCrc,
    crcPresets,
    evaluateExpression,
    NvmProfile,
    parseNvm,
    resolveCrcPreset,
    validateProfile,
} from "../../shared/nvm";

const CHECK = new Uint8Array([...Buffer.from("123456789", "ascii")]);

describe("NVM kernel", () => {
	describe("computeCrc", () => {
		const cases: Array<[string, number]> = [
			["CRC16-CCITT-FALSE", 0x29b1],
			["CRC16-ARC", 0xbb3d],
			["CRC32", 0xcbf43926],
			["CRC32C", 0xe3069283],
			["CRC8-SAE-J1850", 0x4b],
			["CRC8-0xD5", 0xbc],
		];

		for (const [preset, expected] of cases) {
			it(`matches the check value for ${preset}`, () => {
				const value = computeCrc(CHECK, resolveCrcPreset(preset));
				expect(value).to.equal(expected);
			});
		}

		it("supports sub-ranges", () => {
			const full = computeCrc(CHECK, crcPresets.CRC32);
			const partial = computeCrc(CHECK, crcPresets.CRC32, 0, 4);
			expect(partial).to.not.equal(full);
		});

		it("throws on unknown presets", () => {
			expect(() => resolveCrcPreset("NOPE")).to.throw(/Unknown CRC preset/);
		});
	});

	describe("evaluateExpression", () => {
		it("evaluates shifts and masks", () => {
			expect(evaluateExpression("1 << (v & 0x0F)", { v: 3 })).to.equal(8);
		});

		it("evaluates nibble packing", () => {
			expect(evaluateExpression("(hi << 4) | lo", { hi: 0xa, lo: 0x5 })).to.equal(0xa5);
		});

		it("respects operator precedence", () => {
			expect(evaluateExpression("2 + 3 * 4")).to.equal(14);
			expect(evaluateExpression("(2 + 3) * 4")).to.equal(20);
		});

		it("supports min/max", () => {
			expect(evaluateExpression("max(1, min(9, 4))")).to.equal(4);
		});

		it("rejects unknown identifiers (no arbitrary code execution)", () => {
			expect(() => evaluateExpression("process")).to.throw(/Unknown identifier/);
		});

		it("rejects unexpected characters", () => {
			expect(() => evaluateExpression("1 @ 2")).to.throw();
		});
	});

	describe("validateProfile", () => {
		it("accepts a minimal valid profile", () => {
			const profile = validateProfile({
				id: "t",
				block: {
					iterate: "sequential",
					header: [{ name: "len", offset: 0, size: 2, role: "payloadLength" }],
					payload: { after: "header", length: "$len" },
				},
			});
			expect(profile.id).to.equal("t");
		});

		it("rejects a missing id", () => {
			expect(() => validateProfile({ block: {} })).to.throw(/Profile.id/);
		});

		it("rejects unsupported containers", () => {
			expect(() =>
				validateProfile({ id: "t", container: { kind: "cluster" }, block: {} }),
			).to.throw(/container.kind/);
		});
	});

	describe("parseNvm", () => {
		const profile: NvmProfile = {
			id: "example.linear.crc16",
			endian: "little",
			block: {
				iterate: "sequential",
				start: 0,
				header: [
					{ name: "blockId", offset: 0, size: 2, role: "blockId" },
					{ name: "length", offset: 2, size: 2, role: "payloadLength" },
				],
				payload: { after: "header", length: "$length" },
				endMarker: { at: 0, size: 2, value: 0xffff },
			},
			integrity: {
				crc: {
					preset: "CRC16-CCITT-FALSE",
					range: "payload",
					stored: { source: "trailer", size: 2, endian: "little" },
				},
			},
		};

		/** Build one block: [id LE][len LE][payload][crc LE], optional bad crc. */
		function buildBlock(id: number, payload: number[], corrupt = false): number[] {
			const crc = computeCrc(new Uint8Array(payload), crcPresets["CRC16-CCITT-FALSE"]);
			const stored = corrupt ? crc ^ 0xffff : crc;
			return [
				id & 0xff,
				(id >> 8) & 0xff,
				payload.length & 0xff,
				(payload.length >> 8) & 0xff,
				...payload,
				stored & 0xff,
				(stored >> 8) & 0xff,
			];
		}

		it("parses two valid blocks and validates CRC", () => {
			const bytes = [
				...buildBlock(0x0021, [1, 2, 3]),
				...buildBlock(0x0022, [9, 8, 7, 6]),
				0xff,
				0xff, // end marker
			];
			const model = parseNvm(new Uint8Array(bytes), profile);
			expect(model.blocks).to.have.length(2);
			expect(model.blocks[0].logicalId).to.equal(0x21);
			expect(model.blocks[0].active.crc.valid).to.equal(true);
			expect(model.blocks[1].logicalId).to.equal(0x22);
			expect(model.blocks[1].active.payloadRange.end - model.blocks[1].active.payloadRange.start).to.equal(4);
			expect(model.issues).to.have.length(0);
		});

		it("flags CRC mismatches", () => {
			const bytes = buildBlock(0x0030, [4, 5, 6], true);
			const model = parseNvm(new Uint8Array(bytes), profile);
			expect(model.blocks[0].active.status).to.equal("invalid");
			expect(model.blocks[0].active.crc.valid).to.equal(false);
			expect(model.issues.some(i => i.code === "CRC_MISMATCH")).to.equal(true);
		});

		it("stops at the end marker", () => {
			const bytes = [0xff, 0xff, ...buildBlock(0x0001, [1])];
			const model = parseNvm(new Uint8Array(bytes), profile);
			expect(model.blocks).to.have.length(0);
		});
	});
});
