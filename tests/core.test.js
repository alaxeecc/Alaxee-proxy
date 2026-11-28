import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMON_PROXY_PORTS,
  DEFAULT_SETTINGS,
  ENDPOINT_TROUBLESHOOTING,
  MODES,
  createDomainEntry,
  describeProxyEndpoint,
  buildChromeProxyConfig,
  buildPacScript,
  getPageHostname,
  inferActiveMode,
  isHostBlacklisted,
  isLocalHost,
  isHostWhitelisted,
  normalizeBlacklist,
  normalizeHostname,
  migrateStoredSettings,
  normalizeWhitelist,
  parseProxyAddress,
  readPacFingerprint,
  reconcileRuleLists,
  requiresProxyEndpoint,
  iconStateFor,
  resolveDomainRoute,
  resolveGlobalRoute,
  resolveTabRoute,
  validateProxySettings
} from "../src/core.js";

const BASE = {
  mode: "proxy",
  host: "127.0.0.1",
  port: "7890",
  scheme: "http",
  whitelist: [],
  blacklist: []
};

function stateFor(settings) {
  return {
    levelOfControl: "controlled_by_this_extension",
    value: buildChromeProxyConfig(settings)
  };
}

test("new installations prefer SOCKS5 while saved settings can still select HTTP", () => {
  assert.equal(DEFAULT_SETTINGS.scheme, "socks5");
  assert.deepEqual(validateProxySettings({ host: "127.0.0.1", port: "7890", scheme: "http" }), {
    host: "127.0.0.1", port: 7890, scheme: "http"
  });
});

test("normalizes domain names, IDNs and trailing dots", () => {
  assert.equal(normalizeHostname(" Example.COM. "), "example.com");
  assert.equal(normalizeHostname("例子.测试"), "xn--fsqu00a.xn--0zwm56d");
  assert.equal(normalizeHostname("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeHostname("[::1]"), "[::1]");
});

test("rejects malformed hostnames, URL paths, wildcards and PAC injection characters", () => {
  for (const value of [
    "https://example.com/path",
    "*.example.com",
    "example.com;alert(1)",
    "bad_domain.example",
    "-bad.example",
    "bad-.example",
    "example.com\\nreturn DIRECT"
  ]) {
    assert.throws(() => normalizeHostname(value), undefined, value);
  }
});

test("validates proxy protocol and port range", () => {
  assert.deepEqual(validateProxySettings({ host: "127.0.0.1", port: "7890", scheme: "http" }), {
    host: "127.0.0.1", port: 7890, scheme: "http"
  });
  assert.deepEqual(validateProxySettings({ host: "localhost", port: "1080", scheme: "socks5" }), {
    host: "localhost", port: 1080, scheme: "socks5"
  });
  assert.throws(() => validateProxySettings({ host: "127.0.0.1", port: "0", scheme: "http" }));
  assert.throws(() => validateProxySettings({ host: "127.0.0.1", port: "65536", scheme: "http" }));
  assert.throws(() => validateProxySettings({ host: "127.0.0.1", port: "7890", scheme: "https" }));
});

test("normalizes whitelist and blacklist separately, caps entries and deduplicates", () => {
  const entries = [
    { host: "EXAMPLE.com", includeSubdomains: true },
    { host: "example.com", includeSubdomains: false },
    { host: "bad_domain.example", includeSubdomains: true }
  ];
  assert.deepEqual(normalizeWhitelist(entries), [{ host: "example.com", includeSubdomains: false }]);
  assert.deepEqual(normalizeBlacklist(entries), [{ host: "example.com", includeSubdomains: false }]);
  assert.equal(normalizeWhitelist(Array.from({ length: 600 }, (_, i) => ({ host: `host${i}.example` }))).length, 500);
});

test("matches apex and subdomains only on DNS label boundaries", () => {
  const whitelist = [createDomainEntry("example.com", true)];
  assert.equal(isHostWhitelisted("example.com", whitelist), true);
  assert.equal(isHostWhitelisted("a.example.com", whitelist), true);
  assert.equal(isHostWhitelisted("notexample.com", whitelist), false);
  assert.equal(isHostWhitelisted("example.com.evil.test", whitelist), false);
  assert.equal(isHostWhitelisted("a.example.com", [createDomainEntry("example.com", false)]), false);
  assert.equal(isHostBlacklisted("a.example.com", [createDomainEntry("example.com", true)]), true);
});

test("direct mode without force-proxy exceptions uses the native browser mode", () => {
  assert.deepEqual(buildChromeProxyConfig({ ...BASE, mode: "direct" }), { mode: "direct" });
});

test("a removed system mode is rejected instead of silently applied", () => {
  // "system" made both domain lists inert while leaving them visible in the UI.
  // It must fail loudly rather than fall through to some default.
  assert.throws(() => buildChromeProxyConfig({ ...BASE, mode: "system" }), /未知的代理模式/);
  assert.throws(() => buildPacScript({ ...BASE, mode: "system" }), /未知的代理模式|只支持/);
});

test("proxy mode creates mandatory PAC rules with direct whitelist and force-proxy blacklist", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "direct.example", includeSubdomains: true }],
    blacklist: [{ host: "force.example", includeSubdomains: false }]
  };
  const config = buildChromeProxyConfig(settings);
  assert.equal(config.mode, "pac_script");
  assert.equal(config.pacScript.mandatory, true);
  // Behaviour is asserted by executing the PAC in tests/pac.test.js; here we only
  // check that the generated script carries both rule sets and the endpoint.
  const find = new Function(`${config.pacScript.data}\nreturn FindProxyForURL;`)();
  assert.equal(find("https://direct.example/", "direct.example"), "DIRECT");
  assert.equal(find("https://force.example/", "force.example"), "PROXY 127.0.0.1:7890");
  assert.equal(find("https://other.example/", "other.example"), "PROXY 127.0.0.1:7890");
});

