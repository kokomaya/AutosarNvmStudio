// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Structured (T1) layout provider. Bridges the vendor-neutral, declarative
 * {@link NvmProfile} parser (shared/nvm) into the layout provider framework so
 * a `*.nvmlayout.json` can describe header + payload-length + CRC + iteration
 * formats **without any code** and without a static `blocks` table.
 *
 * This is the middle tier between T0 (static `blocks`, see `configLayout.ts`)
 * and T2 (a full external engine, see `externalEngine.ts`). It carries ZERO
 * vendor knowledge: everything comes from the descriptor's `profile`.
 */

import { NvmModel, NvmProfile, parseNvm, validateProfile } from "../../../shared/nvm";
import { NvmBlockInfo, NvmFieldInfo } from "../../../shared/protocol";
import { ResolveContext } from "./context";
import {
    applyPalette,
    effectiveStrategy,
    LayoutConfig,
    matchesConfig,
    NvmLayoutProvider,
} from "./provider";

/** True when this descriptor opts into the structured (profile-driven) tier. */
function isStructuredConfig(config: LayoutConfig, ctx: ResolveContext): boolean {
	return (
		!config.provider &&
		!!config.profile &&
		effectiveStrategy(config) === "structured" &&
		matchesConfig(config, ctx)
	);
}

/**
 * Turn one parsed {@link NvmModel} into colored {@link NvmBlockInfo} units. Each
 * block instance becomes a clickable unit; header fields, the payload span and
 * an optional trailer CRC become colored sub-ranges (offsets in editor byte
 * space).
 */
function blocksFromModel(config: LayoutConfig, profile: NvmProfile, model: NvmModel): NvmBlockInfo[] {
	const out: NvmBlockInfo[] = [];
	const trailer =
		profile.integrity?.crc?.stored.source === "trailer"
			? profile.integrity.crc.stored.size
			: 0;

	model.allInstances.forEach((instance, index) => {
		const start = instance.fileRange.start;
		const length = instance.fileRange.end - start;
		const unit = `${config.vendor}:${instance.logicalId}#${index}`;
		const fields: NvmFieldInfo[] = [];

		// Header fields, positioned relative to the block start.
		for (const field of profile.block.header) {
			fields.push({
				name: field.name,
				kind: field.role ?? "header",
				offset: start + field.offset,
				length: field.size,
				unit,
			});
		}

		// Payload span (may be empty for header-only blocks).
		const payloadLength = instance.payloadRange.end - instance.payloadRange.start;
		if (payloadLength > 0) {
			fields.push({
				name: "payload",
				kind: "payload",
				offset: instance.payloadRange.start,
				length: payloadLength,
				unit,
			});
		}

		// Trailer CRC, when the profile stores it after the payload.
		if (trailer > 0 && instance.payloadRange.end + trailer <= instance.fileRange.end) {
			fields.push({
				name: "crc",
				kind: "crc",
				offset: instance.payloadRange.end,
				length: trailer,
				unit,
			});
		}

		out.push({
			id: unit,
			name: `${config.vendor} block ${instance.logicalId}`,
			offset: start,
			length,
			raw: {
				vendor: config.vendor,
				logicalId: instance.logicalId,
				status: instance.status,
				crc: instance.crc,
				index,
			},
			fields,
		});
	});

	return out;
}

export const structuredLayoutProvider: NvmLayoutProvider = {
	id: "structured-layout",
	label: "Structured layout (declarative profile)",
	detect(ctx: ResolveContext): boolean {
		return ctx.configs.some(c => isStructuredConfig(c, ctx));
	},
	parse(ctx: ResolveContext): NvmBlockInfo[] {
		const { bytes } = ctx.image;
		const out: NvmBlockInfo[] = [];
		for (const config of ctx.configs) {
			if (!isStructuredConfig(config, ctx)) {
				continue;
			}
			// Validate defensively: a malformed profile is skipped, not fatal.
			let profile: NvmProfile;
			try {
				profile = validateProfile(config.profile);
			} catch (err) {
				console.warn(`NVM structured profile "${config.vendor}" is invalid:`, err);
				continue;
			}
			const model = parseNvm(bytes, profile);
			const blocks = blocksFromModel(config, profile, model);
			applyPalette(blocks, config.palette);
			out.push(...blocks);
		}
		out.sort((a, b) => a.offset - b.offset);
		return out;
	},
};
