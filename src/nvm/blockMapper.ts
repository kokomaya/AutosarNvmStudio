import { BlockDef } from "./arxmlParser";

export interface MappedBlock {
    id: string;
    name?: string;
    offset: number; // byte offset in file
    length: number; // length in bytes
    raw?: any;
}

/**
 * Map BlockDef entries to concrete offsets within a buffer/file.
 *
 * Current implementation only supports BlockDefs that explicitly provide
 * numeric `offset` and `length`. If a block cannot be mapped it is
 * omitted from the result. Later we can add expression resolution and
 * memory-segment lookups.
 */
export function mapBlocksToBuffer(bufferLength: number, blocks: BlockDef[], baseAddress = 0): MappedBlock[] {
    const mapped: MappedBlock[] = [];
    for (const b of blocks) {
        if (b.offset === undefined || b.length === undefined) {
            continue; // can't map without explicit numbers for now
        }
        const start = baseAddress + b.offset;
        const end = start + b.length;
        if (start < 0 || b.length <= 0) continue;
        if (start >= bufferLength) continue;
        const clampedLength = Math.min(b.length, bufferLength - start);
        mapped.push({ id: b.id, name: b.name, offset: start, length: clampedLength, raw: b.raw });
    }
    return mapped;
}

export default { mapBlocksToBuffer };
