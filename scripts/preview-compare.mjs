#!/usr/bin/env node
/**
 * Side-by-side comparison against an earlier commit.
 *
 * Reviewing a visual change from a description is unreliable - "the text is bigger"
 * does not tell anyone whether it now looks right. This serves the current popup and
 * the popup as of a given commit at the same time, from two different origins, so
 * they can be put next to each other (or overlaid) without switching branches.
 *
 * Usage:
 *   node scripts/preview-compare.mjs [baseline-ref] [port]
 *
 * A worktree is created at .preview-baseline/ and removed when the process exits.
 * Development only - never packaged (a test asserts preview/ stays out of the zip).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const baselineRef = process.argv[2] ?? "HEAD~1";
const port = Number(process.argv[3] ?? process.env.PORT ?? 4174);
const worktree = path.join(root, ".preview-baseline");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function prepareBaseline() {
  if (existsSync(worktree)) {
    try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" }); } catch {}
  }
  execFileSync("git", ["worktree", "add", "--detach", worktree, baselineRef], { cwd: root, stdio: "ignore" });
  const label = execFileSync("git", ["log", "-1", "--format=%h %s", baselineRef], { cwd: root, encoding: "utf8" }).trim();
  return label;
}

function cleanup() {
  try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" }); } catch {}
  try { rmSync(worktree, { recursive: true, force: true }); } catch {}
}

/**
 * Rewrites the popup's asset paths so a copy loaded from the baseline tree resolves
 * its stylesheet and controller inside that tree instead of the current one.
 */
function rewireBaselineHtml(html, prefix) {
  return html
    .replace(/href="popup\.css"/g, `href="${prefix}/src/popup.css"`)
    .replace(/src="popup-controller\.js"/g, `src="${prefix}/src/popup-controller.js"`)
    .replace('<script src="/preview/chrome-shim.js"></script>', `<script src="${prefix}/preview/chrome-shim.js"></script>`);
}

const SHIM_TAG = '<script src="/preview/chrome-shim.js"></script>';

function injectShim(html) {
  return html.replace('<script type="module"', `${SHIM_TAG}\n  <script type="module"`);
}

async function serveFile(response, filePath) {
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-frame-options": "",
      "content-security-policy": ""
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}

const baselineLabel = prepareBaseline();
console.log(`baseline: ${baselineLabel}`);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  // /baseline/... is served from the worktree, /... from the working tree. Separate
  // paths keep the two sets of relative imports from resolving into each other.
  if (pathname.startsWith("/baseline/")) {
    const rest = pathname.slice("/baseline".length);
    if (rest === "/src/popup.html") {
      const html = await readFile(path.join(worktree, "src/popup.html"), "utf8");
      response.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store", "x-frame-options": "" });
      response.end(rewireBaselineHtml(injectShim(html), "/baseline"));
      return;
    }
    if (rest === "/preview/chrome-shim.js") {
      // The shim imports core.js relative to itself, which lands in the worktree.
      return serveFile(response, path.join(worktree, "preview/chrome-shim.js"));
    }
    const target = path.join(worktree, rest);
    if (!target.startsWith(worktree)) return response.writeHead(403).end();
    return serveFile(response, target);
  }

  if (pathname === "/" ) {
    const html = await readFile(path.join(root, "src/popup.html"), "utf8");
    response.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store", "x-frame-options": "" });
    response.end(injectShim(html));
    return;
  }
  if (pathname === "/compare") {
    const html = await readFile(path.join(root, "preview/compare.html"), "utf8");
    response.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store", "x-frame-options": "" });
    response.end(html.replace("__BASELINE_LABEL__", baselineLabel.replace(/"/g, "&quot;")));
    return;
  }
  if (pathname === "/favicon.ico") return response.writeHead(204).end();

  const target = path.join(root, pathname);
  if (!target.startsWith(root)) return response.writeHead(403).end();
  return serveFile(response, target);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`compare: http://0.0.0.0:${port}/compare`);
  console.log("  left = current working tree, right = baseline commit");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { cleanup(); process.exit(0); });
}
process.on("exit", cleanup);