test("global direct mode uses PAC only when blacklist exceptions exist", () => {
  const directOnly = buildChromeProxyConfig({ ...BASE, mode: "direct" });
  assert.deepEqual(directOnly, { mode: "direct" });

  const withBlacklist = buildChromeProxyConfig({
    ...BASE,
    mode: "direct",
    blacklist: [{ host: "force.example", includeSubdomains: true }]
  });
  assert.equal(withBlacklist.mode, "pac_script");
  const find = new Function(`${withBlacklist.pacScript.data}\nreturn FindProxyForURL;`)();
  assert.equal(find("https://force.example/", "force.example"), "PROXY 127.0.0.1:7890");
  assert.equal(find("https://normal.example/", "normal.example"), "DIRECT");
});

test("blacklist has priority over a broader whitelist when rules overlap", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: true }],
    blacklist: [{ host: "api.example.com", includeSubdomains: true }]
  };
  assert.equal(resolveDomainRoute("www.example.com", settings), "direct");
  assert.equal(resolveDomainRoute("example.com", settings), "direct");
  assert.equal(resolveDomainRoute("api.example.com", settings), "proxy");
  assert.equal(resolveDomainRoute("v2.api.example.com", settings), "proxy");
});

test("PAC route resolver reports the actual page route for all rule combinations", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "direct.example", includeSubdomains: true }],
    blacklist: [{ host: "force.example", includeSubdomains: true }]
  };
  const state = stateFor(settings);
  assert.equal(resolveTabRoute("https://www.direct.example/", state, settings), "direct");
  assert.equal(resolveTabRoute("https://other.example/", state, settings), "proxy");
  assert.equal(resolveTabRoute("https://force.example/", state, settings), "proxy");
  assert.equal(resolveTabRoute("https://sub.force.example/", state, settings), "proxy");
  assert.equal(resolveGlobalRoute(state, settings), "proxy");
});

test("global direct route marks only blacklisted domains as proxied", () => {
  const settings = {
    ...BASE,
    mode: "direct",
    blacklist: [{ host: "force.example", includeSubdomains: true }]
  };
  const state = stateFor(settings);
  assert.equal(resolveTabRoute("https://normal.example/", state, settings), "direct");
  assert.equal(resolveTabRoute("https://force.example/", state, settings), "proxy");
  assert.equal(resolveGlobalRoute(state, settings), "direct");
});

