/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import {
	compileBlkToRich,
	decodeStruct,
	decodeStructRich,
	mergeCatalogs,
	NvmDecodedNode,
	NvmStructCatalog,
	NvmStructDef,
	parseBlkStruct,
	parseCStructsEx,
	parseStructCatalog,
} from "../../shared/nvm";

const emptyCatalog: NvmStructCatalog = { structs: {}, enums: {} };

/** Find a node by name in a (possibly nested) tree. */
function find(nodes: NvmDecodedNode[], name: string): NvmDecodedNode | undefined {
	for (const n of nodes) {
		if (n.name === name) {
			return n;
		}
		if (n.children) {
			const hit = find(n.children, name);
			if (hit) {
				return hit;
			}
		}
	}
	return undefined;
}

describe("NVM rich struct decoder", () => {
	describe("primitives & endianness", () => {
		it("decodes little/big scalars with absolute offsets", () => {
			const def: NvmStructDef = {
				name: "S",
				endian: "little",
				fields: [
					{ name: "a", type: "u8" },
					{ name: "b", type: "u16" },
					{ name: "c", type: "u16", endian: "big" },
				],
			};
			const bytes = new Uint8Array([0x11, 0x34, 0x12, 0x12, 0x34]);
			const tree = decodeStructRich(bytes, def, { baseOffset: 100, catalog: emptyCatalog });
			expect(find(tree, "a")!.value).to.equal(0x11);
			expect(find(tree, "a")!.offset).to.equal(100);
			expect(find(tree, "b")!.value).to.equal(0x1234);
			expect(find(tree, "b")!.offset).to.equal(101);
			expect(find(tree, "c")!.value).to.equal(0x1234);
			expect(find(tree, "c")!.offset).to.equal(103);
		});

		it("encodes u64 as a decimal string (JSON-safe)", () => {
			const def: NvmStructDef = {
				name: "S",
				endian: "little",
				fields: [{ name: "big", type: "u64" }],
			};
			const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x80]);
			const tree = decodeStructRich(bytes, def, { baseOffset: 0, catalog: emptyCatalog });
			const node = find(tree, "big")!;
			expect(node.value).to.equal("9223372036854775808");
			expect(() => JSON.stringify(tree)).to.not.throw();
		});

		it("reads ascii strings", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "tag", type: "ascii", size: 4 }],
			};
			const bytes = new Uint8Array([0x56, 0x31, 0x2e, 0x30]); // "V1.0"
			const tree = decodeStructRich(bytes, def, { baseOffset: 0, catalog: emptyCatalog });
			expect(find(tree, "tag")!.value).to.equal("V1.0");
		});
	});

	describe("compu (scaling + enum)", () => {
		it("applies linear factor/offset", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "temp", type: "u8", compu: { offset: -80 }, unit: "°C" }],
			};
			const tree = decodeStructRich(new Uint8Array([100]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "temp")!.value).to.equal(20);
			expect(find(tree, "temp")!.unit).to.equal("°C");
		});

		it("resolves enum labels from the catalog by raw value", () => {
			const catalog: NvmStructCatalog = {
				structs: {},
				enums: { Reset: { name: "Reset", values: { "0": "NONE", "2": "WATCHDOG" } } },
			};
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "reason", type: "u16", compu: { enum: "Reset" } }],
			};
			const tree = decodeStructRich(new Uint8Array([2, 0]), def, { baseOffset: 0, catalog });
			expect(find(tree, "reason")!.enumLabel).to.equal("WATCHDOG");
		});
	});

	describe("bitfields", () => {
		it("splits a backing byte MSB-first (big endian)", () => {
			// 0b1010_0101: hi nibble 0xA, lo nibble 0x5
			const def: NvmStructDef = {
				name: "S",
				endian: "big",
				fields: [
					{ name: "hi", type: "u8", bits: 4 },
					{ name: "lo", type: "u8", bits: 4 },
				],
			};
			const tree = decodeStructRich(new Uint8Array([0xa5]), def, {
				baseOffset: 10,
				catalog: emptyCatalog,
			});
			expect(find(tree, "hi")!.value).to.equal(0xa);
			expect(find(tree, "lo")!.value).to.equal(0x5);
			// Both share the same backing byte offset.
			expect(find(tree, "hi")!.offset).to.equal(10);
			expect(find(tree, "lo")!.offset).to.equal(10);
		});

		it("splits a backing byte LSB-first (little endian)", () => {
			const def: NvmStructDef = {
				name: "S",
				endian: "little",
				fields: [
					{ name: "lo", type: "u8", bits: 4 },
					{ name: "hi", type: "u8", bits: 4 },
				],
			};
			const tree = decodeStructRich(new Uint8Array([0xa5]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "lo")!.value).to.equal(0x5);
			expect(find(tree, "hi")!.value).to.equal(0xa);
		});
	});

	describe("arrays", () => {
		it("decodes a 1-D array with fixed count", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "regs", type: "u8", dims: [3] }],
			};
			const tree = decodeStructRich(new Uint8Array([1, 2, 3, 4]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			const arr = find(tree, "regs")!;
			expect(arr.type).to.equal("array");
			expect(arr.children).to.have.length(3);
			expect(arr.children![2].value).to.equal(3);
			expect(arr.children![2].offset).to.equal(2);
		});

		it("decodes a 2-D freeze frame [rows, cols]", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "snap", type: "u8", dims: [2, 3] }],
			};
			const bytes = new Uint8Array([10, 11, 12, 20, 21, 22]);
			const tree = decodeStructRich(bytes, def, { baseOffset: 0, catalog: emptyCatalog });
			const arr = find(tree, "snap")!;
			expect(arr.children).to.have.length(2);
			expect(arr.children![1].children).to.have.length(3);
			expect(arr.children![1].children![2].value).to.equal(22);
		});

		it("uses a sibling field as the array count", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [
					{ name: "count", type: "u8" },
					{ name: "items", type: "u8", dims: ["count"] },
				],
			};
			const tree = decodeStructRich(new Uint8Array([2, 0xaa, 0xbb, 0xcc]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "items")!.children).to.have.length(2);
		});
	});

	describe("nested structs & padding", () => {
		it("recurses into a nested struct after explicit padding", () => {
			const catalog: NvmStructCatalog = {
				structs: {
					Inner: { name: "Inner", fields: [{ name: "x", type: "u16" }] },
				},
				enums: {},
			};
			const def: NvmStructDef = {
				name: "Outer",
				endian: "little",
				fields: [
					{ name: "flag", type: "u8" },
					// skip one padding byte, then a nested struct
					{ name: "inner", struct: "Inner", padding: 1 },
				],
			};
			const bytes = new Uint8Array([0x01, 0xff, 0x34, 0x12]);
			const tree = decodeStructRich(bytes, def, { baseOffset: 0, catalog });
			const inner = find(tree, "inner")!;
			expect(inner.offset).to.equal(2);
			expect(find(tree, "x")!.value).to.equal(0x1234);
			expect(find(tree, "x")!.offset).to.equal(2);
		});

		it("honors explicit field offset", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [
					{ name: "a", type: "u8" },
					{ name: "z", type: "u8", offset: 4 },
				],
			};
			const tree = decodeStructRich(new Uint8Array([1, 0, 0, 0, 9]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "z")!.value).to.equal(9);
			expect(find(tree, "z")!.offset).to.equal(4);
		});
	});

	describe("robustness", () => {
		it("does not throw on a short read; clamps length", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "wide", type: "u32" }],
			};
			// only 2 bytes available for a 4-byte field
			const tree = decodeStructRich(new Uint8Array([0xaa, 0xbb]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "wide")!.length).to.equal(2);
		});

		it("handles an unknown nested struct gracefully", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [{ name: "n", struct: "Missing" }],
			};
			const tree = decodeStructRich(new Uint8Array([0]), def, {
				baseOffset: 0,
				catalog: emptyCatalog,
			});
			expect(find(tree, "n")!.value).to.contain("unknown struct");
		});
	});

	describe(".blk back-compat", () => {
		it("compiles and decodes a flat .blk identically to decodeStruct", () => {
			const blkText = [
				"Title;Unit;NrBts;Endian;Type;Opers",
				"Temperature;degC;8;msb;u8;-80",
				"Counter;-;16;lsb;u16;",
				"Rate;-;8;msb;u8;*0.5",
			].join("\n");
			const legacy = parseBlkStruct(blkText);
			const bytes = new Uint8Array([100, 0x34, 0x12, 10]);

			const legacyDecoded = decodeStruct(bytes, legacy);
			const rich = decodeStructRich(bytes, compileBlkToRich(legacy), {
				baseOffset: 0,
				catalog: emptyCatalog,
			});

			expect(find(rich, "Temperature")!.value).to.equal(legacyDecoded[0].value); // 20
			expect(find(rich, "Counter")!.value).to.equal(legacyDecoded[1].value); // 0x1234
			expect(find(rich, "Rate")!.value).to.equal(legacyDecoded[2].value); // 5
		});
	});

	describe("catalog helpers", () => {
		it("parseStructCatalog coerces untrusted JSON", () => {
			const cat = parseStructCatalog({
				structs: { A: { fields: [{ name: "x", type: "u8" }] } },
				enums: { E: { values: { "0": "OFF" } } },
				junk: 42,
			});
			expect(cat.structs.A.name).to.equal("A");
			expect(cat.enums.E.values["0"]).to.equal("OFF");
		});

		it("mergeCatalogs lets later entries win", () => {
			const a: NvmStructCatalog = {
				structs: { S: { name: "S", fields: [{ name: "x", type: "u8" }] } },
				enums: {},
			};
			const b: NvmStructCatalog = {
				structs: { S: { name: "S", fields: [{ name: "y", type: "u16" }] } },
				enums: {},
			};
			const merged = mergeCatalogs(a, b);
			expect(merged.structs.S.fields[0].name).to.equal("y");
		});
	});

	describe("natural C alignment + union + rich formats", () => {
		const catalog: NvmStructCatalog = {
			enums: {
				State: { name: "State", width: 4, values: { "2": "FS_VALID" } },
				Reset: { name: "Reset", width: 4, values: { "16400": "EXCEPT_FLOATING_POINT" } },
				Build: { name: "Build", values: { "16": "BT_RELEASE" } },
			},
			structs: {
				Mcu: {
					name: "Mcu",
					layout: "c",
					fields: [
						{ name: "ExceptionID", type: "u8" },
						{ name: "ExceptFlags", type: "u32", format: { kind: "hex" } },
						{ name: "InstrAddress", type: "u32", format: { kind: "hex" } },
					],
				},
				Shared: { name: "Shared", union: true, layout: "c", fields: [{ name: "Mcu", struct: "Mcu" }] },
				Top: {
					name: "Top",
					layout: "c",
					fields: [
						{ name: "MapVersion", type: "u8" },
						{ name: "State", type: "u32", compu: { enum: "State" } },
						{ name: "SharedInfoID", type: "u32" },
						{ name: "ResetReason", type: "u32", compu: { enum: "Reset" }, format: { kind: "enum", enum: "Reset" } },
						{ name: "Ctx", type: "u8", dims: [8], format: { kind: "ascii" } },
						{ name: "Cycle", type: "u32", format: { kind: "duration", unit: "ms" } },
						{ name: "SwVersion", type: "u32", format: { kind: "version", buildEnum: "Build" } },
						{ name: "Shared", struct: "Shared", discriminator: "SharedInfoID", cases: { "1": "Mcu", default: "Mcu" } },
					],
				},
			},
		};
		// MapVersion@0, State@4, SharedInfoID@8, ResetReason@12, Ctx@16..24, Cycle@24,
		// SwVersion@28, Shared(union)@32 → Mcu.ExceptionID@32, ExceptFlags@36, InstrAddress@40.
		const bytes = new Uint8Array([
			0x0f, 0, 0, 0, // MapVersion (+pad to 4)
			0x02, 0, 0, 0, // State = 2
			0x01, 0, 0, 0, // SharedInfoID = 1 (MCU)
			0x10, 0x40, 0, 0, // ResetReason = 0x4010
			0, 0, 0, 0x6f, 0, 0, 0, 0x5a, // Ctx[8]
			0xa3, 0x07, 0, 0, // Cycle = 1955
			0x8a, 0x16, 0x08, 0x10, // SwVersion bytes 138,22,8,build=0x10
			0x04, 0, 0, 0, // Mcu.ExceptionID = 4 (+pad)
			0xb3, 0x06, 0, 0, // ExceptFlags = 1715
			0x44, 0x8e, 0x15, 0x88, // InstrAddress = 0x88158E44
		]);
		const tree = decodeStructRich(bytes, catalog.structs.Top, { baseOffset: 0, catalog });

		it("aligns fields to natural C boundaries", () => {
			expect(find(tree, "State")!.offset).to.equal(4);
			expect(find(tree, "SharedInfoID")!.offset).to.equal(8);
			expect(find(tree, "ResetReason")!.offset).to.equal(12);
			expect(find(tree, "Cycle")!.offset).to.equal(24);
			expect(find(tree, "SwVersion")!.offset).to.equal(28);
		});

		it("resolves the union member from the discriminator", () => {
			expect(find(tree, "ExceptionID")!.offset).to.equal(32);
			expect(find(tree, "ExceptFlags")!.value).to.equal("0x000006B3");
			expect(find(tree, "InstrAddress")!.value).to.equal("0x88158E44");
		});

		it("applies version / duration / ascii / enum formatters", () => {
			expect(find(tree, "SwVersion")!.value).to.equal("138.022.008 RELEASE");
			expect(find(tree, "Cycle")!.value).to.equal("1955 ms - 00:00:01,955");
			expect(find(tree, "Ctx")!.value).to.equal("00 00 00 6F 00 00 00 5A - ...o...Z");
			expect(find(tree, "ResetReason")!.enumLabel).to.equal("EXCEPT_FLOATING_POINT");
			// State carries compu.enum (not format), which also resolves a label.
			expect(find(tree, "State")!.enumLabel).to.equal("FS_VALID");
		});

		it("expands a bitflags byte into per-bit children", () => {
			const def: NvmStructDef = {
				name: "S",
				fields: [
					{
						name: "Status",
						type: "u8",
						format: { kind: "bitflags", inline: { "0": "Test failed", "7": "Warning" } },
					},
				],
			};
			const t = decodeStructRich(new Uint8Array([0x81]), def, { baseOffset: 0, catalog: emptyCatalog });
			const status = find(t, "Status")!;
			expect(status.children).to.have.length(8);
			// High bit first.
			expect(status.children![0].name).to.contain("Warning");
			expect(status.children![0].value).to.equal(true);
			expect(status.children![7].value).to.equal(true); // bit 0 set
			expect(status.children![1].value).to.equal(false);
		});
	});

	describe("C header parser (parseCStructsEx)", () => {
		it("resolves #define/sizeof array sizes and function-macro enums", () => {
			const src = `
				#define N 8u
				#define RESET_REASON(number,class)  (((number) & 0x3FFF) | (((class) << 14) & 0xC000))
				typedef enum {
					FS_RESET_NONE = RESET_REASON(0u, 0),
					FS_RESET_EXCEPT_FLOATING_POINT = RESET_REASON(16u, 1)
				} FS_Reset_t_ResetReason;
				typedef struct {
					uint8  MapVersion;
					uint32 Cycle;
					uint8  Ctx[N];
					uint32 Reserved[N / sizeof(uint32)];
					uint8  Flags : 4;
					uint8  More  : 4;
				} T;
			`;
			const { catalog, diagnostics } = parseCStructsEx(src);
			expect(diagnostics).to.have.length(0);
			// Function-macro enum evaluated: class 1 << 14 | 16 = 0x4010 = 16400.
			expect(catalog.enums.FS_Reset_t_ResetReason.values["16400"]).to.equal(
				"FS_RESET_EXCEPT_FLOATING_POINT",
			);
			const t = catalog.structs.T;
			expect(t.layout).to.equal("c");
			const ctx = t.fields.find(f => f.name === "Ctx")!;
			expect(ctx.dims).to.deep.equal([8]);
			const reserved = t.fields.find(f => f.name === "Reserved")!;
			expect(reserved.dims).to.deep.equal([2]); // 8 / sizeof(uint32=4)
			const flags = t.fields.find(f => f.name === "Flags")!;
			expect(flags.bits).to.equal(4);
		});

		it("parses enum-typed fields, anonymous nested struct arrays, and strips VAR macros", () => {
			const src = `
				typedef enum { A = 0, B = 1 } E;
				typedef struct {
					E kind;
					struct { uint16 lo; uint16 hi; } items[3];
					VAR(uint32, AUTOMATIC) count;
				} Rec;
			`;
			const { catalog } = parseCStructsEx(src);
			const rec = catalog.structs.Rec;
			const kind = rec.fields.find(f => f.name === "kind")!;
			expect(kind.type).to.equal("u32"); // enum → u32 + compu.enum
			expect(kind.compu?.enum).to.equal("E");
			const items = rec.fields.find(f => f.name === "items")!;
			expect(items.struct).to.equal("Rec__items");
			expect(items.dims).to.deep.equal([3]);
			expect(catalog.structs["Rec__items"].fields.map(f => f.name)).to.deep.equal(["lo", "hi"]);
			const count = rec.fields.find(f => f.name === "count")!;
			expect(count.type).to.equal("u32"); // VAR(...) stripped
		});

		it("reports diagnostics for unresolvable types instead of throwing", () => {
			const { diagnostics } = parseCStructsEx(`typedef struct { SomeUnknownType x; } Q;`);
			expect(diagnostics.some(d => d.includes("SomeUnknownType"))).to.equal(true);
		});
	});
});
