#!/usr/bin/env node
/**
 * Design-review server for the popup. Development only - never packaged.
 *
 * The popup is an extension page, so it normally cannot be opened without loading
 * the unpacked extension into a Chromium browser. This server serves the real
 * src/popup.html, the real stylesheet and the real controller, with
 * preview/chrome-shim.js standing in for the chrome.* APIs, so layout and every UI
 * state can be reviewed (and screenshotted) over HTTP.
 *
 * Usage:
 *   node scripts/preview-server.mjs [port]
 *
 * Query parameters let you put the UI into a specific situation:
 *   ?tab=<url>        the simulated current tab
 *   ?control=<level>  not_controllable | controlled_by_other_extensions
 *   ?tabs=1           simulate the optional tabs permission being granted
 *   ?settings=<json>  override the seeded settings record (URL-encoded)
 *   ?full=1           render the full settings page layout
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

/**
 * Injects the chrome.* shim ahead of the module entry point.
 *
 * The shim must be a classic script that runs first, because ES module imports are
 * hoisted: a module-typed shim would still be evaluated after the controller's
 * imports were resolved.
 */
function injectShim(html) {
  return html.replace(
    '<script type="module"',
    '<script src="/preview/chrome-shim.js"></script>\n  <script type="module"'
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") pathname = "/src/popup.html";
  if (pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }

  const filePath = path.join(root, pathname);
  // Path traversal guard: everything served must live inside the repository.
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = TYPES[path.extname(filePath)] ?? "application/octet-stream";
    const isPopup = pathname === "/src/popup.html";
    response.writeHead(200, {
      "content-type": type,
      // The preview is embedded in an iframe by the review UI.
      "cache-control": "no-store",
      "x-frame-options": "",
      "content-security-policy": ""
    });
    response.end(isPopup ? injectShim(body.toString("utf8")) : body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Alaxee Proxy preview: http://0.0.0.0:${port}/`);
  console.log("  ?full=1  full settings layout   ?tab=<url>  simulated tab");
});