test("a browser left on system proxy is reported as unknown, not as a mode", () => {
  // The extension no longer writes "system"; if the browser reports it, the value
  // came from elsewhere and the extension must not claim it as its own state.
  const settings = { ...BASE };
  const state = { levelOfControl: "controlled_by_this_extension", value: { mode: "system" } };
  assert.equal(inferActiveMode(state.value, settings), null);
  assert.equal(resolveTabRoute("https://example.com/", state, settings), "unknown");
});

test("does not report a route when another extension controls proxy settings", () => {
  const settings = { ...BASE };
  assert.equal(resolveTabRoute("https://example.com/", {
    levelOfControl: "controlled_by_other_extensions",
    value: buildChromeProxyConfig(settings)
  }, settings), "unknown");
  assert.equal(resolveTabRoute("https://example.com/", {
    levelOfControl: "not_controllable",
    value: buildChromeProxyConfig(settings)
  }, settings), "unknown");
});

test("does not infer a foreign PAC script as Alaxee-owned", () => {
  const settings = { ...BASE };
  assert.equal(inferActiveMode({ mode: "pac_script", pacScript: { data: "function FindProxyForURL(){return 'DIRECT'}" } }, settings), null);
});

test("keeps backward compatibility with the prior fixed-server config", () => {
  const saved = { ...BASE, whitelist: [{ host: "example.com", includeSubdomains: true }] };
  const legacy = {
    mode: "fixed_servers",
    rules: { singleProxy: { host: "127.0.0.1", port: 7890, scheme: "http" } }
  };
  assert.equal(inferActiveMode(legacy, saved), "proxy");
  assert.equal(resolveTabRoute("https://example.com/", {
    levelOfControl: "controlled_by_this_extension", value: legacy
  }, saved), "direct");
  assert.equal(resolveTabRoute("https://elsewhere.example/", {
    levelOfControl: "controlled_by_this_extension", value: legacy
  }, saved), "proxy");
});

test("PAC output contains only JSON-serialized validated domain records", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: true }]
  };
  const source = buildPacScript(settings);
  assert.match(source, /"host":"example\.com"/);
  assert.doesNotMatch(source, /alert\(/);
});

test("reads only HTTP and HTTPS page hostnames", () => {
  assert.equal(getPageHostname("https://www.example.com/a?b=1"), "www.example.com");
  assert.equal(getPageHostname("edge://extensions"), null);
  assert.equal(getPageHostname("file:///C:/test.html"), null);
});

/* -------------------------------------------------------------------------- */
/* Standalone model: no proxy product is assumed                              */
/* -------------------------------------------------------------------------- */

test("a fresh install ships no endpoint instead of guessing a proxy port", () => {
  // Assuming 127.0.0.1:7890 means a first-time user's traffic is pointed at a
  // port that may belong to nothing at all - or to something else.
  assert.equal(DEFAULT_SETTINGS.host, "");
  assert.equal(DEFAULT_SETTINGS.port, "");
  assert.equal(DEFAULT_SETTINGS.mode, "proxy");
});

test("an endpoint is required, and blank input is rejected with a usable message", () => {
  assert.throws(() => validateProxySettings({ host: "", port: "7890", scheme: "socks5" }), /代理服务器地址/);
  assert.throws(() => validateProxySettings({ host: "127.0.0.1", port: "", scheme: "socks5" }), /端口/);
  assert.throws(() => validateProxySettings({ host: "   ", port: "7890" }), /代理服务器地址/);
});

test("only proxy mode or a non-empty force-proxy list needs a reachable endpoint", () => {
  assert.equal(requiresProxyEndpoint({ ...BASE, mode: "proxy" }), true);
  assert.equal(requiresProxyEndpoint({ ...BASE, mode: "direct" }), false);
  assert.equal(requiresProxyEndpoint({
    ...BASE, mode: "direct", blacklist: [{ host: "force.example", includeSubdomains: true }]
  }), true);
});

