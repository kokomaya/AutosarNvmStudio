/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import {
	fingerprintBlock,
	nameFamilyGlob,
	NvmCustomView,
	resolveCustomView,
	selectBlocks,
	findNode,
} from "../../shared/nvm/customView";
import { NvmBlockInfo } from "../../shared/protocol";
import { NvmDecodedNode } from "../../shared/nvm/structRich";
import { coerceViewSet } from "../nvm/customViews/model";

/**
 * Build a synthetic decoded block. Deliberately vendor-NEUTRAL: no real vendor
 * names appear — the resolver/fingerprint must work on any named field tree.
 */
function block(
	id: string,
	name: string,
	offset: number,
	tag: string,
	decoded: NvmDecodedNode[],
): NvmBlockInfo {
	return {
		id,
		name,
		offset,
		length: 0x40,
		identity: { key: `tag:${tag}`, label: name },
		decoded,
	};
}

function leaf(name: string, offset: number, value: string | number, extra?: Partial<NvmDecodedNode>): NvmDecodedNode {
	return { name, type: "u32", offset, length: 4, value, ...extra };
}

/** Two shape-A blocks (Record0/1, same struct, different tags), one shape-B, one shapeless. */
function sampleBlocks(): NvmBlockInfo[] {
	const shapeA = (id: string, nm: string, off: number, tag: string, reason: string, counter: number) =>
		block(id, nm, off, tag, [
			leaf("Reason", off, reason, { enumLabel: reason }),
			leaf("Counter", off + 4, counter, { unit: "ms" }),
			{
				name: "Info",
				type: "Info",
				offset: off + 8,
				length: 8,
				children: [leaf("Version", off + 8, "1.2.3")],
			},
		]);
	const a0 = shapeA("a0", "Record0", 0x100, "0x10", "PowerOn", 1955);
	const a1 = shapeA("a1", "Record1", 0x200, "0x11", "Watchdog", 42);
	// Shape B: different field set → different fingerprint.
	const b0 = block("b0", "DemBlock0", 0x300, "0x20", [
		leaf("EventId", 0x300, 7),
		leaf("Status", 0x304, "0x2B", { hex: "0x2B" }),
	]);
	const b1 = block("b1", "DemBlock1", 0x400, "0x21", [
		leaf("EventId", 0x400, 9),
		leaf("Status", 0x404, "0x00", { hex: "0x00" }),
	]);
	// A block with no decoded tree → fingerprint "none".
	const plain: NvmBlockInfo = { id: "p0", name: "Plain", offset: 0x500, length: 8 };
	return [a1, a0, b1, b0, plain]; // deliberately out of offset order
}

