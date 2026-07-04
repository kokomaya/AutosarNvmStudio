/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import {
    buildFeeV3Model,
    MemoryImage,
    parseFeeLcfg,
    parseVectorFeeV3,
} from "../../shared/nvm";

const LCFG_SAMPLE = `
CONST(struct Fee_BlockConfigStruct, FEE_APPL_CONFIG) Fee_BlockConfig_at[] =
{
  { /*  Block: TestBlockOne  */
    1u /*  index of the block in the linktable  */ ,
    8u /*  payload length  */ ,
    1u /*  number of datasets  */ ,
    FeePartitionConfiguration /*  partition  */ ,
    1u /*  the exponent of the number of instances per chunk (2^n)-1  */ ,
    FALSE /*  immediate data  */ ,
    FALSE /*  critical data  */ ,
    FALSE /*  look up table block  */ ,
    0u /*  base index  */
  },
  { /*  Block: NvM_BLOCK_VIN  */
    70u /*  index of the block in the linktable  */ ,
    48u /*  payload length  */ ,
    1u ,
    FeePartitionConfiguration ,
    1u ,
    FALSE ,
    TRUE ,
    FALSE ,
    0u
  },
};
`;

describe("Vector FEE V3", () => {
	describe("parseFeeLcfg", () => {
		it("extracts block index, payload length and name", () => {
			const blocks = parseFeeLcfg(LCFG_SAMPLE);
			expect(blocks).to.have.length(2);
			expect(blocks[0]).to.include({ blkIdx: 1, payloadLength: 8, name: "TestBlockOne" });
			expect(blocks[1]).to.include({ blkIdx: 70, payloadLength: 48, name: "NvM_BLOCK_VIN" });
			expect(blocks[1].criticalData).to.equal(true);
		});
	});

	describe("parseVectorFeeV3", () => {
		// Build a minimal single-sector FEE V3 image (alignment 8, base 0x3a0000).
		// Layout: sector header (id, ltSize=2), link table with slot 0 empty and
		// slot 1 pointing to one chunk carrying an 8-byte "ABCDEFGH" payload.
		function buildImage(): MemoryImage {
			const base = 0x3a0000;
			const buf = new Uint8Array(128).fill(0xff);

			// Sector header: id=0xc5, ltSize = (bh<<4)|bl = 2.
			buf[0] = 0xc5;
			buf[1] = 0x00;
			buf[2] = 0x02;

			// Link table starts at alignment (flat 8), two 8-byte slots.
			// Slot 0 (flat 8..15) left as 0xFF => empty.
			// Slot 1 (flat 16..23): linkTarget=0x3a0061, pldSz=8.
			const linkTarget = 0x3a0061;
			buf[16] = linkTarget & 0xff;
			buf[17] = (linkTarget >> 8) & 0xff;
			buf[18] = (linkTarget >> 16) & 0xff;
			buf[19] = (linkTarget >> 24) & 0xff;
			buf[20] = 8; // pldSz LE
			buf[21] = 0;

			// Chunk header at flat 64: tag=1, size=8.
			buf[64] = 0x01;
			buf[65] = 0x00;
			buf[66] = 0x00;
			buf[67] = 0x00;
			buf[68] = 0x08; // size LE
			buf[69] = 0x00;
			buf[70] = 0x00;
			buf[71] = 0x00;

			// Start marker + payload + end marker.
			buf[80] = 0x0a;
			const payload = [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48];
			payload.forEach((b, i) => (buf[81 + i] = b));
			buf[89] = 0x0a;

			return new MemoryImage([{ address: base, data: buf }]);
		}

		it("recovers a block from the link table", () => {
			const result = parseVectorFeeV3(buildImage(), { numberOfSectors: 1 });
			expect(result.chunks).to.have.length(1);
			const chunk = result.chunks[0];
			expect(chunk.tag).to.equal(1);
			expect(chunk.slotIndex).to.equal(1);
			expect(chunk.consistent).to.equal(true); // slot index 1 matches tag 1
			expect(chunk.headerAddress).to.equal(0x3a0000 + 64);
			expect(chunk.payloadAddress).to.equal(0x3a0000 + 81);
			expect(Array.from(chunk.data)).to.deep.equal([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);
		});

		it("builds an NvmModel with resolved names", () => {
			const model = buildFeeV3Model(buildImage(), {
				numberOfSectors: 1,
				feeLcfgSource: LCFG_SAMPLE,
			});
			expect(model.blocks).to.have.length(1);
			expect(model.blocks[0].name).to.equal("TestBlockOne");
			expect(model.blocks[0].active.payloadRange).to.deep.equal({
				start: 0x3a0000 + 81,
				end: 0x3a0000 + 81 + 8,
			});
		});
	});
});
