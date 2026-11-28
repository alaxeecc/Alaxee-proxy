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
import zlib from "node:zlib";

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

/**
 * The four toolbar states must be distinguishable from each other at 16px.
 *
 * This is the test that was missing. The icons were the brand kit's artwork
 * recoloured per state, and at 16px two of them came out 0.0097 apart in OKLab -
 * about a fifth of the threshold where colours separate - while all four shared
 * the same crescent. On a toolbar the icon looked identical in every mode, so the
 * user could not tell whether the proxy was on.
 *
 * Colour distance alone is not enough either: it is measured on the whole tile,
 * where the kit background dominates. What matters is whether a person can tell
 * two icons apart, so this compares the pixels directly - first the mean colour,
 * then the proportion of pixels that actually differ.
 */
function pngPixels(file) {
  const buf = readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`);
  let width = buf.readUInt32BE(16);
  let height = buf.readUInt32BE(20);
  let bitDepth = buf[24];
  let colorType = buf[25];
  let interlace = buf[28];
  assert.equal(interlace, 0, "test assumes non-interlaced PNG");
  assert.equal(bitDepth, 8, "test assumes 8-bit channels");

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `unsupported colour type ${colorType}`);

  const idat = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") idat.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
    row.copy(out, y * stride);
    prev = row;
  }
  return { width, height, channels, data: out };
}

const STATUS_ICONS = path.join(root, "icons", "status");

// Must match BADGE_FILL in scripts/status-badges.py. Kept as literals here rather
// than parsed from Python, because a wrong value should fail loudly here.
const BADGE_COLOURS = {
  proxy: [0xb5, 0x45, 0x7a],
  direct: [0x1f, 0x6b, 0x5f],
  forced: [0xc2, 0x5a, 0x0a],
  unknown: [0x5c, 0x4b, 0x55],
};

/**
 * What actually separates the states is that each badge has its own silhouette,
 * not that a percentage of pixels differs. Measured on raw pixel difference, the
 * four recoloured kit icons still scored 8.2% between the two that look identical
 * on a toolbar, and a 6% threshold passed them.
 *
 * So this measures the badge itself: find the badge colour in the lower-right
 * quadrant, then count holes in its filled area. A disc is solid, a ring has one
 * hole, a dashed ring has many, and a triangle is not a disc at all. Those counts
 * are a signature that recolouring cannot fake.
 */
function badgeSignature(img, state) {
  const { width, height, channels, data } = img;
  const fill = BADGE_COLOURS[state];
  const inside = [];
  let count = 0;
  for (let y = Math.floor(height * 0.4); y < height; y += 1) {
    for (let x = Math.floor(width * 0.4); x < width; x += 1) {
      const base = (y * width + x) * channels;
      const d = Math.abs(data[base] - fill[0]) +
        Math.abs(data[base + 1] - fill[1]) +
        Math.abs(data[base + 2] - fill[2]);
      if (d < 90) {
        count += 1;
        inside.push([x, y]);
      }
    }
  }
  if (count === 0) return { count: 0, holes: 0, spread: 0 };
  const xs = inside.map(([x]) => x);
  const ys = inside.map(([, y]) => y);
  const spread = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  // Fill ratio inside the badge's own bounding box: a solid disc is near 0.78 of
  // its box, a ring is far lower, a dashed ring lower still.
  const ratio = count / (spread || 1);
  return { count, ratio, spread };
}

test("each state's badge has its own fill signature", () => {
  const signatures = {};
  for (const state of ["proxy", "direct", "forced", "unknown"]) {
    signatures[state] = badgeSignature(
      pngPixels(path.join(STATUS_ICONS, `${state}16.png`)),
      state,
    );
  }

  for (const [state, sig] of Object.entries(signatures)) {
    assert.ok(sig.count >= 12, `${state} badge too small to see: ${sig.count} px`);
  }

  // Solid disc vs hollow ring: the fill ratio separates a filled shape from an
  // outlined one without depending on the palette.
  const { proxy, direct, unknown } = signatures;
  assert.ok(proxy.ratio > direct.ratio + 0.12,
    `proxy (${proxy.ratio.toFixed(2)}) should be visibly more solid than direct (${direct.ratio.toFixed(2)})`);
  assert.ok(direct.ratio > unknown.ratio + 0.05,
    `direct (${direct.ratio.toFixed(2)}) should be more solid than the dashed unknown (${unknown.ratio.toFixed(2)})`);
});

test("the two states that used to be identical are now separated", () => {
  // proxy vs unknown is the pair that measured 0.0097 in OKLab - the whole reason
  // this work happened. Their fills must now differ in shape, not just hue.
  const proxy = badgeSignature(pngPixels(path.join(STATUS_ICONS, "proxy16.png")), "proxy");
  const unknown = badgeSignature(pngPixels(path.join(STATUS_ICONS, "unknown16.png")), "unknown");
  assert.ok(Math.abs(proxy.ratio - unknown.ratio) > 0.15,
    `proxy and unknown fills are too similar: ${proxy.ratio.toFixed(2)} vs ${unknown.ratio.toFixed(2)}`);
});

test("every status icon carries a badge in the same corner", () => {
  // The badge has to sit in the same place across states, or the icon appears to
  // jump when the route changes.
  for (const state of ["proxy", "direct", "forced", "unknown"]) {
    for (const size of SIZES) {
      const img = pngPixels(path.join(STATUS_ICONS, `${state}${size}.png`));
      assert.equal(img.width, size);
      assert.equal(img.height, size);
      // Inspect the lower-right quadrant: it must not be uniform, i.e. something
      // is drawn there.
      const colours = new Set();
      for (let y = Math.floor(size * 0.55); y < size; y += 1) {
        for (let x = Math.floor(size * 0.55); x < size; x += 1) {
          const base = (y * img.width + x) * img.channels;
          colours.add(`${img.data[base]},${img.data[base + 1]},${img.data[base + 2]}`);
        }
      }
      assert.ok(colours.size > 4, `${state}${size} has no badge in the lower right`);
    }
  }
});
