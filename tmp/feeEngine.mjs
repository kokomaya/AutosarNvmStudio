// engines/vector-fee-v3/src/feeLcfg.ts
function parseFeeLcfg(source) {
  const blocks = [];
  const start = source.indexOf("Fee_BlockConfig_at");
  if (start < 0) {
    return blocks;
  }
  const braceStart = source.indexOf("{", start);
  if (braceStart < 0) {
    return blocks;
  }
  const region = source.slice(braceStart);
  const parts = region.split(/\/\*\s*Block:\s*/);
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const nameMatch = /^([^\s*]+)/.exec(seg);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1];
    const bodyEnd = seg.indexOf("}");
    const body = bodyEnd >= 0 ? seg.slice(0, bodyEnd) : seg;
    const numbers = Array.from(body.matchAll(/(\d+)\s*u\b/gi)).map((m) => Number(m[1]));
    const bools = Array.from(body.matchAll(/\b(TRUE|FALSE)\b/gi)).map((m) => m[1].toUpperCase() === "TRUE");
    if (numbers.length < 4) {
      continue;
    }
    blocks.push({
      blkIdx: numbers[0],
      payloadLength: numbers[1],
      numberOfDatasets: numbers[2],
      instanceExponent: numbers[3],
      baseIndex: numbers.length > 4 ? numbers[4] : 0,
      immediateData: bools[0] ?? false,
      criticalData: bools[1] ?? false,
      lookUpTableBlock: bools[2] ?? false,
      name
    });
  }
  return blocks;
}
function feeLcfgByTag(blocks) {
  const map = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    map.set(b.blkIdx, b);
  }
  return map;
}