test("legacy mode names are migrated once and reported to the caller", () => {
  const fromClash = migrateStoredSettings({ mode: "clash", host: "127.0.0.1", port: "7890" });
  assert.equal(fromClash.settings.mode, "proxy");
  assert.equal(fromClash.changed, true);
  assert.equal(fromClash.legacyMode, "clash");

  const fromSystem = migrateStoredSettings({ mode: "system", host: "", port: "" });
  assert.equal(fromSystem.settings.mode, "direct");
  assert.equal(fromSystem.legacyMode, "system");
});

test("migration is idempotent so the popup does not rewrite storage on every open", () => {
  const once = migrateStoredSettings({ mode: "clash", host: "127.0.0.1", port: "7890", whitelist: [], blacklist: [] });
  const twice = migrateStoredSettings(once.settings);
  assert.equal(twice.changed, false);
  assert.equal(twice.legacyMode, null);
  assert.deepEqual(twice.settings, once.settings);
});

test("migration never throws on a settings record it does not understand", () => {
  for (const raw of [undefined, null, {}, { mode: "nonsense" }, { mode: 7 }, { host: 12, whitelist: "x" }]) {
    const { settings } = migrateStoredSettings(raw);
    assert.ok(MODES.includes(settings.mode), `mode should fall back, got ${settings.mode}`);
    assert.ok(Array.isArray(settings.whitelist));
  }
});

test("the endpoint line describes an address instead of naming a proxy product", () => {
  assert.equal(describeProxyEndpoint({ ...BASE }), "浏览器代理 → http://127.0.0.1:7890");
  assert.match(describeProxyEndpoint({ ...BASE, host: "", port: "" }), /尚未填写/);
});

test("a PAC written by 0.1.x is not claimed as ours after the format change", () => {
  // V2 scripts routed localhost through the proxy. Trusting them would leave the
  // local-address fix silently unapplied on upgrade.
  const v2 = '/* ALAXEE_PROXY_RULES_V2 fp:deadbeef */\nfunction FindProxyForURL(){return "DIRECT"}';
  assert.equal(readPacFingerprint(v2), null);
});

/* -------------------------------------------------------------------------- */
/* Finding the endpoint                                                       */
/* -------------------------------------------------------------------------- */

test("every shape of pasted proxy address is recognised", () => {
  const cases = [
    ["127.0.0.1:7890", { host: "127.0.0.1", port: "7890", scheme: "socks5", credentials: false }],
    ["socks5://127.0.0.1:7890", { host: "127.0.0.1", port: "7890", scheme: "socks5", credentials: false }],
    ["socks5h://127.0.0.1:7890", { host: "127.0.0.1", port: "7890", scheme: "socks5", credentials: false }],
    ["http://127.0.0.1:7897/", { host: "127.0.0.1", port: "7897", scheme: "http", credentials: false }],
    ["https://proxy.example:8443", { host: "proxy.example", port: "8443", scheme: "http", credentials: false }],
    ["[::1]:7890", { host: "::1", port: "7890", scheme: "socks5", credentials: false }],
    ["  http://10.0.0.2:3128  ", { host: "10.0.0.2", port: "3128", scheme: "http", credentials: false }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseProxyAddress(input), expected, input);
  }
});

test("a pasted address with credentials is parsed but flagged, not silently accepted", () => {
  // A PAC script cannot carry a username and password. Reporting the limitation is
  // the difference between "connection failed for a reason you can act on" and
  // "connection failed".
  const parsed = parseProxyAddress("socks5://user:pass@10.0.0.2:1080");
  assert.equal(parsed.host, "10.0.0.2");
  assert.equal(parsed.port, "1080");
  assert.equal(parsed.credentials, true);
});

test("text that carries no address is rejected instead of half-parsed", () => {
  for (const input of ["", "   ", "localhost", "7890", "socks5:7890", "not a url", "http://"]) {
    assert.equal(parseProxyAddress(input), null, input);
  }
});

test("common ports are offered as hints and always validated before use", () => {
  assert.ok(COMMON_PROXY_PORTS.length >= 5);
  for (const { port, hint } of COMMON_PROXY_PORTS) {
    // Every suggestion must itself be a legal endpoint, or the chip would fill in
    // a value the save button then rejects.
    assert.doesNotThrow(() => validateProxySettings({ host: "127.0.0.1", port, scheme: "socks5" }), port);
    assert.ok(hint.length > 0);
  }
  // The control panel port must never be suggested: Clash's 9090 is the REST API,
  // and pointing the browser at it does not forward any traffic.
  assert.equal(COMMON_PROXY_PORTS.some(({ port }) => port === "9090"), false);
});

