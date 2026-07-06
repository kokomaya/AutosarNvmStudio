/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from "chai";
import { parseDefineEnum, parseDefineEnumByName } from "../../shared/nvm/defineEnum";

// A slice mirroring a real AUTOSAR Dem_Lcfg.h "symbolic name value" table.
const DEM_HEADER = `
 /*  Event IDs [symbolic name value] - sorted by name.  */
#define DemConf_DemEventParameter_ADC_E_HARDWARE_ERROR                146u
#define DemConf_DemEventParameter_ALN_SENSOR_NEVER_ALIGNED             1u
#define DemConf_DemEventParameter_CANSM_E_BUSOFF_NETWORK_0             2u
#define DemConf_DemEventParameter_DEM_CRC_ERROR_0x15D                 20u
#define SomeOtherMacro_NOT_AN_EVENT                                   99u
#define DemConf_DemEventParameter_HEX_CODED                          0x2Au
`;

describe("parseDefineEnum (generic #define table scraper)", () => {
	it("maps value → name for a prefixed #define table, stripping the prefix", () => {
		const { values } = parseDefineEnum(DEM_HEADER, "DemConf_DemEventParameter_");
		expect(values["146"]).to.equal("ADC_E_HARDWARE_ERROR");
		expect(values["1"]).to.equal("ALN_SENSOR_NEVER_ALIGNED");
		expect(values["2"]).to.equal("CANSM_E_BUSOFF_NETWORK_0");
		expect(values["20"]).to.equal("DEM_CRC_ERROR_0x15D");
	});

	it("accepts hex values and integer suffixes", () => {
		const { values } = parseDefineEnum(DEM_HEADER, "DemConf_DemEventParameter_");
		expect(values["42"]).to.equal("HEX_CODED"); // 0x2Au
	});

	it("ignores #defines that don't match the prefix", () => {
		const { values } = parseDefineEnum(DEM_HEADER, "DemConf_DemEventParameter_");
		expect(Object.values(values)).to.not.include("NOT_AN_EVENT");
	});

	it("returns an empty map for empty source or empty prefix", () => {
		expect(parseDefineEnum("", "X_").values).to.deep.equal({});
		expect(parseDefineEnum(DEM_HEADER, "").values).to.deep.equal({});
	});

	it("keeps the FIRST name when two names share a value", () => {
		const src = `
#define P_ALPHA 5u
#define P_BETA  5u
`;
		expect(parseDefineEnum(src, "P_").values["5"]).to.equal("ALPHA");
	});

	it("parseDefineEnumByName inverts to name → value", () => {
		const byName = parseDefineEnumByName(DEM_HEADER, "DemConf_DemEventParameter_");
		expect(byName.get("ADC_E_HARDWARE_ERROR")).to.equal(146);
		expect(byName.get("HEX_CODED")).to.equal(42);
		expect(byName.has("NOT_AN_EVENT")).to.equal(false);
	});
});
