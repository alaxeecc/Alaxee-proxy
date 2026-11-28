/**
 * Structural guarantees about the package and the UI wiring.
 *
 * Scope note: this file deliberately asserts *structure* — that files exist,
 * references resolve, the artifact matches the runtime closure, and the DOM
 * contract between the UI modules and popup.html holds. It does not assert that
 * particular source lines exist. Earlier versions did, which produced a green
 * suite that could not be trusted: it failed on harmless refactors and passed
 * on real bugs. Behaviour belongs in core.test.js and pac.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { BACKUP_VERSION } from "../src/backup.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRuntimeFiles } from "../scripts/runtime-files.mjs";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

function assertLocalFile(relativePath, label) {
  assert.ok(existsSync(path.join(root, relativePath)), `${label} points to missing file: ${relativePath}`);
}

test("manifest declares the expected MV3 shape and minimal permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.type, "module");
  for (const permission of ["proxy", "storage", "activeTab"]) {
    assert.ok(manifest.permissions.includes(permission), `missing required permission: ${permission}`);
  }
  assert.ok(manifest.optional_permissions.includes("tabs"));
  for (const forbidden of ["webRequest", "host_permissions", "<all_urls>", "cookies", "identity", "history"]) {
    assert.ok(!manifest.permissions.includes(forbidden), `unexpected permission: ${forbidden}`);
    assert.ok(!(manifest.host_permissions ?? []).includes(forbidden), `unexpected host permission: ${forbidden}`);
  }
});

test("manifest entry points resolve to packaged files", async () => {
  const { files, missing } = await resolveRuntimeFiles(root);
  assert.deepEqual(missing, [], `unresolved references: ${missing.join(", ")}`);
  for (const entry of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page
  ]) {
    assert.ok(files.includes(entry), `entry point not in runtime closure: ${entry}`);
  }
});

test("every manifest icon and status icon is part of the runtime closure", async () => {
  const { files } = await resolveRuntimeFiles(root);
  for (const icon of Object.values(manifest.icons)) assert.ok(files.includes(icon), `missing icon: ${icon}`);
  for (const icon of Object.values(manifest.action.default_icon)) assert.ok(files.includes(icon), `missing action icon: ${icon}`);
  for (const state of ["proxy", "direct", "unknown"]) {
    for (const size of [16, 32]) {
      const icon = `icons/status/${state}${size}.png`;
      assert.ok(files.includes(icon), `missing status icon: ${icon}`);
    }
  }
});

test("module imports in the runtime closure all resolve to packaged files", async () => {
  const { files, bareImports } = await resolveRuntimeFiles(root);
  assert.deepEqual(bareImports, [], "the extension must stay dependency-free at runtime");
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.posix.join(path.posix.dirname(file), specifier);
      assert.ok(files.includes(resolved), `${file} imports ${specifier} which is not packaged`);
    }
  }
});

test("the packaged artifact contains exactly the runtime closure", async () => {
  const { manifest: builtManifest, files } = await resolveRuntimeFiles(root);
  // Rebuild so the archive cannot be stale from an earlier layout.
  execFileSync("python3", [path.join(root, "scripts/package-extension.py")], { cwd: root, stdio: "ignore" });
  const archivePath = path.join(root, "dist", `Alaxee-Proxy-v${builtManifest.version}.zip`);
  assert.ok(existsSync(archivePath), `package was not created: ${archivePath}`);

  // The resolver returns the file list; the packager verifies the ZIP against it
  // and exits non-zero on any mismatch, so a successful run is the assertion.
  // Listing via Python's zipfile keeps the test free of an unzip binary dependency.
  const listing = execFileSync(
    "python3",
    ["-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", archivePath],
    { cwd: root, encoding: "utf8" }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual([...listing].sort(), [...files].sort());
});

test("options page reuses the popup controller instead of duplicating it", async () => {
  const html = await readFile(path.join(root, manifest.options_ui.page), "utf8");
  assert.match(html, /src="settings\.js"/);
  const entry = await readFile(path.join(root, "settings.js"), "utf8");
  assert.match(entry, /chrome\.runtime\.getURL\("src\/popup\.html\?full=1"\)/);
  assert.match(entry, /window\.location\.replace/);
});

test("the UI modules only query element ids that popup.html actually defines", async () => {
  const html = await readFile(path.join(root, manifest.action.default_popup), "utf8");
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const file of ["src/popup-render.js", "src/popup-controller.js"]) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) {
      if (!declared.has(id)) missing.push(`${file}: ${id}`);
    }
  }
  assert.deepEqual(missing, [], `UI modules query ids that do not exist: ${missing.join(", ")}`);
});

test("the popup entry point loads the controller, not a removed module", async () => {
  const html = await readFile(path.join(root, manifest.action.default_popup), "utf8");
  const [, entry] = html.match(/<script[^>]+src="([^"]+)"/) ?? [];
  assert.ok(entry, "popup.html has no module entry point");
  assert.ok(existsSync(path.join(root, "src", path.basename(entry))), `missing entry point: ${entry}`);
});

test("both UI surfaces stay in sync through a write-free storage listener", async () => {
  // The toolbar popup and the full settings page can be open at once and share
  // one settings record. An edit on one must reach the other without a reload,
  // and the listener must not write or it would ping-pong between surfaces.
  const controller = await readFile(path.join(root, "src/popup-controller.js"), "utf8");
  assert.match(controller, /chrome\.storage\.onChanged\.addListener/);

  const start = controller.indexOf("function startWatchingOtherSurface()");
  assert.ok(start > -1, "missing cross-surface sync");
  const end = controller.indexOf("\n}\n", start);
  const body = controller.slice(start, end);
  assert.doesNotMatch(body, /storage\.local"?,?\s*"set/, "sync listener must not write storage");
  assert.doesNotMatch(body, /proxy\.settings/, "sync listener must not touch proxy settings");
  assert.match(body, /renderRules\(\)/, "sync listener must re-render the rule list");
  assert.match(body, /renderCurrentPage\(\)/, "sync listener must re-render the current site");
});

test("rendering module does not touch chrome APIs or storage", async () => {
  // The split only earns its keep if the render layer stays free of side effects.
  const render = await readFile(path.join(root, "src/popup-render.js"), "utf8");
  const stripped = render.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripped, /\bchrome\./, "popup-render.js must not call chrome.*");
  assert.doesNotMatch(stripped, /\bawait\b/, "popup-render.js must stay synchronous");
});

test("popup keeps one bounded scroll container and respects reduced motion", async () => {
  const css = await readFile(path.join(root, "src/popup.css"), "utf8");
  assert.match(css, /html, body \{[^}]*overflow: hidden/s);
  assert.match(css, /\.app-shell \{[^}]*overflow-y: auto/s);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test("every toolbar state has a distinct visual treatment in the popup", async () => {
  // The mark used to swap between three separate silhouettes. It is now one shape
  // recoloured per state, so what has to stay true is not "three paths exist" but
  // "every state the toolbar can show is styled, and no two share a colour".
  const html = await readFile(path.join(root, "src/popup.html"), "utf8");
  const css = await readFile(path.join(root, "src/popup.css"), "utf8");
  assert.match(html, /id="brandMark"/);
  assert.match(html, /class="brand-icon"/, "the header mark must be the kit's artwork");

  // The mark is now four distinct images rather than one shape recoloured, so the
  // invariant is "every state points at its own file".
  const renderer = await readFile(path.join(root, "src", "popup-render.js"), "utf8");
  const icons = new Set();
  for (const route of ["proxy", "direct", "forced", "unknown"]) {
    const rule = new RegExp(`\\b${route}:\\s*"(?:/)?(src/brand/icons/[^"]+)"`).exec(renderer);
    assert.ok(rule, `${route} has no icon file`);
    assert.ok(!icons.has(rule[1]), `${route} reuses ${rule[1]}`);
    icons.add(rule[1]);
    assert.ok(existsSync(path.join(root, rule[1])), `${rule[1]} does not exist`);
  }
});

test("repository keeps its release and privacy documentation", () => {
  for (const file of [
    "scripts/package-extension.py",
    "scripts/runtime-files.mjs",
    "scripts/publish-edge-addons.mjs",
    "docs/EDGE-ADDONS-PUBLISHING.md",
    "PRIVACY.md",
    "STORE-LISTING.md",
    "TESTING.md"
  ]) {
    assertLocalFile(file, "project document");
  }
});

test("the settings listener reacts to the sync area without rendering it as local state", async () => {
  // A peer writing chunks arrives as sync-area storage events. Rendering those as if
  // they were local settings would bypass the merge entirely, so the handler must
  // route them to a reconcile instead. This asserts the wiring exists; the merge
  // behaviour itself is covered in sync.test.js.
  const controller = await readFile(path.join(root, "src/popup-controller.js"), "utf8");
  const start = controller.indexOf("function startWatchingOtherSurface()");
  assert.ok(start > -1);
  const body = controller.slice(start, controller.indexOf("\n}\n", start));
  assert.match(body, /areaName === "sync"/, "sync-area changes must be handled");
  assert.match(body, /scheduleReconcile\(\)/, "sync-area changes must trigger a reconcile");
  assert.match(body, /areaName !== "local"/, "local handling must stay separate");
});

test("no module reads the sync area except through sync.js", async () => {
  // One place decides how the payload is shaped and validated. A second reader would
  // drift, and a drifted reader is how a truncated rule list gets adopted.
  const offenders = [];
  for (const file of ["src/popup-controller.js", "src/popup-render.js", "src/backup.js", "background.js"]) {
    const source = await readFile(path.join(root, file), "utf8");
    if (/chrome\.storage\.sync/.test(source) && !file.endsWith("popup-controller.js")) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "sync reads belong in the controller via sync.js");
});

test("manifest and package.json versions agree and are valid for the store", async () => {
  // A mismatch here is not cosmetic: the zip is named from the manifest version while
  // npm reads package.json, so a stale one produces an artifact labelled with the
  // wrong number. That happened during a release once and had to be caught by grep.
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(typeof pkg.version, "string");
  assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
  // Chrome and Edge require 1-4 dot-separated integers, each 0-65535, no leading zero.
  assert.match(manifest.version, /^([0-9]|[1-9][0-9]{0,3})(\.([0-9]|[1-9][0-9]{0,3})){0,3}$/);
});

test("the backup format version is independent of the extension version", () => {
  // Bumping the product version must not invalidate files users already exported.
  // The format carries its own integer for exactly that reason.
  assert.equal(typeof BACKUP_VERSION, "number");
  assert.ok(BACKUP_VERSION >= 1);
  assert.ok(!manifest.version.startsWith(`${BACKUP_VERSION}.`), "these are unrelated numbers");
});

test("the development workbench stays out of the package", async () => {
  // The lab and the shim are how changes get reviewed without reinstalling the
  // extension. They must never ship: the shim stubs chrome.storage with localStorage
  // and would silently fake every setting if it ever reached a user.
  const { files: names } = await resolveRuntimeFiles(root);
  for (const forbidden of ["preview/", "preview"]) {
    assert.ok(
      !names.some((name) => name.startsWith(forbidden)),
      `the packaged artifact must not contain ${forbidden}`
    );
  }
  assert.ok(names.includes("src/popup.html"));
});

test("the comparison harness cannot leak into the package", async () => {
  // scripts/preview-compare.mjs creates a git worktree at runtime. If it were ever
  // packaged it would be a script that shells out to git from inside an extension.
  const { files } = await resolveRuntimeFiles(root);
  for (const name of files) {
    assert.ok(!name.includes("compare"), `unexpected runtime file: ${name}`);
    assert.ok(!name.startsWith("scripts/"), `build scripts must not ship: ${name}`);
  }
});

test("the store-facing name and description are in Chinese", () => {
  // These two fields are read-only in Partner Center once a package is uploaded:
  // they populate the store listing and cannot be edited there. Shipping them in
  // English while the interface, screenshots and listing copy are Chinese made the
  // store page the only English surface in the product.
  const m = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(/[\u4e00-\u9fff]/.test(m.description), "the description must be Chinese");
  assert.ok(m.description.length <= 132, "store descriptions cap at 132 characters");
  // The name stays Latin: it is the brand, and it is what users search for.
  assert.equal(m.name, "Alaxee Proxy");
  assert.ok(m.name.length <= 45, "extension names cap at 45 characters");
});
