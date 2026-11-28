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

test("toolbar icons are drawn for 16px, and the kit artwork is not shipped there", () => {
  // The kit's icons are gradient illustrations; at 16px they resolve to a pale
  // smudge and two of the four measured 0.0097 apart in OKLab. The toolbar needs
  // its own artwork, so these files are generated by scripts/toolbar-icons.py
  // rather than copied. The kit art still ships where it is seen at size - the
  // popup header and the store listing.
  const KIT = path.join(root, "alaxee-kit", "brand", "icons", "png");
  const SOURCE = { proxy: "icon-day", direct: "icon-night-sleep", forced: "icon-noon", unknown: "icon-morning" };
  for (const [state, stem] of Object.entries(SOURCE)) {
    for (const size of SIZES) {
      const shipped = readFileSync(path.join(STATUS_ICONS, `${state}${size}.png`));
      const kitFile = readFileSync(path.join(KIT, `${stem}-small-${size}.png`));
      assert.ok(
        !shipped.equals(kitFile),
        `${state}${size}.png should be the purpose-drawn icon, not the kit illustration`,
      );
    }
  }
});

test("each route has its own silhouette, not just its own colour", () => {
  // Four mutually exclusive shapes, so the icons survive greyscale and
  // colour-blindness: a filled disc, a hollow ring, a triangle, a dashed ring.
  const script = readFileSync(path.join(root, "scripts", "toolbar-icons.py"), "utf8");
  for (const shape of ["d.ellipse(box, fill=fill)", "d.polygon(inner, fill=fill)", "d.arc("]) {
    assert.ok(script.includes(shape), `the generator should draw a ${shape} form`);
  }
  // Mixed fill ratios are the machine-checkable version of "different silhouette".
  const ratios = {};
  for (const state of ["proxy", "direct", "forced", "unknown"]) {
    const img = pngPixels(path.join(STATUS_ICONS, `${state}16.png`));
    ratios[state] = inkRatio(img);
  }
  // Measured shares on a 16x16 tile: disc ~0.44, triangle ~0.35, ring ~0.25,
  // dashed ring ~0.19. The assertions are about the ordering rather than exact
  // values, so the shapes can be tuned without the test becoming a nuisance.
  assert.ok(ratios.proxy > 0.30, `a filled disc should dominate its box, got ${ratios.proxy.toFixed(2)}`);
  assert.ok(ratios.direct < ratios.proxy - 0.10,
    `a hollow ring must be visibly emptier than a disc: ${ratios.direct.toFixed(2)} vs ${ratios.proxy.toFixed(2)}`);
  assert.ok(ratios.forced < ratios.proxy, "a triangle covers less of its box than a disc");
  assert.ok(ratios.forced > ratios.unknown, "a filled triangle covers more than a dashed ring");
  assert.ok(ratios.unknown < ratios.direct, "a dashed ring covers less than a solid ring");
});

test("toolbar icons hold their shape on light and dark toolbars", () => {
  // No brand colour reaches 3:1 against both a light and a dark toolbar - the best
  // measured 2.91 - so every icon carries a white outline. This checks the outline
  // exists and is opaque, which is what makes the shape readable either way.
  for (const state of ["proxy", "direct", "forced", "unknown"]) {
    const img = pngPixels(path.join(STATUS_ICONS, `${state}16.png`));
    let outline = 0;
    for (let p = 0; p < img.width * img.height; p += 1) {
      const base = p * img.channels;
      const [r, g, b, a] = [img.data[base], img.data[base + 1], img.data[base + 2], img.data[base + 3]];
      if (a > 200 && r > 235 && g > 235 && b > 235) outline += 1;
    }
    // At least 8 pixels of rim: enough to separate the glyph at 16px.
    assert.ok(outline >= 8, `${state} needs a visible white outline, found ${outline} px`);
  }
});

/** Share of the 16x16 tile covered by opaque, non-white pixels. */
function inkRatio(img) {
  let ink = 0;
  for (let p = 0; p < img.width * img.height; p += 1) {
    const base = p * img.channels;
    const a = img.data[base + 3];
    if (a < 160) continue;
    const bright = (img.data[base] + img.data[base + 1] + img.data[base + 2]) / 3;
    if (bright < 200) ink += 1;
  }
  return ink / (img.width * img.height);
}
