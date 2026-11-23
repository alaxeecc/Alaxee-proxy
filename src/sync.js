/**
 * Cross-device sync over `chrome.storage.sync`.
 *
 * Why not a backend: the only thing that needs to travel between devices is one
 * small settings record (worst case, 500 rules ≈ 31 KB). `chrome.storage.sync`
 * gives that for free, with no account, no API key, no server to keep awake, and
 * no additional permission because `storage` already covers every area.
 *
 * Privacy note, and the reason this module is opt-in: a domain rule list reveals
 * which sites a person must route around a proxy. That is not incidental data.
 * Nothing is written to the sync area unless the user turns sync on in settings.
 *
 * ## Why the payload is split
 *
 * `chrome.storage.sync` allows 8,192 bytes per item, counted as key length plus
 * the JSON length of the value. A 500-rule payload is ~31 KB, so a single item
 * can never hold it. The record is therefore chunked into several string items,
 * each well under the cap, and rebuilt on read.
 *
 * ## Why there is a checksum
 *
 * Sync propagation is not atomic and not instant: a writing device pushes chunk
 * items one at a time, and a reading device may observe a new `meta` next to old
 * chunks. Every chunk carries the generation it belongs to, and `meta` carries a
 * checksum of the whole payload. A partially written or partially propagated set
 * therefore fails the checksum and is ignored, instead of silently producing a
 * truncated rule list that would look like data loss.
 */

export const SYNC_PREFIX = "alaxee.sync.";
export const SYNC_FORMAT = "alaxee-proxy-sync";
export const SYNC_VERSION = 1;

/**
 * Bytes reserved for one chunk's storage key, so the total stays under 8,192.
 *
 * Keys look like `alaxee.sync.c.12345678.7`, which is 26 characters at worst. The
 * remainder (8192 - 26) is the space available for the JSON string.
 */
const KEY_OVERHEAD = 32;
const CHUNK_TARGET = 7000;
const MAX_SAFE_CHUNK = 8192 - KEY_OVERHEAD;

/** Storage key for one chunk of one generation. */
export function chunkKey(generation, index) {
  return `${SYNC_PREFIX}c.${generation}.${index}`;
}

export const META_KEY = `${SYNC_PREFIX}meta`;

/**
 * Deterministic checksum, using the same FNV-1a construction as the PAC
 * fingerprint for consistency with the rest of the codebase. Length is included
 * as well so that two payloads of different lengths cannot collide by construction.
 */
