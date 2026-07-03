// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Import a MICROSAR (Vector) NVM block catalog directly from the ECUC ARXML
 * (NvM + Fee + optional Fls_30_vMemAccM), without touching generated C files.
 *
 * The catalog describes every logical block (id, name, payload length, CRC,
 * management type) joined with its Fee configuration (link-table block number,
 * chunk instance count, datasets) and the physical memory layout (base address
 * and sectors). It is the bridge between AUTOSAR configuration and the Vector
 * FEE container parser (a later milestone) as well as directly useful today.
 *
 * See docs/design.md §6 L5 and the Vendor TODOs.
 */

import { EcucContainer, EcucModule, findSubContainer, lastSegment, parseEcucModule } from "./ecuc";

export interface NvmCatalogBlock {
	/** NvM block SHORT-NAME. */
	name: string;
	/** NvMNvramBlockIdentifier. */
	nvmId?: number;
	/** NvMNvBlockLength (payload length in bytes, excluding CRC/MAC). */
	payloadLength?: number;
	useCrc: boolean;
	/** CRC width in bits derived from NvMBlockCrcType (8/16/32). */
	crcWidth?: number;
	/** NvMBlockManagementType (NATIVE / REDUNDANT / DATASET). */
	managementType?: string;
	resistantToChangedSw: boolean;
	/** NvMNvBlockNum (number of datasets/instances at the NvM level). */
	nvBlockNum?: number;

	/** Joined Fee block SHORT-NAME (via NvMNameOfFeeBlock reference). */
	feeBlockName?: string;
	/** FeeBlockNumber (index in the link table). */
	feeBlockNumber?: number;
	/** FeeBlockSize. */
	feeBlockSize?: number;
	/** FeeNumberOfChunkInstances — the exponent n; instances = 2^n - 1. */
	instanceExponent?: number;
	/** Effective number of stored chunk instances (2^n - 1). */
	instances?: number;
	/** FeeNumberOfDatasets. */
	feeDatasets?: number;
}

export interface NvmMemorySector {
	startAddress: number;
	sectorSize: number;
	numberOfSectors: number;
}

export interface NvmCatalog {
	blocks: NvmCatalogBlock[];
	/** FeeVirtualPageSize, when the Fee module was provided. */
	virtualPageSize?: number;
	/** Physical memory layout from Fls_30_vMemAccM, when provided. */
	memory?: {
		baseAddress?: number;
		sectors: NvmMemorySector[];
	};
}

export interface NvmArxmlSources {
	nvm: string;
	fee?: string;
	fls?: string;
}

function parseNum(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") {
		return undefined;
	}
	const trimmed = value.trim();
	const parsed = /^0x/i.test(trimmed) ? parseInt(trimmed, 16) : Number(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function isTrue(value: string | undefined): boolean {
	return (value ?? "").toLowerCase() === "true" || value === "1";
}

function crcWidthOf(crcType: string | undefined): number | undefined {
	if (!crcType) {
		return undefined;
	}
	const match = /(\d+)/.exec(crcType);
	return match ? parseInt(match[1], 10) : undefined;
}

/** Index Fee block-configuration containers by SHORT-NAME. */
function indexFeeBlocks(fee: EcucModule | undefined): Map<string, EcucContainer> {
	const map = new Map<string, EcucContainer>();
	if (!fee) {
		return map;
	}
	for (const container of fee.containers) {
		if (container.definition === "FeeBlockConfiguration") {
			map.set(container.shortName, container);
		}
	}
	return map;
}

function feeGeneralVirtualPageSize(fee: EcucModule | undefined): number | undefined {
	const general = fee?.containers.find(c => c.definition === "FeeGeneral");
	return parseNum(general?.params.FeeVirtualPageSize);
}

/** Resolve the referenced Fee block SHORT-NAME for an NvM block. */
function resolveFeeBlockName(nvmBlock: EcucContainer): string | undefined {
	const feeRef = findSubContainer(nvmBlock, "NvMFeeRef");
	const target = feeRef?.references.NvMNameOfFeeBlock?.[0];
	return target ? lastSegment(target) : undefined;
}

function importMemory(fls: EcucModule | undefined): NvmCatalog["memory"] {
	if (!fls) {
		return undefined;
	}
	let baseAddress: number | undefined;
	const sectors: NvmMemorySector[] = [];
	const walk = (container: EcucContainer) => {
		if (container.params.FlsBaseAddress !== undefined) {
			baseAddress = parseNum(container.params.FlsBaseAddress) ?? baseAddress;
		}
		if (container.definition === "FlsSector") {
			sectors.push({
				startAddress: parseNum(container.params.FlsSectorStartaddress) ?? 0,
				sectorSize: parseNum(container.params.FlsSectorSize) ?? 0,
				numberOfSectors: parseNum(container.params.FlsNumberOfSectors) ?? 0,
			});
		}
		container.subContainers.forEach(walk);
	};
	fls.containers.forEach(walk);
	// FlsBaseAddress is often 0 (the real base lives in the sector list); fall
	// back to the lowest sector start address so callers get a usable base.
	if ((baseAddress === undefined || baseAddress === 0) && sectors.length > 0) {
		baseAddress = Math.min(...sectors.map(s => s.startAddress));
	}
	return { baseAddress, sectors };
}

/** Import a Vector/MICROSAR NVM catalog from ECUC ARXML sources. */
export function importNvmCatalog(sources: NvmArxmlSources): NvmCatalog {
	const nvm = parseEcucModule(sources.nvm);
	const fee = sources.fee ? parseEcucModule(sources.fee) : undefined;
	const fls = sources.fls ? parseEcucModule(sources.fls) : undefined;
	const feeIndex = indexFeeBlocks(fee);

	const blocks: NvmCatalogBlock[] = [];
	for (const container of nvm.containers) {
		if (container.definition !== "NvMBlockDescriptor") {
			continue;
		}
		const p = container.params;
		const block: NvmCatalogBlock = {
			name: container.shortName,
			nvmId: parseNum(p.NvMNvramBlockIdentifier),
			payloadLength: parseNum(p.NvMNvBlockLength),
			useCrc: isTrue(p.NvMBlockUseCrc),
			crcWidth: isTrue(p.NvMBlockUseCrc) ? crcWidthOf(p.NvMBlockCrcType) : undefined,
			managementType: p.NvMBlockManagementType
				? p.NvMBlockManagementType.replace(/^NVM_BLOCK_/, "")
				: undefined,
			resistantToChangedSw: isTrue(p.NvMResistantToChangedSw),
			nvBlockNum: parseNum(p.NvMNvBlockNum),
		};

		const feeName = resolveFeeBlockName(container);
		if (feeName) {
			block.feeBlockName = feeName;
			const feeContainer = feeIndex.get(feeName);
			if (feeContainer) {
				const fp = feeContainer.params;
				block.feeBlockNumber = parseNum(fp.FeeBlockNumber);
				block.feeBlockSize = parseNum(fp.FeeBlockSize);
				block.feeDatasets = parseNum(fp.FeeNumberOfDatasets);
				const exponent = parseNum(fp.FeeNumberOfChunkInstances);
				if (exponent !== undefined) {
					block.instanceExponent = exponent;
					block.instances = 2 ** exponent - 1;
				}
			}
		}

		blocks.push(block);
	}

	return {
		blocks,
		virtualPageSize: feeGeneralVirtualPageSize(fee),
		memory: importMemory(fls),
	};
}
