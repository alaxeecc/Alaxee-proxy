/**
 * Store image generation.
 *
 * The two required images are produced by scripts/store-assets.py from the brand
 * kit rather than being committed, so nothing in the diff shows if a change makes
 * them the wrong size. Partner Center rejects a wrong size at upload time, which is
 * the worst moment to find out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "store-assets.py");
const script = readFileSync(scriptPath, "utf8");

/** Read width and height straight out of a PNG's IHDR chunk. */
function pngSize(file) {
  const buf = readFileSync(file);
  assert.equal(buf.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("the generator targets the exact sizes Partner Center requires", () => {
  // 300x300 is Microsoft's recommendation for the 1:1 logo (minimum 128); the
  // small promotional tile must be exactly 440x280.
  assert.match(script, /LOGO_SIZE\s*=\s*300/);
  assert.match(script, /TILE_SIZE\s*=\s*\(\s*440\s*,\s*280\s*\)/);
});

test("sources come from the brand kit and are never redrawn", () => {
  // The kit is the authority. Any drawing primitive appearing here would mean the
  // artwork was hand-made again, which was explicitly rejected.
  for (const prim of ["ImageDraw", "ellipse(", "polygon(", "arc(", "line("]) {
    assert.ok(!script.includes(prim), `the generator must not draw: found "${prim}"`);
  }
  assert.match(script, /alaxee-kit/);
  assert.match(script, /icon-day-1024\.png/);
});

test("scaling preserves aspect ratio", () => {
  // Squashing the mark to fill a box is the failure mode that is invisible until
  // someone compares it with the toolbar icon.
  assert.match(script, /min\(box\[0\] \/ src\.width, box\[1\] \/ src\.height\)/);
  assert.match(script, /Image\.LANCZOS/);
});

test("generated images match their declared sizes", { skip: !existsSync(path.join(root, "store-assets")) }, () => {
  const logo = path.join(root, "store-assets", "logo-300.png");
  const tile = path.join(root, "store-assets", "tile-440x280.png");
  assert.ok(existsSync(logo), "run: python3 scripts/store-assets.py");
  assert.ok(existsSync(tile), "run: python3 scripts/store-assets.py");
  assert.deepEqual(pngSize(logo), { width: 300, height: 300 });
  assert.deepEqual(pngSize(tile), { width: 440, height: 280 });
});

test("store assets stay out of Git", () => {
  // They are generated, and large. Committing them would put a second copy of the
  // brand artwork in the repository and let it drift from the kit.
  const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^store-assets\/$/m);
});