export function checksum(text) {
  const input = String(text ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${input.length.toString(16)}`;
}

/**
 * Builds the full set of items to write for one generation.
 *
 * @returns {{items: Record<string, unknown>, meta: object, generation: string, chunks: number, bytes: number}}
 */
export function buildSyncItems(settings, { generation = Date.now().toString(36), deviceId = "unknown" } = {}) {
  // Reading the workspace state is the caller's job; this function only shapes it.
  const payload = JSON.stringify({
    mode: settings.mode,
    scheme: settings.scheme,
    host: settings.host,
    port: settings.port,
    includeSubdomains: settings.includeSubdomains !== false,
    localBypass: settings.localBypass !== false,
    whitelist: settings.whitelist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains })),
    blacklist: settings.blacklist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains }))
  });

  const chunks = [];
  let offset = 0;
  while (offset < payload.length) {
    let end = Math.min(offset + CHUNK_TARGET, payload.length);
    // Never cut a surrogate pair in half: JSON strings are UTF-16 internally, and
    // a lone surrogate would survive JSON.stringify but not a round trip through
    // storage on every engine.
    const code = payload.charCodeAt(end - 1);
    if (end < payload.length && code >= 0xd800 && code <= 0xdbff) end += 1;
    chunks.push(payload.slice(offset, end));
    offset = end;
  }

  const meta = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    generation,
    deviceId,
    chunks: chunks.length,
    checksum: checksum(payload),
    updatedAt: new Date().toISOString()
  };

  const items = {};
  for (const [index, chunk] of chunks.entries()) {
    const key = chunkKey(generation, index);
    if (key.length + chunk.length > MAX_SAFE_CHUNK + KEY_OVERHEAD) {
      // Cannot happen with CHUNK_TARGET = 7000; asserted so a future change to the
      // constants cannot silently produce a write that always fails with
      // QUOTA_BYTES_PER_ITEM.
      throw new Error("同步分块超出 chrome.storage.sync 单项上限。");
    }
    items[key] = chunk;
  }
  items[META_KEY] = meta;
  return { items, meta, generation, chunks: chunks.length, bytes: payload.length };
}

/**
 * Rebuilds settings from whatever is in the sync area.
 *
 * @returns {{ok: true, settings: object, meta: object} | {ok: false, reason: string}}
 *   `reason` is one of: "empty", "incomplete", "corrupt", "unsupported".
 */
export function readSyncState(syncArea) {
  const meta = syncArea?.[META_KEY];
  if (!meta || typeof meta !== "object") return { ok: false, reason: "empty" };

  if (meta.format !== SYNC_FORMAT) return { ok: false, reason: "unsupported" };
  if (Number(meta.version) > SYNC_VERSION) return { ok: false, reason: "unsupported" };

  const generation = String(meta.generation ?? "");
  const count = Number(meta.chunks);
  if (!generation || !Number.isInteger(count) || count < 1) return { ok: false, reason: "corrupt" };

  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = syncArea[chunkKey(generation, index)];
    // A missing chunk means the writer is mid-push or the propagation stopped
    // halfway. Refusing is correct: half a rule list is indistinguishable from a
    // list the user deleted those entries from.
    if (typeof chunk !== "string") return { ok: false, reason: "incomplete" };
    parts.push(chunk);
  }

  const payload = parts.join("");
  if (checksum(payload) !== meta.checksum) return { ok: false, reason: "corrupt" };

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "corrupt" };

  // Rules are not validated here - that needs the core normaliser and the caller
  // has it. Passing them through keeps this module free of routing knowledge.
  return {
    ok: true,
    meta,
    settings: {
      mode: parsed.mode === "direct" ? "direct" : "proxy",
      scheme: parsed.scheme === "http" ? "http" : "socks5",
      host: String(parsed.host ?? ""),
      port: String(parsed.port ?? ""),
      includeSubdomains: parsed.includeSubdomains !== false,
      localBypass: parsed.localBypass !== false,
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
      blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : []
    }
  };
}

/** Whether two settings records differ in anything that would be synced. */
export function settingsDiffer(a, b) {
  if (!a || !b) return true;
  const shape = (value) => JSON.stringify({
    mode: value.mode,
    scheme: value.scheme,
    host: value.host,
    port: value.port,
    includeSubdomains: value.includeSubdomains !== false,
    localBypass: value.localBypass !== false,
    whitelist: value.whitelist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains })),
    blacklist: value.blacklist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains }))
  });
  return shape(a) !== shape(b);
}

/**
 * Keys that must be removed when replacing a generation.
 *
 * Without this, every push leaves the previous generation's chunks behind: sync
 * storage has a 512-item cap, and stale chunks would eventually fill it and make
 * all further writes fail.
 */
export function staleChunkKeys(syncArea, keepGeneration) {
  const keys = Object.keys(syncArea ?? {});
  return keys.filter((key) => {
    if (!key.startsWith(`${SYNC_PREFIX}c.`)) return false;
    const generation = key.slice(`${SYNC_PREFIX}c.`.length).split(".")[0];
    return generation !== keepGeneration;
  });
}

/**
 * Human explanation for a sync state, used by the settings UI.
 *
 * The distinction between "on but stale" and "on and applied" matters: a user who
 * turned sync on and still sees an old rule list needs to know that the other
 * device has not written anything yet, rather than assume syncing is broken.
 */
export function describeSyncStatus(status) {
  switch (status.reason) {
    case "empty":
      return "已开启同步，但还没有任何设备写入过设置。在这台设备上做一次修改即可上传。";
    case "incomplete":
      return "另一端正在写入，或者同步只传了一半。稍后再看，当前仍使用本机设置。";
    case "corrupt":
      return "同步数据校验失败，已忽略，当前仍使用本机设置。可以在设置里重新上传一次。";
    case "unsupported":
      return "同步数据来自更新版本的扩展，已忽略。升级扩展后再试。";
    default:
      return status.updatedAt
        ? `本机与同步数据一致（最后更新 ${status.updatedAt}）。`
        : "同步已开启。";
  }
}

/**
 * Decides whether local settings or the synced record should win.
 *
 * A wrong guess here uploads one device's state over everyone else's, so the rule
 * is deliberately conservative: a device with no edit history (updatedAt === 0)
 * never claims to be newer, because it has no basis for that claim. That case is
 * "ambiguous" and resolves to reading the cloud record - which is what a person
 * who just enabled sync on a new machine expects anyway.
 *
 * @returns {"local-wins"|"cloud-wins"|"ambiguous"}
 */
export function syncDirection({ local, meta }) {
  const localWrite = Number(local?.updatedAt ?? 0);
  if (!Number.isFinite(localWrite) || localWrite <= 0) return "ambiguous";
  const syncedAt = Date.parse(String(meta?.updatedAt ?? ""));
  if (!Number.isFinite(syncedAt)) return "local-wins";
  return localWrite > syncedAt ? "local-wins" : "cloud-wins";
}
