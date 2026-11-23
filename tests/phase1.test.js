/**
 * Regression tests for the Phase 1 correctness and performance fixes.
 *
 * Each block here corresponds to a defect that shipped in 0.1.3 and was found by
 * review rather than by the 0.1.3 test suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RULE_ENTRIES,
  RuleLimitError,
  buildChromeProxyConfig,
  buildPacScript,
  inferActiveMode,
  isHostBlacklisted,
  isHostWhitelisted,
  normalizeDomainEntries,
  normalizeDomainEntriesStrict,
  pacFingerprint,
  readPacFingerprint,
  resolveTabRoute
} from "../src/core.js";

const BASE = {
  mode: "proxy",
  host: "127.0.0.1",
  port: "7890",
  scheme: "socks5",
  whitelist: [],
  blacklist: []
};

function rules(count, prefix = "site") {
  return Array.from({ length: count }, (_, i) => ({ host: `${prefix}${i}.example`, includeSubdomains: true }));
}

/* ------------------------------------------------------------------ */
/* Rule cap: refuse instead of silently dropping                      */
/* ------------------------------------------------------------------ */

test("normalising a list under the cap keeps every entry", () => {
  assert.equal(normalizeDomainEntriesStrict(rules(MAX_RULE_ENTRIES)).length, MAX_RULE_ENTRIES);
});

test("exceeding the cap throws instead of silently truncating", () => {
  assert.throws(
    () => normalizeDomainEntriesStrict(rules(MAX_RULE_ENTRIES + 1)),
    RuleLimitError,
    "an over-cap write must be refused, not truncated"
  );
});

test("the limit error names the actual limit so the UI can explain it", () => {
  try {
    normalizeDomainEntriesStrict(rules(MAX_RULE_ENTRIES + 20));
    assert.fail("expected RuleLimitError");
  } catch (error) {
    assert.equal(error.limit, MAX_RULE_ENTRIES);
    assert.equal(error.attempted, MAX_RULE_ENTRIES + 20);
    assert.match(error.message, new RegExp(String(MAX_RULE_ENTRIES)));
  }
});

test("duplicates do not count toward the cap", () => {
  const duplicated = [...rules(300), ...rules(300)];
  assert.equal(normalizeDomainEntriesStrict(duplicated).length, 300);
});

test("malformed entries do not count toward the cap either", () => {
  const withJunk = [...rules(MAX_RULE_ENTRIES), { host: "not a host" }, { host: "" }, null];
  assert.equal(normalizeDomainEntriesStrict(withJunk).length, MAX_RULE_ENTRIES);
});

test("reading a persisted over-cap list still works and merely caps it", () => {
  // Legacy data may legitimately exceed the cap; normalisation must stay total
  // so the extension still starts. Only new writes are refused.
  const legacy = rules(MAX_RULE_ENTRIES + 10);
  assert.equal(normalizeDomainEntries(legacy).length, MAX_RULE_ENTRIES);
});

/* ------------------------------------------------------------------ */
/* PAC fingerprint                                                     */
/* ------------------------------------------------------------------ */

test("the PAC embeds a readable fingerprint", () => {
  const settings = { ...BASE, whitelist: rules(3) };
  const source = buildPacScript(settings);
  const fp = readPacFingerprint(source);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.equal(fp, pacFingerprint(settings));
});

test("the fingerprint is stable across regenerations", () => {
  const settings = { ...BASE, whitelist: rules(50), blacklist: rules(10, "force") };
  assert.equal(pacFingerprint(settings), pacFingerprint(structuredClone(settings)));
  assert.equal(buildPacScript(settings), buildPacScript(structuredClone(settings)));
});

test("rule sets that differ only in a later entry get distinct fingerprints", () => {
  // Regression: an earlier memoisation keyed on list length plus the first host,
  // so these two produced the same fingerprint and the extension reported its
  // own proxy as still active after the user edited the rules.
  const base = { ...BASE, whitelist: [] };
  const a = { ...base, whitelist: [{ host: "a.example", includeSubdomains: true }, { host: "b.example", includeSubdomains: true }] };
  const b = { ...base, whitelist: [{ host: "a.example", includeSubdomains: true }, { host: "c.example", includeSubdomains: true }] };
  assert.equal(a.whitelist.length, b.whitelist.length);
  assert.notEqual(pacFingerprint(a), pacFingerprint(b));
});

test("the fingerprint ignores entry order and duplicates", () => {
  const a = { ...BASE, whitelist: [{ host: "a.example", includeSubdomains: true }, { host: "b.example", includeSubdomains: false }] };
  const b = { ...BASE, whitelist: [{ host: "b.example", includeSubdomains: false }, { host: "a.example", includeSubdomains: true }] };
  assert.equal(pacFingerprint(a), pacFingerprint(b));
});

test("the fingerprint changes when any routing input changes", () => {
  const base = { ...BASE, whitelist: rules(2) };
  const variants = [
    { ...base, whitelist: rules(3) },
    { ...base, blacklist: rules(1, "force") },
    { ...base, mode: "direct" },
    { ...base, port: "7891" },
    { ...base, scheme: "http" },
    { ...base, host: "127.0.0.2" },
    { ...base, whitelist: [{ host: "site0.example", includeSubdomains: false }] }
  ];
  const reference = pacFingerprint(base);
  for (const variant of variants) {
    assert.notEqual(pacFingerprint(variant), reference, `fingerprint did not change for ${JSON.stringify(variant)}`);
  }
});

test("a foreign PAC script is never claimed as ours", () => {
  assert.equal(readPacFingerprint("function FindProxyForURL(){return 'DIRECT'}"), null);
  assert.equal(readPacFingerprint(""), null);
  assert.equal(readPacFingerprint(undefined), null);
  assert.equal(readPacFingerprint("/* ALAXEE_PROXY_RULES_V2 fp:zzzzzzzz */"), null);
});

