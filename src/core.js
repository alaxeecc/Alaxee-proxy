/**
 * Pure proxy, rule and routing logic. No chrome.* APIs, no DOM, no storage.
 *
 * The extension is a browser proxy controller and nothing more: it points Edge
 * at one HTTP or SOCKS5 endpoint that the user supplies, and decides per domain
 * whether to use that endpoint or connect directly. It deliberately has no
 * concept of *which* proxy program is listening there - Clash, sing-box, an SSH
 * `-D` tunnel or a corporate HTTP proxy are indistinguishable to it, and adding
 * any product-specific knowledge is out of scope by design.
 */

/**
 * `mode` is the browser-wide default route:
 *   "proxy"  - send traffic to the configured endpoint unless a rule says otherwise
 *   "direct" - connect directly unless the force-proxy list says otherwise
 *
 * There used to be a third "system" mode that delegated to the Windows system
 * proxy. It was removed because it silently disabled both domain lists: the
 * user's rules stayed visible in the UI while doing nothing. A mode that cannot
 * honour the rules shown next to it is worse than not offering the mode.
 *
 * `host`/`port` are empty by default. The extension no longer assumes anyone runs
 * a proxy on 127.0.0.1:7890; guessing an endpoint is how a "proxy tool" ends up
 * sending a first-time user's traffic to a port that does not exist.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: "proxy",
  host: "",
  port: "",
  scheme: "socks5",
  includeSubdomains: true,
  // Loopback and local-link addresses always connect directly. See
  // isLocalHost() for why, and for the ranges this deliberately excludes.
  localBypass: true,
  // Opt-in. Nothing is written to chrome.storage.sync until this is true.
  syncEnabled: false,
  // Wall-clock time of the last local write, used to decide whether local or
  // synced settings are newer when the two disagree.
  updatedAt: 0,
  // The record this device last agreed with the sync area on, and the hosts it has
  // removed since. Both travel with the payload so peers can merge rather than
  // overwrite; neither affects routing.
  syncBase: null,
  syncTombstones: [],
  whitelist: [],
  blacklist: []
});

export const MODES = Object.freeze(["proxy", "direct"]);

/**
 * Mode names written by 0.1.x. "clash" was a product name masquerading as a
 * routing mode; "system" no longer exists. Stored settings are rewritten on load
 * so an upgrade never leaves the extension in an unknown state.
 */
const LEGACY_MODES = Object.freeze({ clash: "proxy", system: "direct" });

const VALID_SCHEMES = new Set(["http", "socks5"]);

