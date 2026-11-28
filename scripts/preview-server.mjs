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
 *   ?sync=1           seed an enabled sync record
 *   ?rules=N          seed N rules so long-list behaviour can be seen
 *
 * Two entry points:
 *   /            the popup on its own
 *   /lab         several popup states side by side, live-reloading on file change
 *
 * The lab exists because reviewing a change meant packaging the extension and
 * reinstalling it into Edge every time. Editing a stylesheet should not require a
 * browser restart.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
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
  // The popup is served from two different URLs - /src/popup.html and the short
  // alias / - but its own href/src values are relative ("popup.css"). At "/" those
  // resolve to /popup.css, which does not exist, so the stylesheet and the controller
  // both 404 and the page renders unstyled and dead. Rewriting them to absolute paths
  // makes the response independent of the URL it was requested from.
  // Every relative reference in the document, not just the two that existed when this
  // was written. Adding brand/fonts.css broke the alias because it was not listed -
  // tests/preview.test.js caught it, which is the whole reason that test exists.
  const absolute = html
    .replace(/(href|src)="(?!https?:|\/|data:|#)([^"]+)"/g, (_match, attr, value) => `${attr}="/src/${value}"`);
  return absolute.replace(
    '<script type="module"',
    '<script src="/preview/chrome-shim.js"></script>\n  <script type="module"'
  );
}

/* ---------------------------------------------------------------- live reload */

/**
 * Server-sent events.
 *
 * Deliberately not polling and not a websocket: SSE is one HTTP response that stays
 * open, needs no dependency, and reconnects on its own if the tab is backgrounded.
 */
const clients = new Set();

function broadcastChange(changedPath) {
  const payload = `event: change\ndata: ${JSON.stringify({ path: changedPath })}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

// Watch the directories that can change what the preview renders. Debounced because
// an editor writing a file can produce several events in a row.
let debounce = null;
const watchedPaths = ["src", "preview", "icons"].map((dir) => path.join(root, dir));
for (const target of watchedPaths) {
  try {
    watch(target, { recursive: true }, (_event, filename) => {
      if (!filename || filename.includes(".swp") || filename.endsWith("~")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => broadcastChange(String(filename)), 80);
    });
  } catch {
    // A missing directory must not stop the server; the preview still works, it just
    // will not reload on its own.
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/__events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    // An initial comment flushes headers so the client's open event fires promptly.
    response.write(": connected\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  // Every entry point is reachable from every other one on one port. A link to a
  // second port the user has not started is a dead link, which is what /lab's
  // pointer to the comparison page used to be.
  if (pathname === "/") pathname = "/src/popup.html";
  if (pathname === "/lab") pathname = "/preview/lab.html";
  if (pathname === "/compare") pathname = "/preview/compare.html";
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
  console.log("  ?sync=1  sync enabled           ?rules=N    fill the rule list");
});