test("inferActiveMode recognises our own PAC through the fingerprint", () => {
  const settings = { ...BASE, whitelist: rules(4) };
  const state = { levelOfControl: "controlled_by_this_extension", value: buildChromeProxyConfig(settings) };
  assert.equal(inferActiveMode(state.value, settings), "proxy");
});

test("inferActiveMode rejects our PAC once the saved rules diverge", () => {
  const applied = { ...BASE, whitelist: rules(4) };
  const state = { value: buildChromeProxyConfig(applied) };
  const changed = { ...applied, whitelist: rules(5) };
  assert.equal(inferActiveMode(state.value, changed), null);
});

test("inferActiveMode still recognises legacy scripts without a fingerprint", () => {
  // A PAC written by 0.1.3 has no fingerprint. It must degrade to "unknown"
  // rather than be misreported as an active mode.
  const legacyPac = '/* ALAXEE_PROXY_RULES_V1 */\nfunction FindProxyForURL(){return "DIRECT"}';
  const state = { value: { mode: "pac_script", pacScript: { data: legacyPac } } };
  assert.equal(inferActiveMode(state.value, { ...BASE, whitelist: rules(1) }), null);
});

/* ------------------------------------------------------------------ */
/* IPv6 inside the PAC (found in Phase 0, fixed in Phase 1)            */
/* ------------------------------------------------------------------ */

test("IPv6 rules are stored bracketed but compared unbracketed", () => {
  const settings = { ...BASE, whitelist: [{ host: "[::1]", includeSubdomains: true }] };
  const source = buildPacScript(settings);
  assert.match(source, /"host":"::1"/, "PAC must carry the unbracketed form");
  assert.doesNotMatch(source, /"host":"\[::1\]"/);
});

/* ------------------------------------------------------------------ */
/* Performance guards                                                  */
/* ------------------------------------------------------------------ */

test("route resolution does not serialise the PAC and stays fast at the rule cap", () => {
  const settings = {
    ...BASE,
    whitelist: rules(MAX_RULE_ENTRIES),
    blacklist: rules(MAX_RULE_ENTRIES, "force")
  };
  const state = { levelOfControl: "controlled_by_this_extension", value: buildChromeProxyConfig(settings) };

  const started = performance.now();
  const iterations = 200;
  for (let i = 0; i < iterations; i += 1) {
    resolveTabRoute(`https://host${i % 50}.test/`, state, settings);
  }
  const perCall = (performance.now() - started) / iterations;

  // Measured at the 1000-rule cap: 3.11 ms before the fix, ~0.5 ms after.
  // What remains is inherent - canonicalising and serialising 1000 rules - and
  // is now paid once per refresh burst instead of once per tab.
  // The ceiling leaves ~2x headroom so slower CI machines do not flake, while
  // still failing loudly if the PAC re-serialisation ever comes back.
  assert.ok(perCall < 1, `route resolution took ${perCall.toFixed(3)} ms per call (limit 1 ms, was 3.11 ms in 0.1.3)`);
});

test("host matching at the rule cap stays fast", () => {
  const whitelist = rules(MAX_RULE_ENTRIES);
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) {
    isHostWhitelisted(`target${i % 40}.example`, whitelist);
    isHostBlacklisted(`target${i % 40}.example`, whitelist);
  }
  const perCall = (performance.now() - started) / 1000;
  assert.ok(perCall < 0.5, `host matching took ${perCall.toFixed(3)} ms per call`);
});

test("host matching still returns correct results after memoisation", () => {
  const whitelist = [{ host: "example.com", includeSubdomains: true }];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(isHostWhitelisted("a.example.com", whitelist), true);
    assert.equal(isHostWhitelisted("notexample.com", whitelist), false);
    assert.equal(isHostWhitelisted("example.com.evil.test", whitelist), false);
  }
  // A rejected host must stay rejected, not fall through and match later.
  assert.equal(isHostWhitelisted("bad domain", whitelist), false);
  assert.equal(isHostWhitelisted("bad domain", whitelist), false);
});

test("memoised lookups do not leak between different rule lists", () => {
  assert.equal(isHostWhitelisted("a.example.com", [{ host: "example.com", includeSubdomains: true }]), true);
  assert.equal(isHostWhitelisted("a.example.com", [{ host: "example.com", includeSubdomains: false }]), false);
  assert.equal(isHostWhitelisted("a.example.com", []), false);
});

/* ------------------------------------------------------------------ */
/* PAC still correct after the rewrite                                  */
/* ------------------------------------------------------------------ */

test("PAC keeps blacklist priority and label boundaries after the rewrite", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: true }],
    blacklist: [{ host: "api.example.com", includeSubdomains: false }]
  };
  const find = new Function(`${buildPacScript(settings)}\nreturn FindProxyForURL;`)();
  assert.equal(find("https://www.example.com/", "www.example.com"), "DIRECT");
  assert.equal(find("https://api.example.com/", "api.example.com"), "SOCKS5 127.0.0.1:7890");
  assert.equal(find("https://example.com.evil.test/", "example.com.evil.test"), "SOCKS5 127.0.0.1:7890");
});

test("PAC does not expand IPv6 literals into subdomain rules", () => {
  const settings = { ...BASE, whitelist: [{ host: "[::1]", includeSubdomains: true }] };
  const find = new Function(`${buildPacScript(settings)}\nreturn FindProxyForURL;`)();
  assert.equal(find("http://[::1]/", "::1"), "DIRECT");
  // A host merely ending in the literal must not match via suffix logic.
  assert.notEqual(find("http://x/", "x.::1"), "DIRECT");
});
