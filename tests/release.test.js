/**
 * Release automation.
 *
 * The publish workflow is the only thing standing between a tag and a store
 * submission, and it cannot be exercised in this repository: it needs Microsoft's
 * API and three secrets. What can be checked is that it exists, that it triggers on
 * the right event, that it gates on the version match, and that it never asks for a
 * credential that is not a secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const releasePath = path.join(root, ".github", "workflows", "release.yml");
const release = existsSync(releasePath) ? await readFile(releasePath, "utf8") : "";

test("a release workflow exists and is triggered by a version tag", () => {
  assert.ok(release, "missing .github/workflows/release.yml");
  // Publishing must not happen on a push to main. A submission enters Microsoft's
  // certification queue, so firing on every merge would submit work in progress.
  assert.match(release, /tags:\s*\n\s*- "v\*"/, "the workflow must trigger on v* tags");
  assert.ok(!/on:\s*\n\s*push:\s*\n\s*branches:/.test(release),
    "the release must not trigger on a branch push");
});

test("the release refuses a tag that disagrees with the manifest", () => {
  // A stale manifest once produced a zip labelled with the wrong version; catching
  // that here fails the release instead of the store listing.
  assert.match(release, /Verify the tag matches the manifest/);
  assert.match(release, /tag_version/);
  assert.match(release, /manifest\.json/);
  assert.match(release, /package\.json/);
});

test("credentials come from secrets and never from the workflow file", () => {
  for (const name of ["EDGE_ADDONS_PRODUCT_ID", "EDGE_ADDONS_CLIENT_ID", "EDGE_ADDONS_API_KEY"]) {
    assert.ok(release.includes(`secrets.${name}`), `${name} must be read from secrets`);
  }
  // A hex string the length of an API key, standing on its own, would mean a leaked
  // credential was pasted in. Matching loosely (any long hex run) hit unrelated text,
  // so this looks for a quoted or assigned value.
  const keyLike = /(?:^|[=:\s])["']?[0-9a-f]{32,}["']?(?:$|[\s,;}])/im.test(release);
  assert.ok(!keyLike, "the workflow file must not contain an inline key-like literal");
});

test("the release runs the same checks a developer runs", () => {
  // Packaging in CI with a different path than locally is how a build ends up with
  // files nobody tested.
  assert.match(release, /npm test/);
  assert.match(release, /npm run check/);
  assert.match(release, /npm run package:extension/);
});

test("two releases cannot submit at the same time", () => {
  // Both would upload a package and both would publish; the second would win with
  // no record that the first happened. Matched loosely because a comment sits above
  // the key in the workflow, which a line-anchored pattern would step over.
  assert.match(release, /^\s*concurrency:/m);
  assert.match(release, /^\s*group:/m);
  assert.match(release, /cancel-in-progress:\s*false/);
});

test("the release can be re-run for an already-pushed tag", () => {
  // Repairing a failed release must not require deleting and re-pushing a tag,
  // which rewrites history for anyone who fetched it.
  assert.match(release, /workflow_dispatch/);
});

test("Python scripts are invoked as python3", async () => {
  // GitHub's Ubuntu runners provide python3; `python` is not guaranteed. A workflow
  // that calls the bare name fails at the last step before publishing.
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.ok(!/(?:^|&&\s*)python\s+scripts\//.test(command),
      `script "${name}" calls bare "python"; use python3`);
  }
  const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(!/\bpython\s+-m\s/.test(ci), "CI must call python3, not python");
});
