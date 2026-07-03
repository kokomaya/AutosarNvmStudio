// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A generic AUTOSAR ECUC reader built on the lightweight XML parser. It turns
 * an `*_ecuc.arxml` module (NvM, Fee, Fls_30_vMemAccM, ...) into a plain tree
 * of containers with parameters and references, keyed by the last segment of
 * their DEFINITION-REF. This mirrors the walk done by the reference Python
 * script (nvm_lifetime_estimation.py) but is vendor-blind and reusable.
 */

import { child, children, childText, descendants, parseXml, XmlNode } from "./xml";

export interface EcucContainer {
	shortName: string;
	/** Last segment of the container's DEFINITION-REF, e.g. "NvMBlockDescriptor". */
	definition: string;
	/** Full DEFINITION-REF path. */
	definitionRef: string;
	/** Parameter values keyed by the last DEFINITION-REF segment. */
	params: Record<string, string>;
	/** Reference targets keyed by the last DEFINITION-REF segment. */
	references: Record<string, string[]>;
	subContainers: EcucContainer[];
}

export interface EcucModule {
	shortName: string;
	definitionRef: string;
	containers: EcucContainer[];
}

function lastSegment(path: string | undefined): string {
	if (!path) {
		return "";
	}
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function definitionRefOf(node: XmlNode): string {
	return childText(node, "DEFINITION-REF") ?? "";
}

function buildContainer(node: XmlNode): EcucContainer {
	const definitionRef = definitionRefOf(node);
	const container: EcucContainer = {
		shortName: childText(node, "SHORT-NAME") ?? "",
		definition: lastSegment(definitionRef),
		definitionRef,
		params: {},
		references: {},
		subContainers: [],
	};

	const paramHost = child(node, "PARAMETER-VALUES");
	if (paramHost) {
		for (const param of paramHost.children) {
			// ECUC-NUMERICAL-PARAM-VALUE / ECUC-TEXTUAL-PARAM-VALUE
			const key = lastSegment(definitionRefOf(param));
			if (key) {
				container.params[key] = childText(param, "VALUE") ?? "";
			}
		}
	}

	const refHost = child(node, "REFERENCE-VALUES");
	if (refHost) {
		for (const ref of refHost.children) {
			const key = lastSegment(definitionRefOf(ref));
			const value = childText(ref, "VALUE-REF");
			if (key && value !== undefined) {
				(container.references[key] ??= []).push(value);
			}
		}
	}

	const subHost = child(node, "SUB-CONTAINERS");
	if (subHost) {
		for (const sub of children(subHost, "ECUC-CONTAINER-VALUE")) {
			container.subContainers.push(buildContainer(sub));
		}
	}

	return container;
}

/** Parse a single ECUC module from ARXML text. */
export function parseEcucModule(xmlText: string): EcucModule {
	const root = parseXml(xmlText);
	const moduleNode = descendants(root, "ECUC-MODULE-CONFIGURATION-VALUES")[0];
	if (!moduleNode) {
		throw new Error("No ECUC-MODULE-CONFIGURATION-VALUES found in ARXML");
	}
	const containersHost = child(moduleNode, "CONTAINERS");
	const containers = containersHost
		? children(containersHost, "ECUC-CONTAINER-VALUE").map(buildContainer)
		: [];
	return {
		shortName: childText(moduleNode, "SHORT-NAME") ?? "",
		definitionRef: definitionRefOf(moduleNode),
		containers,
	};
}

/** Find the first sub-container (recursively) whose definition matches. */
export function findSubContainer(
	container: EcucContainer,
	definition: string,
): EcucContainer | undefined {
	for (const sub of container.subContainers) {
		if (sub.definition === definition) {
			return sub;
		}
		const nested = findSubContainer(sub, definition);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

export { lastSegment };