export function normalizeHostname(value) {
  const host = String(value ?? "").trim().replace(/^\.+|\.+$/g, "").toLowerCase();
  if (!host || /[\s/@?#\\]/.test(host) || host.includes("*")) {
    throw new Error("请输入有效的主机名，不要填写协议、路径或通配符。");
  }

  let parsed;
  try {
    parsed = new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/`);
  } catch {
    throw new Error("主机名格式无效。");
  }

  const normalized = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const ipv6 = /^\[[0-9a-f:.]+\]$/i.test(normalized) && normalized.includes(":");
  const ipv4Parts = normalized.split(".");
  const ipv4 = ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const dnsLabels = normalized.split(".");
  const dns = normalized.length <= 253 && dnsLabels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
  if (!normalized || (!ipv6 && !ipv4 && !dns)) throw new Error("主机名格式无效。");
  return normalized;
}

export function validateProxySettings(settings) {
  if (!settings || typeof settings !== "object") throw new Error("代理设置无效。");

  const scheme = String(settings.scheme ?? "http").toLowerCase();
  if (!VALID_SCHEMES.has(scheme)) throw new Error("目前只支持 HTTP 和 SOCKS5 代理。");

  const rawHost = String(settings.host ?? "").trim();
  if (!rawHost) throw new Error("请先填写代理服务器地址，例如 127.0.0.1。");

  const host = normalizeHostname(rawHost);
  const portText = String(settings.port ?? "").trim();
  if (!portText) throw new Error("请先填写代理服务器端口。");
  if (!/^\d{1,5}$/.test(portText)) throw new Error("端口必须是 1 到 65535 之间的数字。");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1 到 65535 之间的数字。");
  }

  return { host, port, scheme };
}

/** True once both an address and a port have been supplied. */
export function isConfigured(settings) {
  try {
    validateProxySettings(settings);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this configuration needs a reachable endpoint to mean anything.
 *
 * "direct" with an empty force-proxy list is a pure browser setting, so an
 * unconfigured endpoint is fine there. Every other combination has to send
 * traffic somewhere and is therefore inert until an address is entered.
 */
export function requiresProxyEndpoint(settings) {
  if (!settings || typeof settings !== "object") return false;
  if (settings.mode === "proxy") return true;
  return normalizeDomainEntries(settings.blacklist).length > 0;
}

/**
 * Rewrites stored settings written by an older version.
 *
 * Returns the settings to persist plus whether anything changed, so callers can
 * write back once instead of on every read. Kept pure and total: an unrecognised
 * mode falls back to the default rather than throwing, because a settings record
 * from a future version must not make the extension unopenable.
 */
export function migrateStoredSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const storedMode = String(input.mode ?? "");
  const mode = MODES.includes(storedMode)
    ? storedMode
    : LEGACY_MODES[storedMode] ?? DEFAULT_SETTINGS.mode;

  const settings = {
    ...DEFAULT_SETTINGS,
    ...input,
    mode,
    host: String(input.host ?? "").trim(),
    port: String(input.port ?? "").trim(),
    scheme: VALID_SCHEMES.has(String(input.scheme ?? "")) ? String(input.scheme) : DEFAULT_SETTINGS.scheme,
    localBypass: input.localBypass !== false,
    syncEnabled: input.syncEnabled === true,
    updatedAt: Number(input.updatedAt) || 0,
    syncBase: input.syncBase && typeof input.syncBase === "object" ? input.syncBase : null,
    syncTombstones: Array.isArray(input.syncTombstones) ? input.syncTombstones.map(String) : [],
    whitelist: normalizeDomainEntries(input.whitelist),
    blacklist: normalizeDomainEntries(input.blacklist)
  };

  // Any raw value that normalisation actually rewrote is worth persisting once.
  const changed = mode !== storedMode ||
    settings.scheme !== input.scheme ||
    (input.localBypass !== undefined && input.localBypass !== settings.localBypass) ||
    settings.whitelist.length !== (Array.isArray(input.whitelist) ? input.whitelist.length : 0) ||
    settings.blacklist.length !== (Array.isArray(input.blacklist) ? input.blacklist.length : 0);

  return { settings, changed, legacyMode: mode !== storedMode ? storedMode : null };
}

export const MAX_RULE_ENTRIES = 500;

export function normalizeDomainEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const unique = new Map();
  for (const entry of entries.slice(0, MAX_RULE_ENTRIES)) {
    try {
      const host = normalizeHostnameCached(entry?.host);
      unique.set(host, { host, includeSubdomains: Boolean(entry?.includeSubdomains) });
    } catch {
      // Ignore malformed persisted entries instead of breaking proxy startup.
    }
  }
  return [...unique.values()];
}

/**
 * Thrown when a caller asks to store more rule entries than the cap allows.
 *
 * Silently truncating was the previous behaviour and it was the worst option:
 * the popup showed a green success notice while part of the list never reached
 * the browser. Every mutating entry point now refuses the write instead, so the
 * user learns about the limit before losing rules.
 */
export class RuleLimitError extends Error {
  constructor(limit, attempted) {
    super(`域名规则最多 ${limit} 条，本次操作后会达到 ${attempted} 条。请先删除部分规则再继续。`);
    this.name = "RuleLimitError";
    this.limit = limit;
    this.attempted = attempted;
  }
}

/** Number of entries a rule list would hold after normalisation, before the cap. */
export function countRuleEntries(entries) {
  if (!Array.isArray(entries)) return 0;
  const seen = new Set();
  for (const entry of entries) {
    try {
      seen.add(normalizeHostname(entry?.host));
    } catch {
      // Malformed entries would be dropped during normalisation anyway.
    }
  }
  return seen.size;
}

/**
 * Normalises a rule list, refusing the write when it would exceed the cap.
 * @throws {RuleLimitError}
 */
export function normalizeDomainEntriesStrict(entries) {
  const attempted = countRuleEntries(entries);
  if (attempted > MAX_RULE_ENTRIES) throw new RuleLimitError(MAX_RULE_ENTRIES, attempted);
  return normalizeDomainEntries(entries);
}

export function normalizeWhitelist(entries) {
  return normalizeDomainEntries(entries);
}

export function normalizeBlacklist(entries) {
  return normalizeDomainEntries(entries);
}

export function createDomainEntry(host, includeSubdomains = true) {
  return { host: normalizeHostname(host), includeSubdomains: Boolean(includeSubdomains) };
}

export function isIpLiteral(host) {
  return host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Loopback, link-local and other addresses that can only resolve to this machine
 * or the local link.
 *
 * These never bypass *rules* - an explicit force-proxy entry still wins - but
 * they do bypass the default route. Without this, using any PAC script silently
 * discards Chromium's built-in bypass list, so a local development server or a
 * router admin page gets sent to the proxy. An HTTP-only proxy then fails to
 * reach them and the user sees "site cannot be reached" for something running on
 * their own machine.
 *
 * Deliberately narrow: RFC1918 ranges (10/8, 192.168/16, 172.16/12) are NOT
 * included, because a corporate HTTP proxy is usually the only route to intranet
 * hosts and blanket-bypassing them would break it. Single-label hostnames are
 * included because that is what Chromium's own "<local>" default means.
 */
export function isLocalHost(host) {
  const raw = String(host ?? "").trim().toLowerCase();
  if (!raw) return false;
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (bare === "localhost" || bare === "localhost.") return true;
  if (bare === "::1" || bare === "0.0.0.0") return true;
  if (/^127\./.test(bare)) return true;
  if (/^169\.254\./.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  if (bare.endsWith(".local") && bare.length > ".local".length) return true;
  // Chromium's "<local>" bypass: a hostname with no dot is never a public FQDN.
  return !bare.includes(".") && !bare.includes(":");
}

export function getPageHostname(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

/**
 * Normalisation is memoised because it dominates the cost of a lookup: every
 * entry runs through new URL() and label validation. Without this cache a lookup
 * against 1000 rules took ~3 ms, and the service worker performs one lookup per
 * open tab on every refresh.
 *
 * Keys are primitives and the stored value is frozen, so callers cannot corrupt
 * the cache by mutating what they receive.
 */
const HOSTNAME_CACHE = new Map();
const HOSTNAME_CACHE_LIMIT = 4000;

export function normalizeHostnameCached(value) {
  const key = String(value ?? "");
  const cached = HOSTNAME_CACHE.get(key);
  if (cached !== undefined) {
    if (cached instanceof Error) throw cached;
    return cached;
  }
  try {
    const normalized = normalizeHostname(key);
    if (HOSTNAME_CACHE.size >= HOSTNAME_CACHE_LIMIT) HOSTNAME_CACHE.clear();
    HOSTNAME_CACHE.set(key, normalized);
    return normalized;
  } catch (error) {
    if (HOSTNAME_CACHE.size < HOSTNAME_CACHE_LIMIT) HOSTNAME_CACHE.set(key, error);
    throw error;
  }
}

export function isHostMatched(host, entries) {
  let normalizedHost;
  try {
    normalizedHost = normalizeHostnameCached(host);
  } catch {
    return false;
  }

  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    let itemHost;
    try {
      itemHost = normalizeHostnameCached(entry?.host);
    } catch {
      continue;
    }
    if (normalizedHost === itemHost) return true;
    if (entry?.includeSubdomains && !isIpLiteral(itemHost) && normalizedHost.endsWith(`.${itemHost}`)) {
      return true;
    }
  }
  return false;
}

export function isHostWhitelisted(host, entries) {
  return isHostMatched(host, entries);
}

export function isHostBlacklisted(host, entries) {
  return isHostMatched(host, entries);
}

/**
 * Resolve an individual domain rule.
 *
 * Order, strongest first:
 *   1. an explicit force-proxy entry (blacklist)
 *   2. a local address, which always connects directly
 *   3. an explicit direct entry (whitelist)
 *   4. the browser-wide default route
 *
 * Explicit force-proxy rules win over direct-bypass rules when parent/child
 * entries overlap, so a narrow blacklist entry can override a broad whitelist
 * entry such as api.example.com over *.example.com.
 */
export function resolveDomainRoute(host, settings) {
  if (!host) return "unknown";
  if (isHostBlacklisted(host, settings?.blacklist)) return "proxy";
  if (settings?.localBypass !== false && isLocalHost(host)) return "direct";
  if (isHostWhitelisted(host, settings?.whitelist)) return "direct";
  return settings?.mode === "direct" ? "direct" : settings?.mode === "proxy" ? "proxy" : "unknown";
}

/**
 * Chromium stores IPv6 hosts bracketed ("[::1]") because that is the canonical URL
 * form, but FindProxyForURL receives the unbracketed host portion ("::1").
 * Rules therefore have to be compared in the unbracketed form or they never match
 * an IPv6 literal, while the popup still reports the page as whitelisted.
 */
function toPacHost(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function toPacRule(entry) {
  return { host: toPacHost(entry.host), includeSubdomains: entry.includeSubdomains };
}

/**
 * Deterministic 32-bit fingerprint of the rule set and the proxy endpoint.
 *
 * inferActiveMode used to compare the browser's PAC against a freshly generated
 * one, re-serialising the whole script - measured at ~1.45 ms with 1000 rules -
 * for every tab on every refresh. Comparing this fingerprint is equivalent and
 * constant-time.
 */
function fingerprint(parts) {
  const input = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The fingerprint lives in a leading comment so it is never evaluated, and so a
// PAC script we did not write can never be mistaken for ours.
// V3 adds the local-address bypass, so scripts written by 0.1.x are recognised as
// foreign instead of being trusted to route localhost the old way.
const PAC_MARKER = "ALAXEE_PROXY_RULES_V3";
const PAC_FINGERPRINT = /\/\* ALAXEE_PROXY_RULES_V3 fp:([0-9a-f]{8}) \*\//;

/**
 * Canonical order so the fingerprint describes the rule *set*, not the order the
 * user happened to add entries in. Without this, two identical rule sets produce
 * different fingerprints and the extension reports its own proxy as foreign.
 */
function sortRules(rules) {
  return [...rules].sort((a, b) =>
    a.host === b.host
      ? Number(a.includeSubdomains) - Number(b.includeSubdomains)
      : a.host < b.host ? -1 : 1
  );
}

/**
 * Fingerprint the script this extension would generate for these settings.
 *
 * Deliberately uncached. An earlier version memoised on a cheap key built from
 * list length and the first host; two different rule sets then shared an entry
 * and returned a stale fingerprint, which is exactly the failure this function
 * exists to prevent. Instead the inputs are normalised through the memoised
 * hostname cache, which removes the expensive part without inventing an
 * approximation of equality.
 */
export function pacFingerprint(settings) {
  const server = validateProxySettings(settings);
  return fingerprint({
    v: 2,
    server,
    mode: settings.mode,
    localBypass: settings.localBypass !== false,
    whitelist: sortRules(normalizeDomainEntries(settings.whitelist).map(toPacRule)),
    blacklist: sortRules(normalizeDomainEntries(settings.blacklist).map(toPacRule))
  });
}

/**
 * Reads the fingerprint out of a PAC script we generated.
 * Returns null for scripts this extension did not write, so a foreign PAC is
 * never mistaken for ours.
 */
export function readPacFingerprint(pacSource) {
  const match = PAC_FINGERPRINT.exec(String(pacSource ?? ""));
  return match ? match[1] : null;
}

export function buildPacScript(settings) {
  if (!settings || !MODES.includes(settings.mode)) {
    throw new Error("PAC 规则只支持走代理或全局直连两种模式。");
  }

  const server = validateProxySettings(settings);
  const proxyDirective = server.scheme === "socks5"
    ? `SOCKS5 ${server.host}:${server.port}`
    : `PROXY ${server.host}:${server.port}`;
  const whitelist = normalizeDomainEntries(settings.whitelist).map(toPacRule);
  const blacklist = normalizeDomainEntries(settings.blacklist).map(toPacRule);
  const defaultDirective = settings.mode === "proxy" ? proxyDirective : "DIRECT";
  const localBypass = settings.localBypass !== false;
  const fp = pacFingerprint(settings);

  // Values are JSON-serialized from validated domain records; user input is
  // never interpolated as executable source.
  //
  // The rule arrays live at script scope. PAC files are evaluated once and only
  // FindProxyForURL is called per request, so keeping the arrays inside the
  // function rebuilt them for every navigation.
  return `/* ${PAC_MARKER} fp:${fp} */
var ALAXEE_ALLOW = ${JSON.stringify(whitelist)};
var ALAXEE_FORCE_PROXY = ${JSON.stringify(blacklist)};
var ALAXEE_PROXY = ${JSON.stringify(proxyDirective)};
var ALAXEE_DEFAULT = ${JSON.stringify(defaultDirective)};
var ALAXEE_LOCAL_BYPASS = ${localBypass ? "true" : "false"};

function ALAXEE_HOST_MATCHES(hostname, rules) {
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (hostname === rule.host) return true;
    // IPv6 literals have no subdomain relationship, so they never expand.
    if (rule.includeSubdomains && rule.host.indexOf(":") === -1 &&
        hostname.length > rule.host.length &&
        hostname.slice(-(rule.host.length + 1)) === "." + rule.host) return true;
  }
  return false;
}

// Loopback, link-local and dotless hostnames can only mean this machine or the
// local link. Using a PAC script discards Chromium's built-in bypass list, so
// without this a local dev server would be handed to a remote proxy and fail.
function ALAXEE_IS_LOCAL(hostname) {
  if (!ALAXEE_LOCAL_BYPASS) return false;
  if (hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0") return true;
  if (hostname.indexOf("127.") === 0) return true;
  if (hostname.indexOf("169.254.") === 0) return true;
  if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
  if (hostname.length > 6 && hostname.slice(-6) === ".local") return true;
  return hostname.indexOf(".") === -1 && hostname.indexOf(":") === -1;
}

function FindProxyForURL(url, host) {
  host = String(host || "").toLowerCase().replace(/\\.$/, "");

  // Blacklist is the stronger explicit instruction and wins on overlap, including
  // over the local-address bypass below.
  if (ALAXEE_HOST_MATCHES(host, ALAXEE_FORCE_PROXY)) return ALAXEE_PROXY;
  if (ALAXEE_IS_LOCAL(host)) return "DIRECT";
  if (ALAXEE_HOST_MATCHES(host, ALAXEE_ALLOW)) return "DIRECT";
  return ALAXEE_DEFAULT;
}`;
}

/**
 * Translates settings into a chrome.proxy.settings value.
 *
 * @throws when the settings demand an endpoint that the user has not entered, so
 * the caller applies nothing rather than writing a proxy pointing at ":"
 */
export function buildChromeProxyConfig(settings) {
  if (!settings || !MODES.includes(settings.mode)) throw new Error("未知的代理模式。");

  const blacklist = normalizeDomainEntries(settings.blacklist);
  if (settings.mode === "direct" && blacklist.length === 0) return { mode: "direct" };

  return {
    mode: "pac_script",
    pacScript: {
      data: buildPacScript(settings),
      mandatory: true
    }
  };
}

/**
 * Identifies the browser's current proxy value as one this extension wrote.
 * Returns "proxy" / "direct" / null. Null means "not ours", which the UI shows as
 * an unknown state rather than guessing.
 */
export function inferActiveMode(value, savedSettings) {
  if (!value || typeof value !== "object") return null;
  if (value.mode === "direct") return "direct";
  // The extension never writes "system" any more. If the browser reports it, the
  // value came from elsewhere - an older version, another extension, or a policy.
  if (value.mode === "system") return null;

  if (value.mode === "pac_script") {
    try {
      // Compare fingerprints rather than regenerating and diffing the script.
      // Equivalent, but constant-time instead of re-serialising every rule.
      const active = readPacFingerprint(value.pacScript?.data);
      if (active === null) return null;
      if (active === pacFingerprint(savedSettings)) return savedSettings.mode;
    } catch {
      // A different or invalid PAC script is not owned by this extension.
    }
    return null;
  }

  // Backward compatibility with the fixed-server config written by 0.1.1/0.1.2,
  // before domain rules existed.
  if (value.mode === "fixed_servers") {
    const proxy = value.rules?.singleProxy;
    if (!proxy) return null;
    try {
      const saved = validateProxySettings(savedSettings);
      if (proxy.host === saved.host && Number(proxy.port) === saved.port && proxy.scheme === saved.scheme) {
        return "proxy";
      }
    } catch {
      // The fixed proxy does not match this extension's saved endpoint.
    }
  }
  return null;
}

/**
 * One-line description of what the browser is currently doing, for the status
 * pill. Deliberately short: the endpoint address is shown separately, next to the
 * mode buttons, because the pill has room for a state and not for an address.
 */
export function describeProxyMode(value, savedSettings) {
  if (!value || typeof value !== "object") return "状态未知";
  if (value.mode === "direct") return "直接连接";
  if (value.mode === "system") return "跟随系统代理";
  if (value.mode === "pac_script") {
    const mode = inferActiveMode(value, savedSettings);
    if (mode === "proxy") return "经代理服务器";
    if (mode === "direct") return "直连（黑名单例外）";
    return "其他 PAC 配置";
  }
  if (value.mode === "fixed_servers") {
    const proxy = value.rules?.singleProxy;
    if (!proxy) return "其他代理配置";
    try {
      const saved = validateProxySettings(savedSettings);
      if (proxy.host === saved.host && Number(proxy.port) === saved.port && proxy.scheme === saved.scheme) {
        return "经代理服务器";
      }
    } catch {
      // Settings may not be configured yet.
    }
    return "其他代理配置";
  }
  if (value.mode === "auto_detect") return "自动检测代理";
  return "状态未知";
}

/** The endpoint line under the mode buttons, e.g. "浏览器代理 → socks5://127.0.0.1:7890". */
export function describeProxyEndpoint(settings) {
  try {
    const server = validateProxySettings(settings);
    return `浏览器代理 → ${server.scheme}://${server.host}:${server.port}`;
  } catch {
    return "尚未填写代理服务器地址";
  }
}

/**
 * "proxy" means the browser hands requests to the configured listener. It does
 * not guarantee the proxy program will choose a remote node instead of going
 * direct itself.
 */
export function resolveTabRoute(url, proxyState, savedSettings) {
  const hostname = getPageHostname(url);
  if (!hostname || !proxyState || typeof proxyState !== "object") return "unknown";

  const level = proxyState.levelOfControl;
  if (level === "not_controllable" || level === "controlled_by_other_extensions") return "unknown";

  const value = proxyState.value ?? {};
  const activeMode = inferActiveMode(value, savedSettings);
  if (activeMode === null) return "unknown";

  if (value.mode === "pac_script") return resolveDomainRoute(hostname, savedSettings);
  if (value.mode === "fixed_servers") {
    if (activeMode !== "proxy") return "unknown";
    return (savedSettings.localBypass !== false && isLocalHost(hostname)) ||
      (isHostWhitelisted(hostname, savedSettings.whitelist) && !isHostBlacklisted(hostname, savedSettings.blacklist))
      ? "direct"
      : "proxy";
  }
  if (activeMode === "direct") return "direct";
  return "unknown";
}

export function resolveGlobalRoute(proxyState, savedSettings) {
  if (!proxyState || typeof proxyState !== "object") return "unknown";
  const level = proxyState.levelOfControl;
  if (level === "not_controllable" || level === "controlled_by_other_extensions") return "unknown";
  return inferActiveMode(proxyState.value ?? {}, savedSettings) ?? "unknown";
}

/* -------------------------------------------------------------------------- */
/* Finding the endpoint                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ports that proxy applications commonly listen on by default.
 *
 * This exists because "填什么端口" is the single highest-friction moment in the
 * whole product: the extension deliberately ships with no address, and a user who
 * does not know their proxy's local port has no way to find it from inside the
 * browser. A plain port list is *not* a proxy-product dependency - it is the same
 * kind of hint as remembering that HTTP is port 80 - and every entry is offered
 * as a starting point to be verified, never applied silently.
 */
export const COMMON_PROXY_PORTS = Object.freeze([
  { port: "7890", hint: "Clash / mihomo Mixed 端口" },
  { port: "7891", hint: "Clash / mihomo 常见备用 Mixed 端口" },
  { port: "1080", hint: "通用 SOCKS，如 ssh -D" },
  { port: "10808", hint: "v2rayN / Xray 常见 SOCKS 端口" },
  { port: "10809", hint: "v2rayN / Xray 常见 HTTP 端口" },
  { port: "8080", hint: "通用 HTTP 代理，公司代理常见" },
  { port: "3128", hint: "Squid 等 HTTP 代理默认端口" },
  { port: "2080", hint: "部分客户端（如 v2rayA）常用端口" }
]);

/**
 * Turns a pasted address into connection fields.
 *
 * Users copy proxy addresses in every shape there is - "127.0.0.1:7890",
 * "socks5://127.0.0.1:7890", "http://user:pass@host:8080" - and retyping them by
 * hand is where mistakes happen. Returns null when the text carries no usable
 * address, and reports what could not be represented instead of guessing.
 *
 * Credentials are reported, never silently dropped: the PAC format cannot carry a
 * username and password, and a user whose proxy needs them must be told why the
 * connection will fail rather than left to debug it.
 */
export function parseProxyAddress(text) {
  const original = String(text ?? "").trim();
  if (!original) return null;
  let value = original;

  // A bare "host:port" is ambiguous with a URL scheme ("socks5:7890"), so only
  // treat it as a scheme when it is followed by "//".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `socks5://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const schemeMap = { socks5: "socks5", socks: "socks5", socks5h: "socks5", http: "http", https: "http" };
  const scheme = schemeMap[url.protocol.replace(":", "")];
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port;
  if (!scheme || !host || !port) return null;

  // "socks5:7890" (scheme with no "//") reaches here as host "socks5". That is a
  // mistyped URL rather than a hostname, so report it instead of connecting to a
  // machine called "socks5".
  if (!original.includes("://") && schemeMap[host]) return null;

  return {
    host,
    port,
    scheme,
    credentials: Boolean(url.username || url.password)
  };
}

/**
 * Human explanation for a failed connection, used when the user reports "填写了
 * 端口但不生效". Each entry names the most likely cause in the order it should be
 * checked, so the UI can offer something better than a bare error.
 */
export const ENDPOINT_TROUBLESHOOTING = Object.freeze([
  "确认端口填的是代理软件的「本地监听端口 / Mixed 端口」，不是它的控制面板端口（Clash 的控制面板通常是 9090，填这个不会转发流量）。",
  "确认代理软件正在运行，并且那个端口处于「允许局域网连接」之外的本机可达状态。",
  "协议选对：Mixed / SOCKS 端口选 SOCKS5，纯 HTTP 端口选 HTTP。选错时浏览器会连上但握手中断。",
  "确认没有其他代理扩展或组织策略同时控制 Edge 的代理设置（面板顶部会显示「其他代理配置」）。"
]);
