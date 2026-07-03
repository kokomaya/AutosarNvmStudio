/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import {
    applyOpers,
    decodeStruct,
    loadHexImage,
    MemoryImage,
    parseBlkStruct,
    parseIntelHex,
    parseSRecord,
    structByteLength,
    StructDef,
} from "../../shared/nvm";

describe("NVM loaders", () => {
	describe("parseSRecord", () => {
		// First data line of the real "NVM 1.mot" (S2, base 0x3A0000).
		const line = "S2143A0000C605000039FAFFFFFFFFFFFFFFFFFFFFBD";

		it("decodes the base address and payload", () => {
			const image = parseSRecord(line);
			expect(image.baseAddress).to.equal(0x3a0000);
			const head = image.read(0x3a0000, 4);
			expect(head && Array.from(head)).to.deep.equal([0xc6, 0x05, 0x00, 0x00]);
		});

		it("merges contiguous records", () => {
			const image = parseSRecord(
				[
					"S2143A0000C605000039FAFFFFFFFFFFFFFFFFFFFFBD",
					"S2143A0010FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFB1",
				].join("\n"),
			);
			expect(image.segments).to.have.length(1);
			expect(image.span).to.equal(32);
		});

		it("rejects a bad checksum", () => {
			expect(() =>
				parseSRecord("S2143A0000C605000039FAFFFFFFFFFFFFFFFFFFFF00"),
			).to.throw(/checksum/);
		});
	});

	describe("parseIntelHex", () => {
		it("decodes data records", () => {
			const image = parseIntelHex(":0300300002337A1E\n:00000001FF");
			const bytes = image.read(0x30, 3);
			expect(bytes && Array.from(bytes)).to.deep.equal([0x02, 0x33, 0x7a]);
		});
	});

	describe("loadHexImage", () => {
		it("auto-detects S-record", () => {
			const image = loadHexImage("S2143A0000C605000039FAFFFFFFFFFFFFFFFFFFFFBD");
			expect(image.baseAddress).to.equal(0x3a0000);
		});
	});

	describe("MemoryImage", () => {
		it("flattens with gap fill", () => {
			const image = new MemoryImage([
				{ address: 10, data: new Uint8Array([1, 2]) },
				{ address: 14, data: new Uint8Array([3, 4]) },
			]);
			const flat = image.toFlat(0xff);
			expect(flat.baseAddress).to.equal(10);
			expect(Array.from(flat.bytes)).to.deep.equal([1, 2, 0xff, 0xff, 3, 4]);
		});
	});
});

describe("NVM struct decoder", () => {
	describe("applyOpers", () => {
		it("scales and offsets in order", () => {
			expect(applyOpers(10080, "*0.03125, -273")).to.equal(42);
		});
		it("widens then adds", () => {
			expect(applyOpers(40, "(u16), +1985")).to.equal(2025);
		});
		it("multiplies then casts to u8 (truncating)", () => {
			expect(applyOpers(201, "*0.25, (u8)")).to.equal(50);
		});
	});

	describe("parseBlkStruct", () => {
		it("parses a legacy .blk table", () => {
			const text = [
				"Title ; Unit ; NrBts ; Endian ; Type ; Opers   Vers:1.00",
				"---------------------------------------------------------------",
				"First Year        ;   -   ;  8  ; msb ; u8  ; (u16), +1985",
				"First Temperature ;   °   ; 16  ; msb ; i16 ; *0.03125, -273",
			].join("\n");
			const struct = parseBlkStruct(text, "EDR");
			expect(struct.fields).to.have.length(2);
			expect(struct.fields[0].title).to.equal("First Year");
			expect(struct.fields[1].bits).to.equal(16);
			expect(struct.fields[1].type).to.equal("i16");
			expect(structByteLength(struct)).to.equal(3);
		});
	});

	describe("decodeStruct", () => {
		const struct: StructDef = {
			name: "EDR",
			fields: [
				{ title: "Year", bits: 8, endian: "msb", type: "u8", opers: "(u16), +1985" },
				{ title: "Seconds", bits: 8, endian: "msb", type: "u8", opers: "*0.25, (u8)" },
				{ title: "Temperature", unit: "°", bits: 16, endian: "msb", type: "i16", opers: "*0.03125, -273" },
				{ title: "Distance", unit: "m", bits: 32, endian: "msb", type: "u32", opers: "*5" },
			],
		};

		it("decodes physical values from bytes", () => {
			const bytes = new Uint8Array([40, 200, 0x27, 0x60, 0x00, 0x00, 0x00, 0x64]);
			const fields = decodeStruct(bytes, struct);
			expect(fields[0].value).to.equal(2025);
			expect(fields[1].value).to.equal(50);
			expect(fields[2].value).to.equal(42);
			expect(fields[2].unit).to.equal("°");
			expect(fields[3].value).to.equal(500);
			expect(fields[3].rawBytes).to.deep.equal([4, 8]);
		});

		it("sign-extends signed fields", () => {
			const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
			const fields = decodeStruct(bytes, {
				name: "s",
				fields: [{ title: "v", bits: 16, endian: "msb", type: "i16" }],
			});
			expect(fields[0].raw).to.equal(-1);
		});
	});
});