// engines/vector-fee-v3/src/vectorFeeV3.ts
var EMPTY32 = 4294967295;
var MARKER = 10;
var CHUNK_TRAILER = [10, 0, 12, 0, 10, 0, 4, 0];
function readU16LE(buf, i) {
  return buf[i] | buf[i + 1] << 8;
}
function readU32LE(buf, i) {
  return (buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24) >>> 0;
}
function matchesTrailer(bytes, i) {
  if (i + CHUNK_TRAILER.length > bytes.length) {
    return false;
  }
  for (let k = 0; k < CHUNK_TRAILER.length; k++) {
    if (bytes[i + k] !== CHUNK_TRAILER[k]) {
      return false;
    }
  }
  return true;
}
function parseVectorFeeV3(image, opts = {}) {
  const al = opts.alignment ?? 8;
  const nrs = opts.numberOfSectors ?? 2;
  const ssz = opts.sectorSize ?? 196608;
  const { baseAddress, bytes } = image.toFlat(255);
  let chipBase = baseAddress;
  outer: for (let b = 0; b < nrs; b++) {
    const rel = b === 0 ? 0 : b * ssz;
    const ltSize = (bytes[rel + 1] << 4 | bytes[rel + 2]) & 65535;
    if (bytes[rel] === 255 || ltSize === 0) {
      continue;
    }
    const ltStart = rel + al;
    for (let i = 0; i < ltSize; i++) {
      const tgt = readU32LE(bytes, ltStart + i * al);
      if (tgt !== EMPTY32) {
        chipBase = (tgt & 4278190080) >>> 0 | baseAddress & 16777215;
        break outer;
      }
    }
  }
  const toFlat = (chipAddr) => chipAddr - chipBase | 0;
  const sections = [];
  const allChunks = [];
  const knownTags = /* @__PURE__ */ new Set();
  const linkedHeaders = /* @__PURE__ */ new Set();
  const activeSectors = [];
  for (let b = 0; b < nrs; b++) {
    const rel = b === 0 ? 0 : b * ssz;
    if (rel + 3 > bytes.length) {
      continue;
    }
    const id = bytes[rel];
    const ltSize = (bytes[rel + 1] << 4 | bytes[rel + 2]) & 65535;
    if (id === 255 || ltSize === 0 || ltSize > 4096) {
      continue;
    }
    activeSectors.push(b);
    const ltStart = rel + al;
    const chunks = [];
    let usedSlots = 0;
    for (let slot = 0; slot < ltSize; slot++) {
      const entry = ltStart + slot * al;
      if (entry + 6 > bytes.length) {
        break;
      }
      const linkTarget = readU32LE(bytes, entry);
      if (linkTarget === EMPTY32) {
        continue;
      }
      const pldSz = readU16LE(bytes, entry + 4);
      usedSlots++;
      const chunk = decodeChunk(bytes, toFlat, linkTarget, pldSz, al, baseAddress, b, slot, false);
      if (chunk) {
        chunks.push(chunk);
        allChunks.push(chunk);
        knownTags.add(chunk.tag);
        linkedHeaders.add(chunk.headerAddress - baseAddress);
      }
    }
    sections.push({
      bank: b,
      id,
      ltSize,
      linkTableAddress: baseAddress + ltStart,
      usedSlots,
      chunks
    });
  }
  if (opts.includeStaleChunks !== false) {
    for (const b of activeSectors) {
      const rel = b === 0 ? 0 : b * ssz;
      const secEnd = Math.min(rel + ssz, bytes.length);
      const stale = scanStaleChunks(
        bytes,
        toFlat,
        knownTags,
        linkedHeaders,
        al,
        baseAddress,
        b,
        rel,
        secEnd,
        ssz
      );
      const section = sections.find((s) => s.bank === b);
      for (const chunk of stale) {
        allChunks.push(chunk);
        section?.chunks.push(chunk);
      }
    }
  }
  return { baseAddress, alignment: al, chipBase, sections, chunks: allChunks };
}
function scanStaleChunks(bytes, toFlat, knownTags, linkedHeaders, al, baseAddress, bank, regionStart, regionEnd, sectorSize) {
  const out = [];
  for (let h = regionStart; h + 16 < regionEnd; h += al) {
    if (linkedHeaders.has(h)) {
      continue;
    }
    const tag = readU16LE(bytes, h);
    if (tag === 65535 || !knownTags.has(tag)) {
      continue;
    }
    const pldSz = readU16LE(bytes, h + 4);
    if (pldSz === 0 || pldSz === 65535 || pldSz > sectorSize) {
      continue;
    }
    let idx = h + 8;
    const rst = idx % al;
    idx += al - rst;
    if (bytes[idx] !== MARKER && !isInval(bytes, idx)) {
      continue;
    }
    const payloadStart = idx + 1;
    const trailerStart = payloadStart + pldSz;
    if (!matchesTrailer(bytes, trailerStart)) {
      continue;
    }
    const chunk = parseChunkAt(bytes, toFlat, h, pldSz, al, baseAddress, bank, -1, true);
    if (chunk) {
      out.push(chunk);
      linkedHeaders.add(h);
    }
  }
  return out;
}
function decodeChunk(bytes, toFlat, linkTarget, pldSz, al, baseAddress, bank, slot, stale) {
  let la = toFlat(linkTarget);
  if (la < al || la >= bytes.length) {
    return void 0;
  }
  la -= al;
  if (bytes[la] !== MARKER) {
    return void 0;
  }
  la -= pldSz + 1;
  if (la < 0 || bytes[la] !== MARKER) {
    return void 0;
  }
  la -= al;
  la -= al === 8 ? 8 : 0;
  if (la < 0) {
    return void 0;
  }
  return parseChunkAt(bytes, toFlat, la, pldSz, al, baseAddress, bank, slot, stale);
}
function parseChunkAt(bytes, toFlat, h, pldSz, al, baseAddress, bank, slot, stale) {
  let idx = h;
  const tag = readU16LE(bytes, idx);
  if (tag === 65535) {
    return void 0;
  }
  const datasetIndex = bytes[idx + 2];
  const mgmtType = bytes[idx + 3];
  idx += 2;
  idx += 2;
  const headerSize = readU16LE(bytes, idx);
  if (headerSize === 65535) {
    return void 0;
  }
  idx += 4;
  const rst = idx % al;
  idx += al - rst;
  if (bytes[idx] !== MARKER && !isInval(bytes, idx)) {
    return void 0;
  }
  idx += 1;
  const payloadStart = idx;
  const size = pldSz;
  const end = Math.min(payloadStart + size, bytes.length);
  const data = bytes.subarray(payloadStart, end);
  const tailOffset = payloadStart + size + CHUNK_TRAILER.length;
  let nextLinkTargetOffset;
  if (tailOffset + 4 <= bytes.length) {
    const raw = readU32LE(bytes, tailOffset);
    if (raw !== EMPTY32) {
      const off = toFlat(raw);
      if (off >= 0 && off < bytes.length) {
        nextLinkTargetOffset = off;
      }
    }
  }
  return {
    tag,
    slotIndex: slot,
    bank,
    datasetIndex,
    mgmtType,
    headerAddress: baseAddress + h,
    payloadAddress: baseAddress + payloadStart,
    linkTargetAddress: baseAddress + tailOffset,
    size,
    data,
    consistent: tag === slot,
    nextLinkTargetOffset,
    stale
  };
}
function isInval(bytes, i) {
  return bytes[i] === 5 && bytes[i + 1] === 5 && bytes[i + 2] === 5 && bytes[i + 3] === 5;
}

