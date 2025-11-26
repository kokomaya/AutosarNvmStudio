/*---------------------------------------------------------
 * Lightweight tests for the NVM ARXML parser and block mapper.
 *--------------------------------------------------------*/

import { expect } from "chai";
import { join } from "path";
import { parseArxmlFile } from "../nvm/arxmlParser";
import { mapBlocksToBuffer } from "../nvm/blockMapper";

describe("NVM ARXML parser and mapper", () => {
    it("parses sample ARXML and maps blocks", async () => {
        const fixture = join(__dirname, "..", "..", "test", "fixtures", "sample_nvm.arxml");
    const blocks = (await parseArxmlFile(fixture)) as any[];
    expect(blocks).to.be.an("array");
    expect(blocks.length).to.equal(2);
    // Ensure we found BlockA and BlockB
    const ids = blocks.map(b => b.id || (b.raw && (b.raw["SHORT-NAME"] || b.raw["short-name"])));
    expect(ids.join(",")).to.match(/BlockA/);

    // Map to a buffer of length 200
    const mapped = mapBlocksToBuffer(200, blocks as any[], 0);
        expect(mapped).to.be.an("array");
        expect(mapped.length).to.equal(2);
        // Verify offsets and lengths are reasonable
        expect(mapped[0].offset).to.equal(0);
        expect(mapped[0].length).to.equal(16);
        expect(mapped[1].offset).to.equal(64);
        expect(mapped[1].length).to.equal(32);
    });
});
