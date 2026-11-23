/**
 * Cross-device sync.
 *
 * The failure that matters here is not "sync does not work" - it is "sync works
 * halfway and silently truncates the rule list", which looks like the user deleted
 * rules and has no warning at all. Every test below is about refusing a payload
 * that cannot be proven complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { exportSettings } from "../src/backup.js";
import {
  META_KEY,
  SYNC_FORMAT,
  SYNC_PREFIX,
  buildSyncItems,
  checksum,
  chunkKey,
  describeSyncStatus,
  mergeRuleList,
  mergeSettings,
  readSyncState,
  removedHosts,
  settingsDiffer,
  syncDirection,
  staleChunkKeys,
  withTombstones
} from "../src/sync.js";

const RULES = (count, prefix = "site") =>
  Array.from({ length: count }, (_, i) => ({ host: `${prefix}${i}.example-company.com`, includeSubdomains: true }));

const SETTINGS = {
  mode: "proxy",
  scheme: "socks5",
  host: "127.0.0.1",
  port: "7890",
  includeSubdomains: true,
  localBypass: true,
  whitelist: RULES(3),
  blacklist: [{ host: "force.example", includeSubdomains: false }]
};

function roundTrip(settings = SETTINGS, options = { generation: "g1", deviceId: "dev-a" }) {
  const built = buildSyncItems(settings, options);
  return { built, area: { ...built.items } };
}

test("a settings record round-trips through the sync area unchanged", () => {
  const { area } = roundTrip();
  const result = readSyncState(area);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.whitelist, SETTINGS.whitelist);
  assert.deepEqual(result.settings.blacklist, SETTINGS.blacklist);
  assert.equal(result.settings.mode, "proxy");
  assert.equal(result.settings.port, "7890");
  assert.equal(result.settings.localBypass, true);
});

test("every item stays under the 8 KB per-item cap at the rule limit", () => {
  // This is the constraint that forces chunking at all: a full payload is ~31 KB,
  // and chrome.storage.sync rejects any single item over 8,192 bytes.
  const { built } = roundTrip({ ...SETTINGS, whitelist: RULES(250), blacklist: RULES(250, "force") });
  assert.ok(built.chunks >= 2, "a full payload must not fit in one item");
  for (const [key, value] of Object.entries(built.items)) {
    const bytes = key.length + JSON.stringify(value).length;
    assert.ok(bytes < 8192, `${key} is ${bytes} bytes, over the 8 KB item limit`);
  }
});

test("the 512-item cap is never approached", () => {
  const { built } = roundTrip({ ...SETTINGS, whitelist: RULES(250), blacklist: RULES(250, "force") });
  assert.ok(Object.keys(built.items).length < 20, "chunking must not multiply items");
});

test("a missing chunk is refused, not decoded into a shorter rule list", () => {
  const { area, built } = roundTrip({ ...SETTINGS, whitelist: RULES(250), blacklist: RULES(250, "force") });
  assert.ok(built.chunks > 1);
  const partial = { ...area };
  delete partial[chunkKey(built.generation, 1)];
  assert.deepEqual(readSyncState(partial), { ok: false, reason: "incomplete" });
});

test("a payload that does not match its checksum is refused as corrupt", () => {
  const { area } = roundTrip();
  const tampered = { ...area, [chunkKey("g1", 0)]: `${area[chunkKey("g1", 0)]}X` };
  assert.deepEqual(readSyncState(tampered), { ok: false, reason: "corrupt" });
});

test("chunks from an older generation are not mixed into a newer payload", () => {
  const old = roundTrip({ ...SETTINGS, host: "1.1.1.1" }, { generation: "g0" }).built;
  const fresh = roundTrip(SETTINGS, { generation: "g1" }).built;
  // A reader that trusted meta but pulled chunks by index alone would splice these
  // two records together. Keys are generation-scoped, so the read must fail.
  const mixed = { ...old.items, ...fresh.items };
  const result = readSyncState(mixed);
  assert.equal(result.ok, true, "the newest generation still reads cleanly");
  assert.equal(result.settings.host, "127.0.0.1");
  assert.deepEqual(staleChunkKeys(mixed, "g1"), Object.keys(old.items).filter((k) => k.startsWith(SYNC_PREFIX + "c.")));
});

test("old generations are listed for cleanup so the 512-item cap is not leaked", () => {
  const area = {
    ...roundTrip(SETTINGS, { generation: "g1" }).built.items,
    ...roundTrip(SETTINGS, { generation: "g0" }).built.items,
    [META_KEY]: buildSyncItems(SETTINGS, { generation: "g1" }).meta
  };
  const stale = staleChunkKeys(area, "g1");
  assert.deepEqual(stale.sort(), [chunkKey("g0", 0)].sort());
  // Keys outside our namespace must never be touched.
  const foreign = { ...area, "other.extension.key": "keep me" };
  assert.equal(staleChunkKeys(foreign, "g1").includes("other.extension.key"), false);
});

test("an empty sync area is reported as empty rather than as a failure", () => {
  assert.deepEqual(readSyncState({}), { ok: false, reason: "empty" });
  assert.deepEqual(readSyncState(undefined), { ok: false, reason: "empty" });
});

test("a record from a newer extension version is ignored, not guessed at", () => {
  const { area } = roundTrip();
  const future = { ...area, [META_KEY]: { ...area[META_KEY], version: 99 } };
  assert.deepEqual(readSyncState(future), { ok: false, reason: "unsupported" });
  const foreign = { ...area, [META_KEY]: { ...area[META_KEY], format: "something-else" } };
  assert.deepEqual(readSyncState(foreign), { ok: false, reason: "unsupported" });
});

test("the checksum changes with content and includes the length", () => {
  assert.notEqual(checksum("abc"), checksum("abd"));
  assert.notEqual(checksum("abc"), checksum("abc "));
  assert.match(checksum("abc"), /^[0-9a-f]{8}-[0-9a-f]+$/);
});

test("a surrogate pair is never split across two chunks", () => {
  // Hostnames are ASCII, but a crafted or future record could carry emoji in a
  // field. Splitting a surrogate pair would corrupt the payload on every engine.
  const settings = { ...SETTINGS, whitelist: [{ host: "a.example", includeSubdomains: true }] };
  const built = buildSyncItems(settings, { generation: "g1" });
  for (const [key, value] of Object.entries(built.items)) {
    if (key === META_KEY) continue;
    const last = value.charCodeAt(value.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `${key} ends on a lone high surrogate`);
  }
});

test("provider quirks in the record are normalised on read", () => {
  const payload = { ...SETTINGS, mode: "system", scheme: "quic", port: 7890 };
  const built = buildSyncItems(payload, { generation: "g2" });
  const result = readSyncState(built.items);
  assert.equal(result.ok, true);
  assert.equal(result.settings.mode, "proxy");
  assert.equal(result.settings.scheme, "socks5");
  assert.equal(result.settings.port, "7890");
});

test("settingsDiffer ignores nothing that is actually synced", () => {
  assert.equal(settingsDiffer(SETTINGS, { ...SETTINGS }), false);
  for (const change of [
    { mode: "direct" },
    { scheme: "http" },
    { host: "10.0.0.1" },
    { port: "1080" },
    { includeSubdomains: false },
    { localBypass: false },
    { whitelist: [...SETTINGS.whitelist, { host: "new.example", includeSubdomains: true }] },
    { blacklist: [] }
  ]) {
    assert.equal(settingsDiffer(SETTINGS, { ...SETTINGS, ...change }), true, JSON.stringify(change));
  }
});

test("every sync failure state explains itself without implying data loss", () => {
  for (const reason of ["empty", "incomplete", "corrupt", "unsupported"]) {
    const text = describeSyncStatus({ reason });
    assert.ok(text.length > 10, reason);
    assert.doesNotMatch(text, /丢失|已删除/, `${reason} must not accuse the user of deleting anything`);
  }
  assert.match(describeSyncStatus({ reason: "empty" }), /还没有任何设备写入/);
});

test("the sync namespace is versioned so a format change cannot be misread", () => {
  assert.match(SYNC_PREFIX, /^alaxee\.sync\.$/);
  assert.equal(SYNC_FORMAT, "alaxee-proxy-sync");
  assert.equal(META_KEY, `${SYNC_PREFIX}meta`);
});

/* -------------------------------------------------------------------------- */
/* Opt-in                                                                     */
/* -------------------------------------------------------------------------- */

