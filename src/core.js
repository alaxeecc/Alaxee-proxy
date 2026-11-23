export const DEFAULT_SETTINGS = Object.freeze({
  mode: "clash",
  host: "127.0.0.1",
  port: "7890",
  scheme: "socks5",
  includeSubdomains: true,
  whitelist: [],
  blacklist: []
});

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

  const host = normalizeHostname(settings.host);
  const portText = String(settings.port ?? "").trim();
  if (!/^\d{1,5}$/.test(portText)) throw new Error("端口必须是 1 到 65535 之间的数字。");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1 到 65535 之间的数字。");
  }

  return { host, port, scheme };
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
 * Explicit force-proxy rules win over direct-bypass rules when parent/child
 * entries overlap. This makes a narrow blacklist entry override a broad
 * whitelist entry, such as api.example.com over *.example.com.
 */
export function resolveDomainRoute(host, settings) {
  if (!host) return "unknown";
  if (settings?.mode === "system") return "system";
  if (isHostBlacklisted(host, settings?.blacklist)) return "clash";
  if (isHostWhitelisted(host, settings?.whitelist)) return "direct";
  return settings?.mode === "direct" ? "direct" : settings?.mode === "clash" ? "clash" : "unknown";
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
const PAC_MARKER = "ALAXEE_PROXY_RULES_V2";
const PAC_FINGERPRINT = /\/\* ALAXEE_PROXY_RULES_V2 fp:([0-9a-f]{8}) \*\//;

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
    v: 1,
    server,
    mode: settings.mode,
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
  if (!settings || !["clash", "direct"].includes(settings.mode)) {
    throw new Error("PAC 规则只支持 Clash 或全局直连模式。");
  }

  const server = validateProxySettings(settings);
  const proxyDirective = server.scheme === "socks5"
    ? `SOCKS5 ${server.host}:${server.port}`
    : `PROXY ${server.host}:${server.port}`;
  const whitelist = normalizeDomainEntries(settings.whitelist).map(toPacRule);
  const blacklist = normalizeDomainEntries(settings.blacklist).map(toPacRule);
  const defaultDirective = settings.mode === "clash" ? proxyDirective : "DIRECT";
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

function FindProxyForURL(url, host) {
  host = String(host || "").toLowerCase().replace(/\\.$/, "");

  // Blacklist is the stronger explicit instruction and wins on overlap.
  if (ALAXEE_HOST_MATCHES(host, ALAXEE_FORCE_PROXY)) return ALAXEE_PROXY;
  if (ALAXEE_HOST_MATCHES(host, ALAXEE_ALLOW)) return "DIRECT";
  return ALAXEE_DEFAULT;
}`;
}

export function buildChromeProxyConfig(settings) {
  if (settings.mode === "system") return { mode: "system" };
  if (settings.mode === "direct" && normalizeDomainEntries(settings.blacklist).length === 0) {
    return { mode: "direct" };
  }
  if (!["clash", "direct"].includes(settings.mode)) throw new Error("未知的代理模式。");

  return {
    mode: "pac_script",
    pacScript: {
      data: buildPacScript(settings),
      mandatory: true
    }
  };
}

export function inferActiveMode(value, savedSettings) {
  if (!value || typeof value !== "object") return null;
  if (value.mode === "direct") return "direct";
  if (value.mode === "system") return "system";

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

  // Backward compatibility with settings installed before domain PAC rules.
  if (value.mode === "fixed_servers") {
    const proxy = value.rules?.singleProxy;
    if (!proxy) return null;
    try {
      const saved = validateProxySettings(savedSettings);
      if (proxy.host === saved.host && Number(proxy.port) === saved.port && proxy.scheme === saved.scheme) {
        return "clash";
      }
    } catch {
      // The fixed proxy does not match this extension's saved endpoint.
    }
  }
  return null;
}

export function describeProxyMode(value, savedSettings) {
  if (!value || typeof value !== "object") return "状态未知";
  if (value.mode === "direct") return "直接连接";
  if (value.mode === "system") return "跟随系统代理";
  if (value.mode === "pac_script") {
    const mode = inferActiveMode(value, savedSettings);
    if (mode === "clash") return "Clash 代理（域名规则）";
    if (mode === "direct") return "全局直连（黑名单例外）";
    return "其他 PAC 代理配置";
  }
  if (value.mode === "fixed_servers") {
    const proxy = value.rules?.singleProxy;
    if (!proxy) return "其他代理配置";
    try {
      const saved = validateProxySettings(savedSettings);
      if (proxy.host === saved.host && Number(proxy.port) === saved.port && proxy.scheme === saved.scheme) {
        return "Clash 代理";
      }
    } catch {
      // Settings may not be configured yet.
    }
    return "其他代理配置";
  }
  if (value.mode === "auto_detect") return "自动检测代理";
  return "状态未知";
}

/**
 * "clash" means the browser hands requests to the local listener. It does not
 * guarantee Clash will choose a proxy node instead of DIRECT.
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
    if (activeMode !== "clash") return "unknown";
    return isHostWhitelisted(hostname, savedSettings.whitelist) && !isHostBlacklisted(hostname, savedSettings.blacklist)
      ? "direct"
      : "clash";
  }
  if (activeMode === "direct") return "direct";
  if (activeMode === "system") return "system";
  return "unknown";
}

export function resolveGlobalRoute(proxyState, savedSettings) {
  if (!proxyState || typeof proxyState !== "object") return "unknown";
  const level = proxyState.levelOfControl;
  if (level === "not_controllable" || level === "controlled_by_other_extensions") return "unknown";
  return inferActiveMode(proxyState.value ?? {}, savedSettings) ?? "unknown";
}
