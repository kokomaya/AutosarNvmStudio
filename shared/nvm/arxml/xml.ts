// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A small, dependency-free XML reader sufficient for AUTOSAR ECUC ARXML.
 *
 * ARXML is machine-generated and regular: no mixed content in the values we
 * read, attributes never contain '>'. This parser handles elements,
 * self-closing tags, attributes, text, comments, CDATA, the XML declaration
 * and DOCTYPE, plus the common entities. It intentionally does not aim to be
 * a fully conformant XML processor — that keeps `shared/` free of native/heavy
 * dependencies and usable from both the extension host and the webview.
 */

export interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	/** Concatenated direct text content (entity-decoded). */
	text: string;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeEntities(input: string): string {
	if (!input.includes("&")) {
		return input;
	}
	return input.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			return Number.isNaN(code) ? match : String.fromCodePoint(code);
		}
		return ENTITIES[body] ?? match;
	});
}

function parseTag(raw: string): { tag: string; attrs: Record<string, string> } {
	let end = 0;
	while (end < raw.length && !/\s/.test(raw[end])) {
		end++;
	}
	const tag = raw.slice(0, end);
	const attrs: Record<string, string> = {};
	const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = attrRe.exec(raw.slice(end)))) {
		attrs[m[1]] = decodeEntities(m[2]);
	}
	return { tag, attrs };
}

/** Parse an XML document into a synthetic `#root` node. */
export function parseXml(text: string): XmlNode {
	const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
	const stack: XmlNode[] = [root];
	let i = 0;

	while (i < text.length) {
		if (text[i] !== "<") {
			const next = text.indexOf("<", i);
			const chunk = next === -1 ? text.slice(i) : text.slice(i, next);
			const trimmed = chunk.trim();
			if (trimmed.length > 0) {
				stack[stack.length - 1].text += decodeEntities(trimmed);
			}
			i = next === -1 ? text.length : next;
			continue;
		}

		if (text.startsWith("<!--", i)) {
			const end = text.indexOf("-->", i);
			i = end === -1 ? text.length : end + 3;
			continue;
		}
		if (text.startsWith("<![CDATA[", i)) {
			const end = text.indexOf("]]>", i);
			const content = text.slice(i + 9, end === -1 ? text.length : end);
			stack[stack.length - 1].text += content;
			i = end === -1 ? text.length : end + 3;
			continue;
		}
		if (text.startsWith("<?", i) || text.startsWith("<!", i)) {
			const end = text.indexOf(">", i);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (text[i + 1] === "/") {
			const end = text.indexOf(">", i);
			if (stack.length > 1) {
				stack.pop();
			}
			i = end === -1 ? text.length : end + 1;
			continue;
		}

		const end = text.indexOf(">", i);
		if (end === -1) {
			break;
		}
		let raw = text.slice(i + 1, end);
		let selfClose = false;
		if (raw.endsWith("/")) {
			selfClose = true;
			raw = raw.slice(0, -1);
		}
		const { tag, attrs } = parseTag(raw);
		const node: XmlNode = { tag, attrs, children: [], text: "" };
		stack[stack.length - 1].children.push(node);
		if (!selfClose) {
			stack.push(node);
		}
		i = end + 1;
	}

	return root;
}

/** First direct child element with the given tag. */
export function child(node: XmlNode, tag: string): XmlNode | undefined {
	return node.children.find(c => c.tag === tag);
}

/** All direct child elements with the given tag. */
export function children(node: XmlNode, tag: string): XmlNode[] {
	return node.children.filter(c => c.tag === tag);
}

/** Text of the first direct child with the given tag (or undefined). */
export function childText(node: XmlNode, tag: string): string | undefined {
	return child(node, tag)?.text;
}

/** Depth-first search for all descendants with the given tag. */
export function descendants(node: XmlNode, tag: string): XmlNode[] {
	const out: XmlNode[] = [];
	const walk = (n: XmlNode) => {
		for (const c of n.children) {
			if (c.tag === tag) {
				out.push(c);
			}
			walk(c);
		}
	};
	walk(node);
	return out;
}