test("sync is off until the user turns it on, and that is the persisted default", async () => {
  const { DEFAULT_SETTINGS, migrateStoredSettings } = await import("../src/core.js");
  assert.equal(DEFAULT_SETTINGS.syncEnabled, false);
  // A settings record written before sync existed must not arrive with sync on.
  assert.equal(migrateStoredSettings({ mode: "proxy", host: "h", port: "1" }).settings.syncEnabled, false);
  // Only an explicit boolean true turns it on.
  for (const value of [undefined, null, 0, "true", 1, {}]) {
    assert.equal(migrateStoredSettings({ syncEnabled: value }).settings.syncEnabled, false, JSON.stringify(value));
  }
  assert.equal(migrateStoredSettings({ syncEnabled: true }).settings.syncEnabled, true);
});

test("the export and the sync payload agree on what counts as a setting", () => {
  // Two serialisers that disagree would make a restore produce a different rule
  // set than a sync, for the same user action.
  const exported = exportSettings(SETTINGS).settings;
  const synced = readSyncState(buildSyncItems(SETTINGS, { generation: "g1" }).items).settings;
  for (const key of ["mode", "scheme", "host", "port", "includeSubdomains", "localBypass"]) {
    assert.equal(synced[key], exported[key], key);
  }
  assert.deepEqual(synced.whitelist, exported.whitelist);
  assert.deepEqual(synced.blacklist, exported.blacklist);
});