// engines/vector-fee-v3/src/feeV3Blocks.ts
var CHUNK_HEADER_SIZE = 8;
var SECTOR_SEQ_STRIDE = 1e6;
function mgmtLabel(mgmtType) {
  switch (mgmtType) {
    case 1:
      return "NATIVE";
    case 16:
      return "DATASET";
    default:
      return `0x${mgmtType.toString(16).toUpperCase().padStart(2, "0")}`;
  }
}
function hex(value, pad = 2) {
  return `0x${value.toString(16).toUpperCase().padStart(pad, "0")}`;
}
var DEFAULT_FEE_V3_STRUCTURE = {
  sectorHeader: [
    { name: "Counter / id", kind: "counter", offset: 0, length: 1 },
    { name: "ltSize", kind: "ltSize", offset: 1, length: 2 },
    { name: "Header status / complement", kind: "status", offset: 3, length: 5 }
  ],
  slot: [
    { name: "linkTarget", kind: "linkTarget", offset: 0, length: 4, link: { encoding: "u32le" } },
    { name: "payloadSize", kind: "payloadSize", offset: 4, length: 2 },
    { name: "pad", kind: "pad", offset: 6, length: 2 }
  ],
  slotEmpty: [{ name: "unused slot", kind: "linkEmpty", offset: 0, length: 8 }],
  chunkHeader: [
    { name: "block tag", kind: "tag", offset: 0, length: 2 },
    { name: "dataset idx", kind: "datasetIdx", offset: 2, length: 1 },
    { name: "mgmt type", kind: "mgmtType", offset: 3, length: 1 },
    { name: "payload length", kind: "payloadLen", offset: 4, length: 2 },
    { name: "align", kind: "align", offset: 6, length: 2 }
  ],
  marker: { name: "Padding / start marker", kind: "marker" },
  payload: { name: "Payload", kind: "payload" },
  payloadExtra: { name: "MAC / CRC / padding", kind: "mac" },
  chunkTrailer: { name: "chunk trailer", kind: "chunkTrailer" },
  nextLink: { name: "next chunk link", kind: "nextLink" }
};
function applyTemplate(template, regionOffset, unit, prefix = "", link) {
  return template.map((t) => ({
    name: prefix + t.name,
    kind: t.kind,
    offset: regionOffset + t.offset,
    length: t.length,
    color: t.color,
    unit,
    link: t.link && link ? { targetOffset: link.targetOffset, label: t.link.label ?? link.label } : void 0
  }));
}
function regionField(region, offset, length, unit) {
  return { name: region.name, kind: region.kind, offset, length, color: region.color, unit };
}
function buildFeeV3Blocks(sdk, imageText, feeLcfgSource, options = {}) {
  let image;
  try {
    image = sdk.loadHexImage(imageText);
  } catch {
    return [];
  }
  if (image.span === 0) {
    return [];
  }
  let result;
  try {
    result = parseVectorFeeV3(image, {
      alignment: options.alignment,
      numberOfSectors: options.numberOfSectors,
      sectorSize: options.sectorSize,
      includeStaleChunks: options.includeStaleChunks
    });
  } catch {
    return [];
  }
  if (result.chunks.length === 0) {
    return [];
  }
  const struct = {
    ...DEFAULT_FEE_V3_STRUCTURE,
    ...options.structure ?? {}
  };
  const byTag = feeLcfgSource ? feeLcfgByTag(parseFeeLcfg(feeLcfgSource)) : void 0;
  const base = result.baseAddress;
  const blocks = [];
  const alignment = result.alignment;
  for (const section of result.sections) {
    const sectionOffset = section.linkTableAddress - alignment - base;
    const linkTableOffset = section.linkTableAddress - base;
    if (sectionOffset < 0) {
      continue;
    }
    const bySlot = /* @__PURE__ */ new Map();
    for (const c of section.chunks) {
      bySlot.set(c.slotIndex, c);
    }
    const headerUnit = `sector${section.bank}:header`;
    const fields = applyTemplate(struct.sectorHeader, sectionOffset, headerUnit);
    for (let slot = 0; slot < section.ltSize; slot++) {
      const slotOffset = linkTableOffset + slot * alignment;
      const slotUnit = `sector${section.bank}:slot${slot}`;
      const c = bySlot.get(slot);
      if (c) {
        const def = byTag?.get(c.tag);
        const label = def?.name ?? `tag ${c.tag}`;
        const chunkHeaderOffset = c.headerAddress - base;
        const link = chunkHeaderOffset >= 0 ? { targetOffset: chunkHeaderOffset, label } : void 0;
        fields.push(
          ...applyTemplate(struct.slot, slotOffset, slotUnit, `Slot ${slot} \u2192 ${label}: `, link)
        );
      } else {
        fields.push(...applyTemplate(struct.slotEmpty, slotOffset, slotUnit, `Slot ${slot}: `));
      }
    }
    blocks.push({
      id: `sector${section.bank}`,
      name: `Sector ${section.bank} table (id=0x${section.id.toString(16)}, ${section.usedSlots} used)`,
      offset: sectionOffset,
      length: alignment + section.ltSize * alignment,
      raw: {
        bank: section.bank,
        id: section.id,
        ltSize: section.ltSize,
        usedSlots: section.usedSlots,
        chunks: section.chunks.length
      },
      group: { key: `sector${section.bank}`, label: `Sector ${section.bank}`, order: section.bank },
      attributes: [
        { key: "kind", label: "Kind", value: "sector table", kind: "kind" },
        { key: "sector", label: "Sector", value: section.bank, kind: "sector" },
        { key: "usedSlots", label: "Used slots", value: section.usedSlots },
        { key: "ltSize", label: "Slots", value: section.ltSize },
        { key: "chunks", label: "Chunks", value: section.chunks.length }
      ],
      fields
    });
  }
  for (const c of result.chunks) {
    const def = byTag?.get(c.tag);
    const rawSize = c.size;
    const netLength = Math.min(def?.payloadLength ?? rawSize, rawSize);
    const headerOffset = c.headerAddress - base;
    const payloadOffset = c.payloadAddress - base;
    if (headerOffset < 0 || payloadOffset < headerOffset) {
      continue;
    }
    const markerOffset = headerOffset + CHUNK_HEADER_SIZE;
    const markerLength = payloadOffset - markerOffset;
    const extraLength = Math.max(0, rawSize - netLength);
    const trailerStart = payloadOffset + rawSize;
    const nextLinkOffset = c.linkTargetAddress - base;
    const nextLinkLength = 8;
    const hasTail = nextLinkOffset >= trailerStart;
    const trailerLength = hasTail ? nextLinkOffset - trailerStart : 0;
    const blockEnd = hasTail ? nextLinkOffset + nextLinkLength : payloadOffset + netLength;
    const blockLength = blockEnd - headerOffset;
    const blockUnit = `tag${c.tag}.s${c.bank}.@${headerOffset.toString(16)}`;
    const fields = applyTemplate(struct.chunkHeader, headerOffset, blockUnit);
    if (markerLength > 0) {
      fields.push(regionField(struct.marker, markerOffset, markerLength, blockUnit));
    }
    if (netLength > 0) {
      fields.push(regionField(struct.payload, payloadOffset, netLength, blockUnit));
    }
    if (extraLength > 0) {
      fields.push(regionField(struct.payloadExtra, payloadOffset + netLength, extraLength, blockUnit));
    }
    if (trailerLength > 0) {
      fields.push(regionField(struct.chunkTrailer, trailerStart, trailerLength, blockUnit));
    }
    if (hasTail) {
      const nextLinkField = regionField(struct.nextLink, nextLinkOffset, nextLinkLength, blockUnit);
      if (c.nextLinkTargetOffset !== void 0) {
        nextLinkField.link = {
          targetOffset: c.nextLinkTargetOffset,
          label: `${def?.name ?? `Tag ${c.tag}`} (previous version)`
        };
      }
      fields.push(nextLinkField);
    }
    blocks.push({
      id: blockUnit,
      name: def?.name ?? `Tag ${c.tag}`,
      offset: headerOffset,
      length: blockLength,
      raw: {
        tag: c.tag,
        bank: c.bank,
        slotIndex: c.slotIndex,
        consistent: c.consistent,
        datasetIndex: c.datasetIndex,
        mgmtType: c.mgmtType,
        netLength,
        rawSize,
        stale: c.stale
      },
      // Vendor-neutral projection for the editor's Blocks views. `sequence`
      // is BEST-EFFORT: FEE stores no monotonic write counter, so we order by
      // sector then physical header offset — Vector writes a sector top-down,
      // so the highest-offset chunk in a sector is the most recently written.
      group: { key: `sector${c.bank}`, label: `Sector ${c.bank}`, order: c.bank },
      sequence: c.bank * SECTOR_SEQ_STRIDE + headerOffset,
      identity: { key: `tag:0x${c.tag.toString(16)}`, label: def?.name ?? `Tag ${c.tag}` },
      attributes: [
        { key: "id", label: "ID", value: hex(c.tag, 4), kind: "id" },
        { key: "state", label: "State", value: c.stale ? "stale" : "latest", kind: "state" },
        { key: "sector", label: "Sector", value: c.bank, kind: "sector" },
        { key: "slot", label: "Slot", value: c.slotIndex < 0 ? "-" : c.slotIndex },
        { key: "mgmt", label: "Mgmt", value: mgmtLabel(c.mgmtType), kind: "mgmt" },
        { key: "dataset", label: "Dataset", value: c.datasetIndex },
        { key: "size", label: "Size", value: rawSize },
        { key: "payload", label: "Payload", value: netLength }
      ],
      fields
    });
  }
  const latestByIdentity = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    if (!b.identity || typeof b.sequence !== "number") {
      continue;
    }
    if (b.raw?.stale) {
      continue;
    }
    const best = latestByIdentity.get(b.identity.key);
    if (!best || (best.sequence ?? -Infinity) < b.sequence) {
      latestByIdentity.set(b.identity.key, b);
    }
  }
  for (const b of latestByIdentity.values()) {
    b.isLatest = true;
  }
  blocks.sort((a, b) => a.offset - b.offset);
  return blocks;
}

// engines/vector-fee-v3/src/index.ts
function createEngine(sdk) {
  return {
    id: "vector-fee-v3",
    parse(input, options) {
      const feeLcfg = input.sources.feeLcfg || input.sources["fee_lcfg.c"];
      return buildFeeV3Blocks(sdk, input.text, feeLcfg, options || {});
    }
  };
}
export {
  createEngine
};
