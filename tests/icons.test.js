/**
 * Icon integrity.
 *
 * Three of the eight toolbar PNGs shipped in 0.1.3 were corrupt: one had a bad
 * palette CRC and two were truncated mid-file. Nothing checked them, so the only
 * symptom would have been a blank toolbar icon at high DPI - and the 32px proxy
 * icon is exactly what manifest action.default_icon points at.
 *
 * These tests assert that every shipped PNG is structurally valid and that the
 * committed bytes match scripts/render-icons.py, so the artwork has a source of
 * truth rather than only a binary blob.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const STATES = ["proxy", "direct", "forced", "unknown"];
const SIZES = [16, 32];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Walks the chunk table. Returns the chunk names, the declared dimensions, and
 * any structural problem found. A truncated file or a bad chunk type surfaces
 * here rather than as a missing toolbar icon.
 */
function inspectPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { valid: false, reason: "bad signature", chunks: [], width: 0, height: 0 };
  }

  const chunks = [];
  let offset = 8;
  let width = 0;
  let height = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      return { valid: false, reason: `truncated before chunk header at ${offset}`, chunks, width, height };
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return { valid: false, reason: `invalid chunk type at ${offset}: ${JSON.stringify(type)}`, chunks, width, height };
    }
    if (offset + 12 + length > buffer.length) {
      return { valid: false, reason: `truncated ${type} chunk at ${offset}`, chunks, width, height };
    }

    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== declaredCrc) {
      return { valid: false, reason: `${type} chunk CRC mismatch`, chunks, width, height };
    }
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
    }

    chunks.push(type);
    offset += 12 + length;
    if (type === "IEND") {
      return { valid: true, reason: "", chunks, width, height };
    }
  }

  return { valid: false, reason: "no IEND chunk", chunks, width, height };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("every shipped PNG is structurally valid", async () => {
  const files = [];
  for (const icon of Object.values(manifest.icons)) files.push(icon);
  for (const icon of Object.values(manifest.action.default_icon)) files.push(icon);
  for (const state of STATES) {
    for (const size of SIZES) files.push(`icons/status/${state}${size}.png`);
  }

  for (const file of files) {
    const buffer = await readFile(path.join(root, file));
    const result = inspectPng(buffer);
    assert.ok(result.valid, `${file}: ${result.reason}`);
    assert.ok(result.chunks.includes("IDAT"), `${file}: no IDAT chunk`);
  }
});

test("status icons are declared at the size their filename promises", async () => {
  for (const state of STATES) {
    for (const size of SIZES) {
      const file = `icons/status/${state}${size}.png`;
      const result = inspectPng(await readFile(path.join(root, file)));
      assert.equal(result.width, size, `${file}: width`);
      assert.equal(result.height, size, `${file}: height`);
    }
  }
});

test("the manifest toolbar icon pair exists at both densities", async () => {
  // action.default_icon is what the user sees before any state is known, and the
  // 32px entry is what high-DPI displays render. A corrupt file here is invisible
  // on a 1x screen, which is how the 0.1.3 breakage went unnoticed.
  for (const [size, file] of Object.entries(manifest.action.default_icon)) {
    assert.ok(existsSync(path.join(root, file)), `missing toolbar icon for ${size}px: ${file}`);
    const result = inspectPng(await readFile(path.join(root, file)));
    assert.ok(result.valid, `${file}: ${result.reason}`);
    assert.equal(result.width, Number(size));
  }
});

test("the shipped toolbar icons are valid and correctly sized", () => {
  // The icons are the brand kit's own files, copied in rather than generated, so
  // what has to be guarded is not "the generator still agrees" but "the committed
  // bytes are usable". Three of these were once corrupt and nothing noticed.
  const output = execFileSync("python3", [path.join(root, "scripts", "render-icons.py"), "--check"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(output, /toolbar icons present, valid and correctly sized/);
});