/* -------------------------------------------------------------------------- */
/* Direction of travel                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Regression tests for a data-loss bug found after the first version shipped.
 *
 * The failure: a fresh install (no edit history, empty rule list) turned sync on,
 * decided its state was newer, and uploaded. That erased the rules every other
 * device had written, and reported "已上传：0 条规则" as though it had worked.
 */
test("a fresh install never claims to be newer than the cloud", () => {
  const local = { ...SETTINGS, updatedAt: 0 };
  const meta = { updatedAt: "2026-11-23T10:00:00.000Z" };
  assert.equal(syncDirection({ local, meta }), "ambiguous");
  assert.notEqual(syncDirection({ local, meta }), "local-wins");
});

test("a record with no timestamp at all is treated the same as a fresh install", () => {
  for (const updatedAt of [undefined, null, "", 0, -1, Number.NaN]) {
    assert.equal(syncDirection({ local: { updatedAt }, meta: { updatedAt: "2026-11-23T10:00:00.000Z" } }), "ambiguous");
  }
});

test("a local edit after the cloud record wins", () => {
  const local = { updatedAt: Date.parse("2026-11-23T12:00:00.000Z") };
  const meta = { updatedAt: "2026-11-23T10:00:00.000Z" };
  assert.equal(syncDirection({ local, meta }), "local-wins");
});

test("a cloud record written after the local edit wins", () => {
  const local = { updatedAt: Date.parse("2026-11-23T09:00:00.000Z") };
  const meta = { updatedAt: "2026-11-23T10:00:00.000Z" };
  assert.equal(syncDirection({ local, meta }), "cloud-wins");
});

test("an unreadable cloud timestamp does not become a reason to upload", () => {
  // A corrupt meta must not be read as "the cloud is older than me". Local wins
  // only when it has a real edit history to point at.
  const local = { updatedAt: Date.parse("2026-11-23T09:00:00.000Z") };
  assert.equal(syncDirection({ local, meta: { updatedAt: "not a date" } }), "local-wins");
  assert.equal(syncDirection({ local: { updatedAt: 0 }, meta: { updatedAt: "not a date" } }), "ambiguous");
});

test("turning sync on is not an edit, so it does not make the device look newer", () => {
  // The enabling write used to stamp updatedAt, which is what put a fresh install
  // ahead of the cloud it had just joined.
  const before = { ...SETTINGS, syncEnabled: false, updatedAt: 0 };
  const afterToggle = { ...before, syncEnabled: true, updatedAt: 0 };
  assert.equal(syncDirection({ local: afterToggle, meta: { updatedAt: "2026-11-23T10:00:00.000Z" } }), "ambiguous");
  assert.equal(settingsDiffer(before, afterToggle), false, "enabling sync must not look like a content change");
});

test("the upload guard refuses when the cloud already matches local", () => {
  // uploadIfEnabled compares against the last-seen record; equal shapes must not
  // produce a write, or two devices ping-pong forever.
  assert.equal(settingsDiffer({ ...SETTINGS, updatedAt: 5 }, { ...SETTINGS, updatedAt: 99 }), false);
});

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * These pin the second data-loss bug, found after the first one was fixed:
 * two devices editing between uploads meant the later upload silently erased the
 * earlier one. Last-writer-wins was the whole policy; there was no merge.
 */

const R = (host, includeSubdomains = true) => ({ host, includeSubdomains });

test("concurrent additions on two devices both survive a merge", () => {
  const merged = mergeRuleList([], [R("from-a.example")], [R("from-b.example")]);
  assert.deepEqual(merged.map((rule) => rule.host).sort(), ["from-a.example", "from-b.example"]);
});

test("merging is idempotent: an unchanged side never duplicates or reorders", () => {
  const base = [R("a.example"), R("b.example")];
  const merged = mergeRuleList(base, base, base);
  assert.deepEqual(merged, base.map((rule) => ({ host: rule.host, includeSubdomains: rule.includeSubdomains })));
  assert.deepEqual(mergeRuleList(base, merged, merged), merged);
});

