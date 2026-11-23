/**
 * Derives the set of files that must ship in the Edge package by walking
 * forward from manifest.json.
 *
 * Why this exists: the packager used a hand-maintained allowlist. That style
 * of list fails open. Adding a module and importing it from the popup left the
 * package build green while silently omitting the file, which only surfaces as
 * a blank popup after a store user installs it. Deriving the closure from the
 * manifest makes that class of mistake impossible to express.
 *
 * Resolution deliberately mirrors the browser rather than a bundler:
 *   - ES module `import ... from "./x.js"` resolves relative to the importer
 *   - HTML `src` / `href` resolve relative to the importing document
 *   - the service worker, popup, options page and icons are entry points
 *
 * Unresolvable references are reported, never skipped.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = "manifest.json";

const HTML_REF = /(?:src|href)\s*=\s*"([^"]+)"/g;
const JS_FROM = /\bfrom\s*["']([^"']+)["']/g;
const JS_BARE = /\bimport\s*["']([^"']+)["']/g;
const JS_DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXTERNAL_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

// Icon PNGs are not imported; background.js addresses them as string literals
// so a failed canvas draw can fall back to a shipped file. A pure import walk
// would silently drop them from the package, so string literals rooted at an
// asset directory are treated as file references and must exist.
const ASSET_ROOTS = ["icons/", "assets/"];
const ASSET_LITERAL = /["'`]([^"'`\s]+\.(?:png|jpe?g|svg|gif|webp|ico|bmp))["'`]/gi;

function assetRefs(source) {
  const refs = new Set();
  for (const match of source.matchAll(ASSET_LITERAL)) {
    const ref = match[1].trim();
    if (EXTERNAL_REF.test(ref)) continue;
    if (!ASSET_ROOTS.some((root) => ref.startsWith(root))) continue;
    refs.add(ref);
  }
  return [...refs];
}

function toPosix(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

/** Collects every file the manifest points at, before transitive resolution. */
export function manifestEntryPoints(manifest) {
  const entries = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) entries.add(value.trim());
  };

  add(manifest.background?.service_worker);
  for (const script of manifest.background?.scripts ?? []) add(script);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.devtools_page);
  add(manifest.side_panel?.default_path);
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);
  for (const block of manifest.content_scripts ?? []) {
    for (const script of block.js ?? []) add(script);
    for (const style of block.css ?? []) add(style);
  }
  for (const block of manifest.web_accessible_resources ?? []) {
    for (const resource of block.resources ?? []) add(resource);
  }

  return [...entries];
}

function htmlRefs(source) {
  const refs = [];
  for (const match of source.matchAll(HTML_REF)) {
    const ref = match[1].trim();
    if (!ref || EXTERNAL_REF.test(ref)) continue;
    refs.push(ref.split(/[?#]/)[0]);
  }
  return refs.filter(Boolean);
}

function jsRefs(source) {
  const refs = new Set();
  for (const pattern of [JS_FROM, JS_BARE, JS_DYNAMIC]) {
    for (const match of source.matchAll(pattern)) {
      const ref = match[1].trim();
      // Only relative specifiers become package files. Bare specifiers stay
      // unresolved on purpose so an accidental npm dependency is visible.
      if (ref.startsWith("./") || ref.startsWith("../")) refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Resolves the full runtime file closure.
 * @returns {Promise<{manifest: object, files: string[], missing: string[], bareImports: string[]}>}
 */
export async function resolveRuntimeFiles(root = process.cwd()) {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8"));
  const files = new Set([MANIFEST_FILE]);
  const missing = [];
  const bareImports = new Set();
  const seen = new Set();
  const queue = manifestEntryPoints(manifest).map((entry) => toPosix(entry));

  while (queue.length > 0) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      missing.push(relative);
      continue;
    }

    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    files.add(relative);

    const extension = path.extname(relative).toLowerCase();
    if (![".js", ".mjs", ".html"].includes(extension)) continue;

    const source = await readFile(absolute, "utf8");
    const refs = extension === ".html"
      ? htmlRefs(source)
      : [...jsRefs(source), ...assetRefs(source)];

    if (extension !== ".html") {
      for (const match of source.matchAll(JS_FROM)) {
        const specifier = match[1].trim();
        if (!specifier.startsWith(".")) bareImports.add(specifier);
      }
    }

    for (const ref of refs) {
      const resolved = toPosix(path.join(path.dirname(relative), ref));
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  return {
    manifest,
    files: [...files].sort(),
    missing: [...missing].sort(),
    bareImports: [...bareImports].sort()
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("runtime-files.mjs")) {
  const result = await resolveRuntimeFiles();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      files: result.files,
      missing: result.missing,
      bareImports: result.bareImports
    }, null, 2));
  } else {
    for (const file of result.files) console.log(file);
    if (result.missing.length > 0) {
      console.error(`\nUnresolved references:\n${result.missing.map((m) => `  ${m}`).join("\n")}`);
      process.exitCode = 1;
    }
    if (result.bareImports.length > 0) {
      console.error(`\nBare (non-relative) imports are not packaged:\n${result.bareImports.map((m) => `  ${m}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
}
