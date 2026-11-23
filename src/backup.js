/**
 * Import and export of the whole configuration as one JSON document.
 *
 * Why this exists: everything the extension knows lives in `chrome.storage.local`,
 * which is bound to one Edge profile on one machine. There is no account and no
 * cloud sync by design, so without a file the only way to survive a profile reset,
 * a reinstall or a second machine was to retype every domain rule by hand.
 *
 * Deliberately not a sync feature: the file is produced on demand and handed to the
 * user's own download folder. Nothing is uploaded, and importing never merges
 * silently - see planImport for why.
 */

import { reconcileRuleLists } from "./core.js";

export const BACKUP_FORMAT = "alaxee-proxy-settings";
export const BACKUP_VERSION = 1;

/**
 * Serialises settings for the user to keep.
 *
 * The endpoint is included but marked, because a backup that carries
 * "127.0.0.1:7890" restored on a different machine is harmless (it is almost
 * certainly wrong there, and the UI says so) while silently omitting it would make
 * the backup feel incomplete.
 */
export function exportSettings(settings, { exportedAt = new Date().toISOString() } = {}) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    settings: {
      mode: settings.mode,
      scheme: settings.scheme,
      host: settings.host,
      port: settings.port,
      includeSubdomains: settings.includeSubdomains !== false,
      localBypass: settings.localBypass !== false,
      whitelist: settings.whitelist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains })),
      blacklist: settings.blacklist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains }))
    }
  };
}

/** A filename that sorts chronologically and survives every filesystem. */
export function backupFilename(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `alaxee-proxy-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

/**
 * Validates a file the user picked and decides what importing it would change.
 *
 * Returns a plan rather than applying anything, because an import can destroy work:
 * the user may have a carefully built list on this machine and a stale file from
 * another. The caller shows counts and the plan's `replace` flag, and the user
 * chooses. Nothing here touches storage.
 *
 * @returns {{ok: true, plan: object} | {ok: false, error: string}}
 */
export function planImport(text, { normalize } = {}) {
  // Note: import replaces, unlike sync which merges. That is deliberate - the user
  // picked a file and confirmed a summary that says "replace" - but it means an
  // import can drop rules that sync has. The confirmation text has to keep saying
  // so; see describeImportPlan.
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, error: "这不是有效的 JSON 文件。" };
  }

  if (!parsed || typeof parsed !== "object" || parsed.format !== BACKUP_FORMAT) {
    return { ok: false, error: "这个文件不是 Alaxee Proxy 的备份文件。" };
  }
  if (Number(parsed.version) > BACKUP_VERSION) {
    return { ok: false, error: `备份文件版本 ${parsed.version} 比当前扩展更新，请先升级扩展。` };
  }
  if (!parsed.settings || typeof parsed.settings !== "object") {
    return { ok: false, error: "备份文件里没有设置内容。" };
  }

  const raw = parsed.settings;
  const validScheme = raw.scheme === "http" || raw.scheme === "socks5" ? raw.scheme : "socks5";
  const validMode = raw.mode === "direct" ? "direct" : "proxy";
  const clean = normalize ?? defaultNormalize;

  // A backup file can carry the same host on both lists. Routing already resolves
  // that in favour of the blacklist, so the direct entry is dead weight that only
  // makes the list confusing; drop it here so import and manual editing agree.
  const { whitelist, blacklist } = reconcileRuleLists({
    whitelist: clean(raw.whitelist),
    blacklist: clean(raw.blacklist)
  });
  const droppedWhitelist = (Array.isArray(raw.whitelist) ? raw.whitelist.length : 0) - whitelist.length;
  const droppedBlacklist = (Array.isArray(raw.blacklist) ? raw.blacklist.length : 0) - blacklist.length;

  const plan = {
    settings: {
      mode: validMode,
      scheme: validScheme,
      host: String(raw.host ?? "").trim(),
      port: String(raw.port ?? "").trim(),
      includeSubdomains: raw.includeSubdomains !== false,
      localBypass: raw.localBypass !== false,
      whitelist,
      blacklist
    },
    counts: { whitelist: whitelist.length, blacklist: blacklist.length },
    dropped: { whitelist: Math.max(0, droppedWhitelist), blacklist: Math.max(0, droppedBlacklist) },
    // Import always replaces both lists. Merging would produce a rule set the user
    // never reviewed, and a domain ending up on the wrong list is a routing bug
    // with no visible symptom.
    replace: true,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : null
  };

  return { ok: true, plan };
}

/** Fallback used when the caller does not supply the core normaliser. */
function defaultNormalize(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const host = String(entry?.host ?? "").trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ host, includeSubdomains: Boolean(entry?.includeSubdomains) });
  }
  return out;
}

/** One-line summary for the confirmation prompt. */
export function describeImportPlan(plan) {
  const parts = [
    `直连白名单 ${plan.counts.whitelist} 条`,
    `代理黑名单 ${plan.counts.blacklist} 条`,
    `模式：${plan.settings.mode === "proxy" ? "走代理服务器" : "直接连接"}`
  ];
  const dropped = plan.dropped.whitelist + plan.dropped.blacklist;
  if (dropped > 0) parts.push(`有 ${dropped} 条无效或重复的规则会被忽略`);
  if (!plan.settings.host || !plan.settings.port) {
    parts.push("文件里没有可用的代理地址，导入后需要自己填");
  }
  return `${parts.join("，")}。导入会**替换**当前的规则列表。`;
}
