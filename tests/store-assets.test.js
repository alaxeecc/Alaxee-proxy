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
import { readFileSync, readdirSync } from "node:fs";
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

test("the committed logo and tile are the declared sizes", () => {
  // These live in store-uploads/, which is committed, so this runs everywhere -
  // unlike store-assets/, which is the gitignored working directory and does not
  // exist in CI. Checking the committed copies means the assertion actually
  // guards the files someone downloads.
  const dir = path.join(root, "store-uploads");
  assert.deepEqual(pngSize(path.join(dir, "logo-300.png")), { width: 300, height: 300 });
  assert.deepEqual(pngSize(path.join(dir, "tile-440x280.png")), { width: 440, height: 280 });
});

test("every committed screenshot is exactly 1280x800", () => {
  // Microsoft accepts two sizes and nothing else, so a capture that landed at
  // 1200x750 would sit in the repository looking finished and be rejected at
  // upload. Checking the committed directory covers both CI and a fresh clone.
  const dir = path.join(root, "store-uploads");
  const shots = readdirSync(dir).filter((f) => /^\d\d-.*\.png$/.test(f));
  assert.ok(shots.length >= 1, "at least one screenshot should be committed");
  for (const name of shots) {
    assert.deepEqual(pngSize(path.join(dir, name)), { width: 1280, height: 800 },
      `${name} must be 1280x800`);
  }
});

test("store assets stay out of Git", () => {
  // They are generated, and large. Committing them would put a second copy of the
  // brand artwork in the repository and let it drift from the kit.
  const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^store-assets\/$/m);
});

test("the screenshot fitter only offers the two sizes Microsoft accepts", () => {
  // Offering a free-form size would let a 1200x900 capture through, and Partner
  // Center rejects that at upload with no useful error.
  const shot = readFileSync(path.join(root, "scripts", "store-shot.py"), "utf8");
  assert.match(shot, /"1280x800"\s*:\s*\(\s*1280\s*,\s*800\s*\)/);
  assert.match(shot, /"640x480"\s*:\s*\(\s*640\s*,\s*480\s*\)/);
  // The CLI must not accept a size outside that dict.
  assert.match(shot, /choices=sorted\(ACCEPTED\)/);
  // Same rule as the logo: scale the capture, never draw over it or stretch it.
  assert.match(shot, /min\(box\[0\] \/ src\.width, box\[1\] \/ src\.height\)/);
  // No drawing. Cropping is permitted but only in cover mode, where it is the
  // whole point; contain must never crop, or it would silently drop interface.
  for (const prim of ["ImageDraw", "transpose(", "rotate("]) {
    assert.ok(!shot.includes(prim), `the fitter must not draw or rotate: found "${prim}"`);
  }
  // The padding path must never crop. Splitting the function at the cover branch
  // lets the two halves be checked separately rather than by eyeballing.
  const body = shot.slice(shot.indexOf("def fit"), shot.indexOf("def main"));
  const containPath = body.slice(body.indexOf('if mode == "cover"') + body.slice(body.indexOf('if mode == "cover"')).indexOf("box ="));
  assert.ok(!containPath.includes("crop("), "contain mode must not crop the capture");
});

test("store images are never packaged into the extension", () => {
  // store-uploads/ exists so the finished images are downloadable from GitHub.
  // It sits in the repository root next to files that ARE packaged, so a change to
  // the runtime-file resolver could sweep it in. Microsoft rejects a package
  // containing unexplained PNGs, and the size would jump by 600 KB.
  const runtime = readFileSync(path.join(root, "scripts", "runtime-files.mjs"), "utf8");
  assert.ok(!/store-uploads/.test(runtime), "the packager must not reference store-uploads");
  assert.ok(!/store-assets/.test(runtime), "the packager must not reference store-assets");
});
