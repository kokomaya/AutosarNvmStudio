// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-side helpers for the user-composable custom-view model. The pure data
 * shapes ({@link NvmCustomView}, {@link BlockSelector}, …) and the resolver live
 * in `shared/nvm/customView.ts` so the webview/panel and unit tests can consume
 * them without a `src/` dependency; this module only adds the id generator and
 * defensive coercion used when persisting/loading.
 *
 * A custom view is a purely declarative recipe (name + block group selectors).
 * The plugin has ZERO knowledge of what a view *means* — names like "Reset"/"DEM"
 * are whatever the user typed — keeping the core vendor-free and use-case-free.
 */

import { BlockSelector, NvmCustomView, NvmCustomViewSet } from "../../../shared/nvm/customView";

export {
	BlockSelector,
	NvmCustomView,
	NvmCustomViewSet,
	ViewScope,
} from "../../../shared/nvm/customView";

export const CUSTOM_VIEW_SET_VERSION = 1;

/** An empty view set. */
export function emptyViewSet(): NvmCustomViewSet {
	return { version: CUSTOM_VIEW_SET_VERSION, views: [] };
}

/** Generate a short unique id (mirrors annotations/model.ts). */
export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize a single possibly-partial parsed object into a valid view. */
function coerceView(value: unknown): NvmCustomView | undefined {
	const v = (value ?? {}) as Partial<NvmCustomView>;
	if (typeof v.id !== "string" || typeof v.name !== "string") {
		return undefined;
	}
	const now = Date.now();
	return {
		id: v.id,
		name: v.name,
		scope: v.scope === "template" ? "template" : "dump",
		groups: Array.isArray(v.groups)
			? v.groups.filter(
					(s): s is BlockSelector =>
						!!s &&
						(s.by === "fingerprint" ||
							s.by === "identity" ||
							s.by === "id" ||
							s.by === "nameGlob") &&
						typeof s.value === "string",
				)
			: [],
		createdAt: typeof v.createdAt === "number" ? v.createdAt : now,
		updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : now,
	};
}

/** Normalize a possibly-partial parsed object into a valid {@link NvmCustomViewSet}. */
export function coerceViewSet(value: unknown): NvmCustomViewSet {
	const v = (value ?? {}) as Partial<NvmCustomViewSet>;
	const views = Array.isArray(v.views)
		? v.views.map(coerceView).filter((x): x is NvmCustomView => x !== undefined)
		: [];
	return { version: CUSTOM_VIEW_SET_VERSION, views };
}
