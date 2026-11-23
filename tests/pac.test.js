/**
 * Behavioural tests for the generated PAC script.
 *
 * These tests execute FindProxyForURL instead of pattern-matching its source.
 * The previous suite only asserted that certain lines existed in the generated
 * string, which is why the IPv6 mismatch could ship: the PAC compared against
 * "[::1]" while Chromium passes "::1", and no test ever called the function.
 *
 * Chromium's contract for the arguments: the host portion is passed unbracketed
 * for IPv6 literals, and the URL is sanitized. See net/docs/proxy.md in Chromium.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPacScript, buildChromeProxyConfig } from "../src/core.js";

const BASE = {
  mode: "clash",
  host: "127.0.0.1",
  port: "7890",
  scheme: "socks5",
  whitelist: [],
  blacklist: []
};

/** Loads a generated PAC script and returns its FindProxyForURL function. */
function loadPac(settings) {
  const source = buildPacScript(settings);
  const factory = new Function(`${source}\nreturn FindProxyForURL;`);
  return factory();
}

const PROXY = "SOCKS5 127.0.0.1:7890";

test("generated PAC exposes a callable FindProxyForURL", () => {
  const find = loadPac({ ...BASE });
  assert.equal(typeof find, "function");
});

test("default route follows the selected global mode", () => {
  assert.equal(loadPac({ ...BASE })("https://example.com/", "example.com"), PROXY);
  assert.equal(loadPac({ ...BASE, mode: "direct" })("https://example.com/", "example.com"), "DIRECT");
});

test("Clash mode sends whitelisted hosts direct and everything else to the listener", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "direct.example", includeSubdomains: true }]
  });
  assert.equal(find("https://direct.example/", "direct.example"), "DIRECT");
  assert.equal(find("https://sub.direct.example/", "sub.direct.example"), "DIRECT");
  assert.equal(find("https://other.example/", "other.example"), PROXY);
});

test("global direct mode forces only blacklisted hosts through the listener", () => {
  const find = loadPac({
    ...BASE,
    mode: "direct",
    blacklist: [{ host: "force.example", includeSubdomains: true }]
  });
  assert.equal(find("https://force.example/", "force.example"), PROXY);
  assert.equal(find("https://sub.force.example/", "sub.force.example"), PROXY);
  assert.equal(find("https://normal.example/", "normal.example"), "DIRECT");
});

test("blacklist wins over a broader whitelist inside the PAC itself", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: true }],
    blacklist: [{ host: "api.example.com", includeSubdomains: false }]
  });
  assert.equal(find("https://www.example.com/", "www.example.com"), "DIRECT");
  assert.equal(find("https://api.example.com/", "api.example.com"), PROXY);
});

test("subdomain matching respects DNS label boundaries", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: true }]
  });
  assert.equal(find("https://example.com/", "example.com"), "DIRECT");
  assert.equal(find("https://a.example.com/", "a.example.com"), "DIRECT");
  assert.equal(find("https://notexample.com/", "notexample.com"), PROXY);
  assert.equal(find("https://example.com.evil.test/", "example.com.evil.test"), PROXY);
});

test("exact-host-only rules do not cover subdomains", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "example.com", includeSubdomains: false }]
  });
  assert.equal(find("https://example.com/", "example.com"), "DIRECT");
  assert.equal(find("https://a.example.com/", "a.example.com"), PROXY);
});

/**
 * IPv6 literals are stored bracketed (that is the canonical URL host form) but
 * Chromium hands FindProxyForURL the unbracketed host. A rule that only matches
 * the bracketed form never fires, so the UI would report DIRECT while traffic
 * actually went to the listener.
 */
test("IPv6 whitelist entries match the unbracketed host Chromium actually passes", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "[::1]", includeSubdomains: true }]
  });
  assert.equal(find("http://[::1]/", "::1"), "DIRECT", "unbracketed IPv6 host must hit the whitelist");
  assert.equal(find("http://[::1]/", "[::1]"), "DIRECT", "bracketed form must also still match");
});

test("IPv6 blacklist entries force the listener in global direct mode", () => {
  const find = loadPac({
    ...BASE,
    mode: "direct",
    blacklist: [{ host: "[::1]", includeSubdomains: true }]
  });
  assert.equal(find("http://[::1]/", "::1"), PROXY);
});

test("IPv4 entries match", () => {
  const find = loadPac({
    ...BASE,
    whitelist: [{ host: "127.0.0.1", includeSubdomains: true }]
  });
  assert.equal(find("http://127.0.0.1/", "127.0.0.1"), "DIRECT");
});

test("HTTP scheme produces a PROXY directive and SOCKS5 produces SOCKS5", () => {
  const http = loadPac({ ...BASE, scheme: "http" });
  assert.equal(http("https://example.com/", "example.com"), "PROXY 127.0.0.1:7890");
  const socks = loadPac({ ...BASE, scheme: "socks5" });
  assert.equal(socks("https://example.com/", "example.com"), "SOCKS5 127.0.0.1:7890");
});

test("host input is normalised defensively inside the PAC", () => {
  const find = loadPac({ ...BASE, whitelist: [{ host: "example.com", includeSubdomains: true }] });
  assert.equal(find("https://example.com/", "EXAMPLE.COM."), "DIRECT");
});

/**
 * A PAC script runs inside the browser's proxy resolver for every request, so a
 * malformed entry must never be able to escape into executable source.
 */
test("hostile hostnames never become executable PAC source", () => {
  const settings = {
    ...BASE,
    whitelist: [
      { host: "example.com", includeSubdomains: true },
      { host: 'x"; throw new Error("injected"); //', includeSubdomains: true }
    ]
  };
  const source = buildPacScript(settings);
  assert.doesNotMatch(source, /throw new Error\("injected"\)/);
  assert.doesNotThrow(() => loadPac(settings));
});

test("the PAC is not rebuilt with rule arrays inside the per-request function body", () => {
  const source = buildPacScript({ ...BASE, whitelist: [{ host: "a.example", includeSubdomains: true }] });
  const body = source.slice(source.indexOf("function FindProxyForURL"));
  assert.doesNotMatch(body, /var allowRules = \[/, "rule arrays should not be re-created on every call");
});

test("config object embeds a mandatory PAC script in rule-bearing modes", () => {
  const config = buildChromeProxyConfig({ ...BASE, whitelist: [{ host: "a.example", includeSubdomains: true }] });
  assert.equal(config.mode, "pac_script");
  assert.equal(config.pacScript.mandatory, true);
});
