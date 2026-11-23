/**
 * The preview server.
 *
 * These exist because the preview silently shipped broken twice: the short alias /
 * served a page whose relative "popup.css" resolved to a 404, so the panel rendered
 * unstyled and inert, and /lab linked to a page on a port that was not running.
 *
 * Neither showed up in the Node DOM harness, because that harness imports the
 * modules directly and never exercises the URLs a browser would request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const PORT = 4319;

let server;
let base;

test.before(async () => {
  server = spawn(process.execPath, [path.join(root, "scripts/preview-server.mjs"), String(PORT)], {
    cwd: root,
    stdio: "ignore"
  });
  base = `http://127.0.0.1:${PORT}`;
  // Wait for the port rather than sleeping a fixed amount.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/src/popup.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("preview server did not start");
});

test.after(() => {
  server?.kill();
});

/** Every relative asset a document references, resolved the way a browser would. */
function assetUrls(html, pageUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(data:|#|https?:)/.test(value)) continue;
    urls.add(new URL(value, pageUrl).href);
  }
  return [...urls];
}

for (const entry of ["/", "/src/popup.html"]) {
  test(`${entry} loads every asset it references`, async () => {
    const response = await fetch(base + entry);
    assert.equal(response.status, 200);
    const href = `${base}${entry}`;
    const assets = assetUrls(await response.text(), href);
    assert.ok(assets.length >= 3, "expected a stylesheet, the shim and the controller");

    const broken = [];
    for (const url of assets) {
      const assetResponse = await fetch(url);
      if (!assetResponse.ok) broken.push(`${new URL(url).pathname} -> ${assetResponse.status}`);
    }
    // This is the exact failure that shipped: /popup.css -> 404 from the alias.
    assert.deepEqual(broken, [], `broken assets from ${entry}:\n  ${broken.join("\n  ")}`);
  });
}

test("the stylesheet is actually applied through the alias, not just fetchable", async () => {
  // A 200 is not enough: the page must point at the real stylesheet, because a
  // missing one still returns a perfectly valid 404-free HTML document.
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /href="\/src\/popup\.css"/);
  assert.match(html, /src="\/src\/popup-controller\.js"/);
});

test("the workbench links to nothing that 404s", async () => {
  const html = await (await fetch(`${base}/lab`)).text();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  const internal = links.filter((value) => value.startsWith("/"));
  const broken = [];
  for (const link of internal) {
    const response = await fetch(base + link);
    if (!response.ok) broken.push(`${link} -> ${response.status}`);
  }
  assert.deepEqual(broken, [], `dead links in the workbench:\n  ${broken.join("\n  ")}`);
});

test("the preview is marked so a stale copy cannot pass for the real extension", async () => {
  // The shim replaces chrome.storage with localStorage. Anyone looking at the page
  // should be able to tell it is a simulation.
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /preview\/chrome-shim\.js/);
});
