const fs = require('fs');
const path = require('path');

function extractBlocksByRegex(text) {
  const blocks = [];
  const elementRe = /<([A-Za-z0-9:-_]+)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
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

(async function main() {
  try {
    const arxmlPath = path.join(__dirname, '..', 'test', 'fixtures', 'sample.arxml');
    const binPath = path.join(__dirname, '..', 'test', 'fixtures', 'sample.bin');
    const arxml = await fs.promises.readFile(arxmlPath, 'utf8');
    const blocks = extractBlocksByRegex(arxml);
    const stats = await fs.promises.stat(binPath);
    const size = stats.size;
    const mapped = [];
    for (const b of blocks) {
      if (typeof b.offset === 'number' && typeof b.length === 'number') {
        const start = b.offset;
        if (start < 0 || b.length <= 0) continue;
        if (start >= size) continue;
        const clampedLength = Math.min(b.length, size - start);
        mapped.push({ id: b.id, name: b.name, offset: start, length: clampedLength });
      }
    }
    console.log('Parsed blocks from ARXML:', blocks);
    console.log('File size:', size);
    console.log('Mapped blocks:', mapped);
  } catch (e) {
    console.error('Error during verification:', e);
    process.exit(1);
  }
})();