function view(groups: NvmCustomView["groups"]): NvmCustomView {
	return {
		id: "v1",
		name: "My View",
		scope: "dump",
		groups,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("NVM custom view (whole-block, fingerprint grouping)", () => {
	describe("fingerprintBlock", () => {
		it("is equal for structurally identical blocks, different for others", () => {
			const [a1, a0, b1, b0, plain] = sampleBlocks();
			expect(fingerprintBlock(a0)).to.equal(fingerprintBlock(a1));
			expect(fingerprintBlock(b0)).to.equal(fingerprintBlock(b1));
			expect(fingerprintBlock(a0)).to.not.equal(fingerprintBlock(b0));
			expect(fingerprintBlock(plain)).to.equal("none");
		});

		it("is stable regardless of values (only shape matters)", () => {
			const x = block("x", "X", 0, "0x1", [leaf("F", 0, 1)]);
			const y = block("y", "Y", 0x40, "0x2", [leaf("F", 0x40, 999)]);
			expect(fingerprintBlock(x)).to.equal(fingerprintBlock(y));
		});
	});

	describe("selectBlocks by fingerprint", () => {
		it("pulls in the whole structural family, offset-sorted", () => {
			const blocks = sampleBlocks();
			const fp = fingerprintBlock(blocks.find(b => b.id === "a0")!);
			const got = selectBlocks({ by: "fingerprint", value: fp }, blocks);
			expect(got.map(b => b.id)).to.deep.equal(["a0", "a1"]);
		});

		it("never groups structureless blocks together via the 'none' sentinel", () => {
			// Several blocks with no decoded tree all fingerprint to "none". A
			// fingerprint selector of "none" must match NONE of them (else every
			// structureless block would collapse into one bogus group).
			const p0: NvmBlockInfo = { id: "p0", name: "DemStatusDataBlock", offset: 0, length: 8 };
			const p1: NvmBlockInfo = { id: "p1", name: "NVM_DTC_DEM_INFO", offset: 0x40, length: 8 };
			const p2: NvmBlockInfo = { id: "p2", name: "DemAdminDataBlock", offset: 0x80, length: 8 };
			expect(fingerprintBlock(p0)).to.equal("none");
			expect(selectBlocks({ by: "fingerprint", value: "none" }, [p0, p1, p2])).to.deep.equal([]);
		});
	});

	describe("nameFamilyGlob", () => {
		it("groups only a name's numeric siblings, not unrelated names", () => {
			// A structureless DemPrimaryDataBlock5 must group with its indexed
			// siblings — and ONLY them — by name family, never with other DEM blocks.
			expect(nameFamilyGlob("DemPrimaryDataBlock5")).to.equal("DemPrimaryDataBlock*");
			const blocks: NvmBlockInfo[] = [
				{ id: "d0", name: "DemPrimaryDataBlock0", offset: 0, length: 8 },
				{ id: "d5", name: "DemPrimaryDataBlock5", offset: 0x40, length: 8 },
				{ id: "s0", name: "DemStatusDataBlock", offset: 0x80, length: 8 },
				{ id: "a0", name: "DemAdminDataBlock", offset: 0xc0, length: 8 },
			];
			const got = selectBlocks(
				{ by: "nameGlob", value: nameFamilyGlob("DemPrimaryDataBlock5") },
				blocks,
			);
			expect(got.map(b => b.id)).to.deep.equal(["d0", "d5"]);
		});

		it("leaves a name with no trailing digits unchanged (matches only itself)", () => {
			expect(nameFamilyGlob("DemStatusDataBlock")).to.equal("DemStatusDataBlock");
		});
	});

	describe("findNode", () => {
		it("descends a name path into nested children", () => {
			const b = sampleBlocks().find(x => x.id === "a0")!;
			expect(findNode(b.decoded, ["Info", "Version"])?.value).to.equal("1.2.3");
		});
		it("returns undefined for an absent path", () => {
			const b = sampleBlocks().find(x => x.id === "a0")!;
			expect(findNode(b.decoded, ["Info", "Missing"])).to.equal(undefined);
		});
	});

	describe("resolveCustomView", () => {
		it("makes one sub-table per group with auto-derived flattened columns", () => {
			const blocks = sampleBlocks();
			const fpA = fingerprintBlock(blocks.find(b => b.id === "a0")!);
			const fpB = fingerprintBlock(blocks.find(b => b.id === "b0")!);
			const r = resolveCustomView(
				view([
					{ by: "fingerprint", value: fpA, label: "Record" },
					{ by: "fingerprint", value: fpB, label: "DemBlock" },
				]),
				blocks,
			);
			expect(r.groups).to.have.length(2);

			const gA = r.groups[0];
			expect(gA.matchedBlocks).to.equal(2);
			// Nested Info.Version is flattened into its own column.
			expect(gA.columns.map(c => c.key)).to.deep.equal(["Reason", "Counter", "Info.Version"]);
			expect(gA.rows.map(row => row.blockLabel)).to.deep.equal(["Record0", "Record1"]);
			// Cell text + click-to-reveal offset.
			expect(gA.rows[0].cells["Counter"].text).to.equal("1955 ms");
			expect(gA.rows[0].cells["Info.Version"].text).to.equal("1.2.3");
			expect(gA.rows[0].cells["Reason"].offset).to.equal(0x100);

			const gB = r.groups[1];
			expect(gB.columns.map(c => c.label)).to.deep.equal(["EventId", "Status"]);
			expect(gB.rows.map(row => row.blockLabel)).to.deep.equal(["DemBlock0", "DemBlock1"]);
		});

		it("leaves empty cells for fields absent on some blocks (column union)", () => {
			// One block has an extra field the other lacks; both share a base shape,
			// but since fingerprints differ we select them by id into one group via glob.
			const b0 = block("m0", "M0", 0, "0x1", [leaf("A", 0, 1)]);
			const b1 = block("m1", "M1", 0x40, "0x2", [leaf("A", 0x40, 2), leaf("B", 0x44, 3)]);
			const r = resolveCustomView(view([{ by: "nameGlob", value: "M*" }]), [b0, b1]);
			const g = r.groups[0];
			expect(g.columns.map(c => c.key)).to.deep.equal(["A", "B"]);
			// M0 lacks B → empty cell, row kept.
			const row0 = g.rows.find(x => x.blockLabel === "M0")!;
			expect(row0.cells["B"].text).to.equal("");
			expect(row0.cells["B"].offset).to.equal(undefined);
		});
	});

	describe("coerceViewSet", () => {
		it("normalizes partial / malformed sets and rejects bad selectors", () => {
			const set = coerceViewSet({
				views: [
					{
						id: "x",
						name: "OK",
						scope: "template",
						groups: [
							{ by: "fingerprint", value: "abc" },
							{ by: "bogus", value: "z" }, // dropped
						],
					},
					{ name: "no id" }, // dropped
					"garbage", // dropped
					{ id: "y", name: "Defaults" }, // filled
				],
			});
			expect(set.views.map(v => v.id)).to.deep.equal(["x", "y"]);
			expect(set.views[0].scope).to.equal("template");
			expect(set.views[0].groups.map(g => g.by)).to.deep.equal(["fingerprint"]);
			expect(set.views[1].scope).to.equal("dump");
			expect(set.views[1].groups).to.deep.equal([]);
		});

		it("returns an empty set for junk input", () => {
			expect(coerceViewSet(undefined).views).to.deep.equal([]);
			expect(coerceViewSet({ views: "nope" }).views).to.deep.equal([]);
		});
	});
});
