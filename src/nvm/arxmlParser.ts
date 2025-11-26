/**
 * Lightweight ARXML parser for extracting NVM block definitions.
 *
 * This is an intentionally small, fault-tolerant parser used as a
 * starting point for integrating Autosar NVM configurations into the
 * hex editor UI. It tries to use `fast-xml-parser` if present at runtime
 * (loaded dynamically), and otherwise falls back to a conservative
 * regex-based extractor that handles the common motifs used for NVM
 * block declarations in many ARXML files.
 */

import * as fs from "fs/promises";

export interface BlockDef {
    /** Unique identifier for the block (logical name or ID) */
    id: string;
    /** Optional human readable name */
    name?: string;
    /** Optional offset in bytes when provided explicitly */
    offset?: number;
    /** Optional length in bytes when provided explicitly */
    length?: number;
    /** Original raw metadata extracted from ARXML for later use */
    raw?: any;
}

/**
 * Parse ARXML text and return an array of BlockDef objects.
 *
 * The function attempts to use a robust XML -> JS parser if available,
 * but will still return useful results when only a lightweight fallback
 * is available.
 */
export async function parseArxml(text: string): Promise<BlockDef[]> {
    // Try to dynamically load fast-xml-parser if available. This keeps our
    // package.json unchanged while allowing users that have the parser to
    // get a more accurate result.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fxp = require("fast-xml-parser");
        const options = { ignoreAttributes: false, attributeNamePrefix: "@_" };
        const parsed = fxp.parse(text, options);
        return extractBlocksFromParsed(parsed);
    } catch (e) {
        // Fallback: do a conservative regex scan for common NVM block tags.
        return extractBlocksByRegex(text);
    }
}

export async function parseArxmlFile(path: string): Promise<BlockDef[]> {
    const text = await fs.readFile(path, { encoding: "utf8" });
    return parseArxml(text);
}

function extractBlocksFromParsed(parsed: any): BlockDef[] {
    // Autosar ARXML structures vary a lot. This helper tries to walk the
    // object tree and find likely block elements by name.
    const candidates: any[] = [];

    const visit = (node: any) => {
        if (!node || typeof node !== "object") return;
        for (const k of Object.keys(node)) {
            const lower = k.toLowerCase();
            if (lower.includes("nvm") && (lower.includes("block") || lower.includes("blockdescriptor") || lower.includes("blockref"))) {
                const v = node[k];
                if (Array.isArray(v)) candidates.push(...v);
                else candidates.push(v);
            }
            visit(node[k]);
        }
    };

    visit(parsed);

    const blocks: BlockDef[] = [];
    for (const c of candidates) {
        try {
            const id = c["@_ID"] || c["SHORT-NAME"] || c["short-name"] || c["ShortName"] || c["SHORT_NAME"] || c["id"];
            const name = c["LONG-NAME"] || c["long-name"] || c["LongName"] || undefined;
            // attempt to find offset/length in common places
            let offset: number | undefined;
            let length: number | undefined;
            if (c.MemorySegmentRef || c.memorySegmentRef) {
                const seg = c.MemorySegmentRef || c.memorySegmentRef;
                // seg might be a string reference; real mapping may be in other nodes
                // leave as raw for now
            }

            // Some ARXML authors include numeric attributes
            if (c["@_START-OFFSET"]) offset = parseInt(String(c["@_START-OFFSET"]), 10);
            if (c["@_SIZE"]) length = parseInt(String(c["@_SIZE"]), 10);

            blocks.push({ id: String(id ?? ""), name: name ?? undefined, offset, length, raw: c });
        } catch (e) {
            // ignore malformed candidate
        }
    }

    return blocks.filter(b => b.id && b.id.length > 0);
}

function extractBlocksByRegex(text: string): BlockDef[] {
    // Very conservative: find elements with names that include "NVM" and "BLOCK",
    // extract short-name and numeric tags if present.
    const blocks: BlockDef[] = [];
    const elementRe = /<([A-Za-z0-9:-_]+)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = elementRe.exec(text))) {
        const tag = m[1];
        if (!/nvm/i.test(tag) || !/block/i.test(tag)) continue;
        const inner = m[3];
        const idMatch = /<SHORT-NAME>([^<]+)<\/SHORT-NAME>/i.exec(inner) || /<short-name>([^<]+)<\/short-name>/i.exec(inner);
        const id = idMatch ? idMatch[1].trim() : tag;
        const sizeMatch = /<SIZE>(\d+)<\/SIZE>/i.exec(inner) || /<LENGTH>(\d+)<\/LENGTH>/i.exec(inner);
        const startMatch = /<START-OFFSET>(\d+)<\/START-OFFSET>/i.exec(inner) || /<START>(\d+)<\/START>/i.exec(inner);
        const length = sizeMatch ? parseInt(sizeMatch[1], 10) : undefined;
        const offset = startMatch ? parseInt(startMatch[1], 10) : undefined;
        blocks.push({ id, length, offset, raw: inner });
    }

    return blocks;
}

// Export default for easier imports
export default { parseArxml, parseArxmlFile };