test("troubleshooting text names the control-panel-port mistake, the most common cause", () => {
  assert.match(ENDPOINT_TROUBLESHOOTING.join(" "), /9090/);
  assert.ok(ENDPOINT_TROUBLESHOOTING.length >= 3);
});

/* -------------------------------------------------------------------------- */
/* One host, one list                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The invariant: a host never appears on both lists.
 *
 * Routing already resolves the overlap in favour of the blacklist, so this is not a
 * behaviour bug - it is a comprehension bug. The rule list shows the same domain
 * twice with opposite labels and no indication that one of them never fires.
 *
 * Three separate paths can create the overlap (typing a rule, importing a file,
 * merging a synced record) which is why the fix belongs in core, not in the handler
 * that happened to be written first.
 */
test("a host on the force-proxy list is removed from the direct list", () => {
  const { whitelist, blacklist } = reconcileRuleLists({
    whitelist: [
      { host: "dup.example", includeSubdomains: true },
      { host: "keep.example", includeSubdomains: true }
    ],
    blacklist: [{ host: "dup.example", includeSubdomains: false }]
  });
  assert.deepEqual(whitelist.map((entry) => entry.host), ["keep.example"]);
  assert.deepEqual(blacklist.map((entry) => entry.host), ["dup.example"]);
});

test("host matching is case- and dot-insensitive when collapsing", () => {
  const { whitelist, blacklist } = reconcileRuleLists({
    whitelist: [{ host: "dup.example", includeSubdomains: true }],
    blacklist: [{ host: "DUP.example.", includeSubdomains: true }]
  });
  assert.equal(whitelist.length, 0);
  assert.equal(blacklist.length, 1);
});

test("a parent and a child on opposite lists are both kept", () => {
  // *.example.com direct with api.example.com forced through the proxy is a
  // deliberate, supported configuration - only the same host is a duplicate.
  const { whitelist, blacklist } = reconcileRuleLists({
    whitelist: [{ host: "example.com", includeSubdomains: true }],
    blacklist: [{ host: "api.example.com", includeSubdomains: true }]
  });
  assert.equal(whitelist.length, 1);
  assert.equal(blacklist.length, 1);
});

test("reconciling an already-clean pair changes nothing", () => {
  const input = {
    whitelist: [{ host: "a.example", includeSubdomains: true }],
    blacklist: [{ host: "b.example", includeSubdomains: false }]
  };
  assert.deepEqual(reconcileRuleLists(input), input);
});

test("a blacklisted page gets its own icon state, other routes do not", () => {
  // The toolbar has four artwork states but only three routes. "forced" exists so the
  // user can tell "I put this site on the blacklist" from "everything is proxied",
  // without adding a route the PAC generator would have to understand.
  const settings = { blacklist: [{ host: "forced.example", includeSubdomains: true }] };
  assert.equal(iconStateFor("proxy", "forced.example", settings), "forced");
  assert.equal(iconStateFor("proxy", "deep.forced.example", settings), "forced");
  assert.equal(iconStateFor("proxy", "other.example", settings), "proxy");
  assert.equal(iconStateFor("direct", "forced.example", settings), "direct");
  assert.equal(iconStateFor("unknown", "forced.example", settings), "unknown");
});

test("icon state falls back to the route when there is no host or no settings", () => {
  // A tab without a usable URL (browser pages, chrome://) resolves to unknown, and a
  // missing settings object must not throw inside the service worker's refresh loop.
  assert.equal(iconStateFor("proxy", "", { blacklist: [{ host: "a.example" }] }), "proxy");
  assert.equal(iconStateFor("proxy", null, { blacklist: [] }), "proxy");
  assert.equal(iconStateFor("unknown", "a.example", undefined), "unknown");
  assert.equal(iconStateFor("proxy", "a.example", undefined), "proxy");
});