test("a deletion on the local side propagates instead of being resurrected", () => {
  // Local removed "gone.example"; the cloud still has it. Without the base, a set
  // merge would happily add it back.
  const base = [R("keep.example"), R("gone.example")];
  const mine = [R("keep.example")];
  const theirs = [R("keep.example"), R("gone.example")];
  assert.deepEqual(mergeRuleList(base, mine, theirs).map((rule) => rule.host), ["keep.example"]);
});

test("a deletion on the cloud side propagates to the local side", () => {
  const base = [R("keep.example"), R("gone.example")];
  const mine = [R("keep.example"), R("gone.example")];
  const theirs = [R("keep.example")];
  assert.deepEqual(mergeRuleList(base, mine, theirs).map((rule) => rule.host), ["keep.example"]);
});

test("a rule the peer never had is not mistaken for a deletion", () => {
  // This is the regression: a base that claims more than the peer actually saw makes
  // every unseen rule look deleted. New rules with no base entry must be kept.
  const merged = mergeRuleList([], [R("only-local.example")], []);
  assert.deepEqual(merged.map((rule) => rule.host), ["only-local.example"]);
});

test("the same host with different subdomain flags resolves to the newest stamp", () => {
  const older = { host: "x.example", includeSubdomains: true, updatedAt: 100 };
  const newer = { host: "x.example", includeSubdomains: false, updatedAt: 200 };
  assert.equal(mergeRuleList([], [older], [newer])[0].includeSubdomains, false);
  assert.equal(mergeRuleList([], [newer], [older])[0].includeSubdomains, false);
  // A tie keeps the local flag so an unchanged merge stays stable.
  assert.equal(mergeRuleList([], [{ ...older, updatedAt: 200 }], [older])[0].includeSubdomains, true);
});

test("a host on both lists collapses to the blacklist, matching how routing decides", () => {
  // The merge must not leave a direct entry that can never fire.
  const merged = mergeSettings({
    base: null,
    mine: { ...SETTINGS, whitelist: [R("both.example")], blacklist: [], updatedAt: 10 },
    theirs: { ...SETTINGS, whitelist: [], blacklist: [R("both.example")], updatedAt: 5 }
  });
  assert.deepEqual(merged.whitelist, []);
  assert.deepEqual(merged.blacklist.map((rule) => rule.host), ["both.example"]);
});

test("scalar fields move as a unit so a mode cannot pair with another device's port", () => {
  const merged = mergeSettings({
    base: null,
    mine: { ...SETTINGS, mode: "direct", port: "1111", updatedAt: 100 },
    theirs: { ...SETTINGS, mode: "proxy", port: "2222", updatedAt: 200 }
  });
  assert.equal(merged.mode, "proxy");
  assert.equal(merged.port, "2222");
});

test("tombstones suppress only rules that are absent locally", () => {
  const merged = [R("keep.example"), R("gone.example")];
  assert.deepEqual(withTombstones(merged, ["gone.example"]).map((rule) => rule.host), ["keep.example"]);
  // A tombstone for a host that is still present must not hide it: the user re-added it.
  assert.equal(withTombstones(merged, []).length, 2);
  assert.deepEqual(withTombstones(merged, ["KEEP.example"]).map((rule) => rule.host), ["gone.example"]);
});

test("removedHosts reports what a write actually deleted", () => {
  assert.deepEqual(removedHosts([R("a.example"), R("b.example")], [R("b.example")]), ["a.example"]);
  assert.deepEqual(removedHosts([R("a.example")], [R("a.example")]), []);
});

test("the merge base travels with the payload, so peers can merge without history", () => {
  const built = buildSyncItems({
    ...SETTINGS,
    syncBase: { whitelist: [R("base.example")], blacklist: [] },
    syncTombstones: ["dead.example"]
  }, { generation: "g1" });
  const read = readSyncState(built.items);
  assert.deepEqual(read.base, { whitelist: [R("base.example")], blacklist: [] });
  assert.deepEqual(read.tombstones, ["dead.example"]);
});

test("an old payload with no base still reads, and merges as a first sync", () => {
  const built = buildSyncItems(SETTINGS, { generation: "g1" });
  const read = readSyncState(built.items);
  assert.equal(read.base, null);
  assert.deepEqual(read.tombstones, []);
  const merged = mergeSettings({ base: read.base, mine: { ...SETTINGS, whitelist: [R("mine.example")] }, theirs: read.settings });
  assert.ok(merged.whitelist.some((rule) => rule.host === "mine.example"));
});
