/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import { importNvmCatalog, parseEcucModule, parseXml } from "../../shared/nvm";

describe("NVM ARXML import", () => {
	describe("parseXml", () => {
		it("builds a tree with text and attributes", () => {
			const root = parseXml(
				`<?xml version="1.0"?><A x="1"><B>hello</B><C/></A>`,
			);
			const a = root.children[0];
			expect(a.tag).to.equal("A");
			expect(a.attrs.x).to.equal("1");
			expect(a.children[0].tag).to.equal("B");
			expect(a.children[0].text).to.equal("hello");
			expect(a.children[1].tag).to.equal("C");
		});

		it("decodes entities and skips comments", () => {
			const root = parseXml(`<A><!-- c --><B>a &amp; b &lt;x&gt;</B></A>`);
			expect(root.children[0].children[0].text).to.equal("a & b <x>");
		});
	});

	// Minimal but structurally faithful MICROSAR ECUC fragments.
	const nvmXml = `
	<AUTOSAR><AR-PACKAGES><AR-PACKAGE><ELEMENTS>
	<ECUC-MODULE-CONFIGURATION-VALUES>
	  <SHORT-NAME>NvM</SHORT-NAME>
	  <DEFINITION-REF DEST="ECUC-MODULE-DEF">/MICROSAR/NvM</DEFINITION-REF>
	  <CONTAINERS>
	    <ECUC-CONTAINER-VALUE>
	      <SHORT-NAME>NvMBlockDescriptor_RollBack_Result</SHORT-NAME>
	      <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/NvM/NvMBlockDescriptor</DEFINITION-REF>
	      <PARAMETER-VALUES>
	        <ECUC-TEXTUAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-ENUMERATION-PARAM-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMBlockManagementType</DEFINITION-REF>
	          <VALUE>NVM_BLOCK_NATIVE</VALUE>
	        </ECUC-TEXTUAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-BOOLEAN-PARAM-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMBlockUseCrc</DEFINITION-REF>
	          <VALUE>true</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	        <ECUC-TEXTUAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-ENUMERATION-PARAM-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMBlockCrcType</DEFINITION-REF>
	          <VALUE>NVM_CRC16</VALUE>
	        </ECUC-TEXTUAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMNvBlockLength</DEFINITION-REF>
	          <VALUE>32</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMNvramBlockIdentifier</DEFINITION-REF>
	          <VALUE>75</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	      </PARAMETER-VALUES>
	      <SUB-CONTAINERS>
	        <ECUC-CONTAINER-VALUE>
	          <SHORT-NAME>NvMTargetBlockReference</SHORT-NAME>
	          <DEFINITION-REF DEST="ECUC-CHOICE-CONTAINER-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMTargetBlockReference</DEFINITION-REF>
	          <SUB-CONTAINERS>
	            <ECUC-CONTAINER-VALUE>
	              <SHORT-NAME>NvMFeeRef</SHORT-NAME>
	              <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMTargetBlockReference/NvMFeeRef</DEFINITION-REF>
	              <REFERENCE-VALUES>
	                <ECUC-REFERENCE-VALUE>
	                  <DEFINITION-REF DEST="ECUC-SYMBOLIC-NAME-REFERENCE-DEF">/MICROSAR/NvM/NvMBlockDescriptor/NvMTargetBlockReference/NvMFeeRef/NvMNameOfFeeBlock</DEFINITION-REF>
	                  <VALUE-REF DEST="ECUC-CONTAINER-VALUE">/ActiveEcuC/Fee/FeeNvMBlockDescriptor_RollBack_Result</VALUE-REF>
	                </ECUC-REFERENCE-VALUE>
	              </REFERENCE-VALUES>
	            </ECUC-CONTAINER-VALUE>
	          </SUB-CONTAINERS>
	        </ECUC-CONTAINER-VALUE>
	      </SUB-CONTAINERS>
	    </ECUC-CONTAINER-VALUE>
	  </CONTAINERS>
	</ECUC-MODULE-CONFIGURATION-VALUES>
	</ELEMENTS></AR-PACKAGE></AR-PACKAGES></AUTOSAR>`;

	const feeXml = `
	<AUTOSAR><AR-PACKAGES><AR-PACKAGE><ELEMENTS>
	<ECUC-MODULE-CONFIGURATION-VALUES>
	  <SHORT-NAME>Fee</SHORT-NAME>
	  <DEFINITION-REF DEST="ECUC-MODULE-DEF">/MICROSAR/Fee</DEFINITION-REF>
	  <CONTAINERS>
	    <ECUC-CONTAINER-VALUE>
	      <SHORT-NAME>FeeNvMBlockDescriptor_RollBack_Result</SHORT-NAME>
	      <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/Fee/FeeBlockConfiguration</DEFINITION-REF>
	      <PARAMETER-VALUES>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fee/FeeBlockConfiguration/FeeBlockNumber</DEFINITION-REF>
	          <VALUE>44</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fee/FeeBlockConfiguration/FeeBlockSize</DEFINITION-REF>
	          <VALUE>34</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fee/FeeBlockConfiguration/FeeNumberOfChunkInstances</DEFINITION-REF>
	          <VALUE>1</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fee/FeeBlockConfiguration/FeeNumberOfDatasets</DEFINITION-REF>
	          <VALUE>1</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	      </PARAMETER-VALUES>
	    </ECUC-CONTAINER-VALUE>
	    <ECUC-CONTAINER-VALUE>
	      <SHORT-NAME>FeeGeneral</SHORT-NAME>
	      <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/Fee/FeeGeneral</DEFINITION-REF>
	      <PARAMETER-VALUES>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fee/FeeGeneral/FeeVirtualPageSize</DEFINITION-REF>
	          <VALUE>8</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	      </PARAMETER-VALUES>
	    </ECUC-CONTAINER-VALUE>
	  </CONTAINERS>
	</ECUC-MODULE-CONFIGURATION-VALUES>
	</ELEMENTS></AR-PACKAGE></AR-PACKAGES></AUTOSAR>`;

	const flsXml = `
	<AUTOSAR><AR-PACKAGES><AR-PACKAGE><ELEMENTS>
	<ECUC-MODULE-CONFIGURATION-VALUES>
	  <SHORT-NAME>Fls_30_vMemAccM</SHORT-NAME>
	  <DEFINITION-REF DEST="ECUC-MODULE-DEF">/MICROSAR/Fls_30_vMemAccM</DEFINITION-REF>
	  <CONTAINERS>
	    <ECUC-CONTAINER-VALUE>
	      <SHORT-NAME>FlsGeneral</SHORT-NAME>
	      <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsGeneral</DEFINITION-REF>
	      <PARAMETER-VALUES>
	        <ECUC-NUMERICAL-PARAM-VALUE>
	          <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsGeneral/FlsBaseAddress</DEFINITION-REF>
	          <VALUE>0x3a0000</VALUE>
	        </ECUC-NUMERICAL-PARAM-VALUE>
	      </PARAMETER-VALUES>
	    </ECUC-CONTAINER-VALUE>
	    <ECUC-CONTAINER-VALUE>
	      <SHORT-NAME>FlsConfigSet</SHORT-NAME>
	      <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsConfigSet</DEFINITION-REF>
	      <SUB-CONTAINERS>
	        <ECUC-CONTAINER-VALUE>
	          <SHORT-NAME>FlsSector_0</SHORT-NAME>
	          <DEFINITION-REF DEST="ECUC-PARAM-CONF-CONTAINER-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsConfigSet/FlsSectorList/FlsSector</DEFINITION-REF>
	          <PARAMETER-VALUES>
	            <ECUC-NUMERICAL-PARAM-VALUE>
	              <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsConfigSet/FlsSectorList/FlsSector/FlsNumberOfSectors</DEFINITION-REF>
	              <VALUE>1</VALUE>
	            </ECUC-NUMERICAL-PARAM-VALUE>
	            <ECUC-NUMERICAL-PARAM-VALUE>
	              <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsConfigSet/FlsSectorList/FlsSector/FlsSectorSize</DEFINITION-REF>
	              <VALUE>0x30000</VALUE>
	            </ECUC-NUMERICAL-PARAM-VALUE>
	            <ECUC-NUMERICAL-PARAM-VALUE>
	              <DEFINITION-REF DEST="ECUC-INTEGER-PARAM-DEF">/MICROSAR/Fls_30_vMemAccM/Fls/FlsConfigSet/FlsSectorList/FlsSector/FlsSectorStartaddress</DEFINITION-REF>
	              <VALUE>0x3a0000</VALUE>
	            </ECUC-NUMERICAL-PARAM-VALUE>
	          </PARAMETER-VALUES>
	        </ECUC-CONTAINER-VALUE>
	      </SUB-CONTAINERS>
	    </ECUC-CONTAINER-VALUE>
	  </CONTAINERS>
	</ECUC-MODULE-CONFIGURATION-VALUES>
	</ELEMENTS></AR-PACKAGE></AR-PACKAGES></AUTOSAR>`;

	describe("parseEcucModule", () => {
		it("extracts containers, params and references", () => {
			const module = parseEcucModule(nvmXml);
			expect(module.shortName).to.equal("NvM");
			expect(module.containers).to.have.length(1);
			const block = module.containers[0];
			expect(block.definition).to.equal("NvMBlockDescriptor");
			expect(block.params.NvMNvramBlockIdentifier).to.equal("75");
			expect(block.subContainers[0].definition).to.equal("NvMTargetBlockReference");
		});
	});

	describe("importNvmCatalog", () => {
		it("joins NvM + Fee + Fls into a block catalog", () => {
			const catalog = importNvmCatalog({ nvm: nvmXml, fee: feeXml, fls: flsXml });
			expect(catalog.blocks).to.have.length(1);
			const b = catalog.blocks[0];
			expect(b.name).to.equal("NvMBlockDescriptor_RollBack_Result");
			expect(b.nvmId).to.equal(75);
			expect(b.payloadLength).to.equal(32);
			expect(b.useCrc).to.equal(true);
			expect(b.crcWidth).to.equal(16);
			expect(b.managementType).to.equal("NATIVE");
			expect(b.feeBlockName).to.equal("FeeNvMBlockDescriptor_RollBack_Result");
			expect(b.feeBlockNumber).to.equal(44);
			expect(b.feeBlockSize).to.equal(34);
			expect(b.instanceExponent).to.equal(1);
			expect(b.instances).to.equal(1); // 2^1 - 1
			expect(catalog.virtualPageSize).to.equal(8);
			expect(catalog.memory?.baseAddress).to.equal(0x3a0000);
			expect(catalog.memory?.sectors[0].sectorSize).to.equal(0x30000);
		});

		it("works without Fee/Fls sources", () => {
			const catalog = importNvmCatalog({ nvm: nvmXml });
			expect(catalog.blocks[0].feeBlockNumber).to.equal(undefined);
			expect(catalog.memory).to.equal(undefined);
		});
	});
});
