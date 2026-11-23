/**
 * Structural guarantees about the package and the UI wiring.
 *
 * Scope note: this file deliberately asserts *structure* — that files exist,
 * references resolve, the artifact matches the runtime closure, and the DOM
 * contract between popup.js and popup.html holds. It does not assert that
 * particular source lines exist. Earlier versions did, which produced a green
 * suite that could not be trusted: it failed on harmless refactors and passed
 * on real bugs. Behaviour belongs in core.test.js and pac.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  for (const state of ["clash", "direct", "system", "unknown"]) {
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

test("popup.js only queries element ids that popup.html actually defines", async () => {
  const html = await readFile(path.join(root, manifest.action.default_popup), "utf8");
  const script = await readFile(path.join(root, "src/popup.js"), "utf8");
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const queried = new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...queried].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `popup.js queries ids that do not exist: ${missing.join(", ")}`);
});

test("popup keeps one bounded scroll container and respects reduced motion", async () => {
  const css = await readFile(path.join(root, "src/popup.css"), "utf8");
  assert.match(css, /html, body \{[^}]*overflow: hidden/s);
  assert.match(css, /\.app-shell \{[^}]*overflow-y: auto/s);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test("every toolbar state has a distinct visual treatment in the popup", async () => {
  const html = await readFile(path.join(root, "src/popup.html"), "utf8");
  const css = await readFile(path.join(root, "src/popup.css"), "utf8");
  assert.match(html, /id="brandMark"/);
  for (const route of ["clash", "direct", "system", "unknown"]) {
    assert.ok(html.includes(`route-shape route-${route}`), `missing ${route} silhouette`);
    assert.ok(css.includes(`data-route="${route}"`), `missing ${route} styling`);
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
