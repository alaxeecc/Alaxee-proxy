/**
 * Reads the character coverage of a WOFF2 file with no dependencies.
 *
 * Why this exists
 * ---------------
 * tests/brand.test.js has to know which characters the shipped CJK subset actually
 * contains. The Python script that builds the subset can answer that, but only when
 * fontTools happens to be installed - it is a build-time tool, not an npm
 * dependency. Relying on it meant the coverage test silently skipped in a plain
 * checkout, which is exactly the situation it was written to protect against.
 *
 * A WOFF2 file is a header, a table directory, and one compressed stream holding
 * every table. Node ships brotli, so the cmap can be read directly:
 *   1. parse the 48-byte header for the table count and total compressed length
 *   2. walk the directory for the cmap entry's offset, length and transform flags
 *   3. brotli-decompress the stream and slice out cmap
 *   4. parse the cmap subtables (format 4 and 12 cover everything here)
 *
 * Only what is needed is implemented. This is not a font library: it never looks at
 * outlines, metrics or layout, and it does not reconstruct the font for rendering.
 */
import { brotliDecompressSync } from "node:zlib";

/** WOFF2 known table tags, indexed by the 6-bit tag field in the directory. */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm",
  "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern",
  "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC",
  "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty",
  "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill"
];

/** Reads a variable-length UIntBase128 as WOFF2 defines it. */
function readBase128(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buffer[offset + i];
    if (byte === undefined) throw new Error("truncated UIntBase128");
    // Leading zeros are illegal; rejecting them keeps a corrupt file from parsing
    // into a plausible but wrong offset.
    if (i === 0 && byte === 0x80) throw new Error("UIntBase128 has a leading zero");
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  throw new Error("UIntBase128 is longer than five bytes");
}

function readDirectory(buffer) {
  if (buffer.readUInt32BE(0) !== 0x774f4632) throw new Error("not a WOFF2 file");
  const numTables = buffer.readUInt16BE(12);
  const totalCompressedSize = buffer.readUInt32BE(20);

  let offset = 48;
  let tableOffset = 0;
  const tables = [];

  for (let index = 0; index < numTables; index += 1) {
    const flags = buffer[offset];
    offset += 1;
    const tagIndex = flags & 0x3f;
    let tag;
    if (tagIndex === 0x3f) {
      tag = buffer.toString("latin1", offset, offset + 4);
      offset += 4;
    } else {
      tag = KNOWN_TAGS[tagIndex];
    }

    const transformVersion = (flags >> 6) & 0x03;
    const originalLength = readBase128(buffer, offset);
    offset = originalLength.next;

    // transformLength is present if and only if the table was actually transformed.
    // glyf and loca are transformed by version 0; version 3 is the null transform.
    // Every other table has no transform, so it carries a single length - reading a
    // second one there desynchronises the whole directory, which is how a plausible
    // but wrong parse produced gibberish tags and a failed brotli decode.
    const isTransformed = (tag === "glyf" || tag === "loca") && transformVersion === 0;
    let length = originalLength.value;
    if (isTransformed) {
      const transformed = readBase128(buffer, offset);
      offset = transformed.next;
      length = transformed.value;
    }

    tables.push({ tag, offset: tableOffset, length });
    tableOffset += length;
  }

  return { tables, dataStart: offset, totalCompressedSize };
}

/** Parses a format 4 subtable and adds its code points to the set. */
function readFormat4(view, start, covered) {
  const segCount = view.getUint16(start + 6) / 2;
  const endCodes = start + 14;
  const startCodes = endCodes + segCount * 2 + 2; // +2 skips reservedPad
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;

  for (let segment = 0; segment < segCount; segment += 1) {
    const end = view.getUint16(endCodes + segment * 2);
    const begin = view.getUint16(startCodes + segment * 2);
    if (begin === 0xffff) continue; // the terminating segment maps nothing
    // Only the presence of a mapping matters here, not which glyph it reaches, so
    // the idDelta/idRangeOffset arithmetic is skipped - a code point in a segment
    // with a non-zero range offset always maps to something.
    for (let code = begin; code <= end; code += 1) covered.add(code);
  }
}

/** Parses a format 12 subtable (full Unicode) and adds its code points. */
function readFormat12(view, start, covered) {
  const groups = view.getUint32(start + 12);
  for (let group = 0; group < groups; group += 1) {
    const base = start + 16 + group * 12;
    const first = view.getUint32(base);
    const last = view.getUint32(base + 4);
    for (let code = first; code <= last; code += 1) covered.add(code);
  }
}

/** Parses the cmap table and returns the set of covered code points. */
function parseCmap(bytes) {
  // Node buffers are not guaranteed to be byte-aligned offsets into a larger
  // allocation, so a plain copy keeps DataView offsets honest.
  const buffer = Buffer.from(bytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const numTables = view.getUint16(2);
  const covered = new Set();

  for (let index = 0; index < numTables; index += 1) {
    const record = 4 + index * 8;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const subtableOffset = view.getUint32(record + 4);
    // 3/1 and 3/10 are Windows BMP and full Unicode; 0/* is Unicode. Macintosh
    // (1/*) subtables are a legacy copy and would only duplicate coverage.
    const isUnicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!isUnicode) continue;

    const format = view.getUint16(subtableOffset);
    if (format === 4) readFormat4(view, subtableOffset, covered);
    else if (format === 12) readFormat12(view, subtableOffset, covered);
  }

  return covered;
}

/**
 * Returns the set of Unicode code points a WOFF2 file maps.
 * @param {Buffer} buffer
 * @returns {Set<number>}
 */
export function woff2CodePoints(buffer) {
  const { tables, dataStart, totalCompressedSize } = readDirectory(buffer);
  const stream = buffer.subarray(dataStart, dataStart + totalCompressedSize);
  const decompressed = brotliDecompressSync(stream);

  const cmap = tables.find((table) => table.tag === "cmap");
  if (!cmap) throw new Error("font has no cmap table");
  return parseCmap(decompressed.subarray(cmap.offset, cmap.offset + cmap.length));
}
