/**
 * Brand assets.
 *
 * The fonts are the one part of the brand the app loads at runtime, and they fail
 * quietly: a missing subset renders the whole panel in the system font, and a
 * character missing from a subset renders as a fallback glyph in the middle of a
 * sentence. Neither shows up as an error - the page just looks slightly wrong - so
 * they are checked here instead.
 *
 * The subset is also checked for reproducibility: its input character set is derived
 * from the sources by scripts/subset-font.py rather than kept in a side file, which
 * is what made an earlier version impossible to rebuild from a clean checkout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { woff2CodePoints } from "../scripts/woff2-cmap.mjs";

const root = process.cwd();
const FONT_DIR = path.join(root, "src", "brand", "fonts");

test("the brand stylesheet and both font faces ship", async () => {
  // The package is built by walking from the manifest, and a @font-face url() is an
  // easy thing for that walk to miss - it did, and the fonts were silently left out
  // of the build while fonts.css was included.
  for (const file of [
    "src/brand/fonts.css",
    "src/brand/fonts/serif-sc-400.woff2",
    "src/brand/fonts/serif-latin-400.woff2"
  ]) {
    assert.ok(existsSync(path.join(root, file)), `missing ${file}`);
  }

  const css = await readFile(path.join(root, "src", "brand", "fonts.css"), "utf8");
  for (const family of ["serif-sc", "serif-latin"]) {
    assert.ok(css.includes(`${family}-400.woff2`), `fonts.css does not reference ${family}`);
  }
  // The split only works because each face declares which code points it owns;
  // without unicode-range both are downloaded for every page load.
  assert.ok(css.includes("unicode-range"), "fonts.css must declare unicode-range");
  assert.ok(css.includes("font-display: swap"), "a missing font must not hide the text");
});

test("the CJK subset stays small enough to justify subsetting", async () => {
  // The full face is 1.47 MB. The whole point of subsetting is that the extension
  // ships a fraction of it; if this fails, the subset was rebuilt without a
  // character list and every glyph came along.
  const { size } = await stat(path.join(FONT_DIR, "serif-sc-400.woff2"));
  const kb = size / 1024;
  assert.ok(kb < 300, `the subset grew to ${kb.toFixed(0)} KB; expected well under 300`);
  assert.ok(kb > 20, `${kb.toFixed(0)} KB is too small to contain a CJK face at all`);
});

test("the subset covers every character the UI can draw", async () => {
  // Reads the shipped font's own cmap rather than shelling out to the Python build
  // script. That script needs fontTools, which is not an npm dependency - so relying
  // on it meant this test silently skipped in a plain checkout, which is exactly the
  // situation it exists to catch.
  const covered = woff2CodePoints(await readFile(path.join(FONT_DIR, "serif-sc-400.woff2")));

  const sources = [
    "src/popup.html",
    "src/popup-render.js",
    "src/popup-controller.js",
    "src/core.js",
    "src/backup.js",
    "src/sync.js",
    "settings.html",
    "settings.js"
  ];
  const isCjk = (code) =>
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef);

  const used = new Set();
  for (const relative of sources) {
    const text = await readFile(path.join(root, relative), "utf8");
    for (const character of text) {
      const code = character.codePointAt(0);
      if (isCjk(code)) used.add(character);
    }
  }

  const missing = [...used].filter((character) => !covered.has(character.codePointAt(0)));
  assert.deepEqual(missing, [], `these characters fall back to a system font: ${missing.join("")}`);
  assert.ok(used.size > 300, `only ${used.size} CJK characters found; the scan is not reading the UI`);
});

test("the brand fonts carry their licence", async () => {
  // Noto Serif SC is SIL OFL: redistributing the subset requires the licence text.
  const licence = await readFile(path.join(FONT_DIR, "OFL-NotoSerifSC.txt"), "utf8");
  assert.match(licence, /SIL OPEN FONT LICENSE/i);
});

test("the font licence travels in the package", () => {
  // SIL OFL requires the licence to accompany the font. Nothing imports a text file,
  // so the manifest walk cannot discover it - it is added explicitly, and this keeps
  // that explicit step from being refactored away.
  const output = execFileSync("node", [path.join(root, "scripts", "runtime-files.mjs")], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(output, /src\/brand\/fonts\/OFL-NotoSerifSC\.txt/);
  assert.match(output, /src\/brand\/fonts\/serif-sc-400\.woff2/, "the CJK subset must ship");
  assert.match(output, /src\/brand\/fonts\/serif-latin-400\.woff2/, "the Latin face must ship");
});

test("the settings hand-off page is dressed in the current palette", async () => {
  // settings.html exists only to redirect to src/popup.html?full=1, which made it
  // easy to forget: it kept the previous teal palette and an unrelated glyph for a
  // long time after the rest of the UI was rebranded. The flash is brief but it is
  // the first frame a user sees after clicking the settings button.
  const css = await readFile(path.join(root, "settings.css"), "utf8");
  const html = await readFile(path.join(root, "settings.html"), "utf8");

  // The old palette, stated explicitly: these are the values that must not return.
  for (const stale of ["#087f73", "#f4f7f7", "#40b49e", "#66c7b6", "#101819"]) {
    assert.ok(!css.includes(stale), `settings.css still uses the previous palette (${stale})`);
  }
  assert.match(css, /--accent:#B5457A/, "settings.css must carry the brand accent");
  assert.match(css, /--bg:#FAF6F4/, "settings.css must carry the brand page colour");

  // And it must show the same mark as the popup rather than a stand-in character.
  assert.ok(!html.includes("⌁"), "settings.html still uses the placeholder glyph");
  assert.match(html, /class="bm-star"/, "settings.html needs the brand mark");
  assert.match(html, /远黛/, "settings.html needs the brand wordmark");
  assert.match(html, /Alaxee Proxy/, "the hand-off page must still name the product");
});
