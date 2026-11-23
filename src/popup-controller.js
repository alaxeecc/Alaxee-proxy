/**
 * State and side effects for the popup and the full settings page.
 *
 * This module owns everything that reads or writes chrome.* APIs or keeps
 * mutable state. Pure DOM work is imported from popup-render.js so the two
 * surfaces share one implementation and rendering stays independently testable.
 *
 * Both surfaces load this same module: the options page redirects to
 * src/popup.html?full=1, so only one instance exists at a time.
 */
import {
  DEFAULT_SETTINGS,
  RuleLimitError,
  buildChromeProxyConfig,
  createDomainEntry,
  describeProxyMode,
  getPageHostname,
  inferActiveMode,
  isConfigured,
  migrateStoredSettings,
  normalizeDomainEntriesStrict,
  reconcileRuleLists,
  requiresProxyEndpoint,
  validateProxySettings
} from "./core.js";
import {
  backupFilename,
  exportSettings,
  planImport
} from "./backup.js";
import {
  META_KEY,
  SYNC_PREFIX,
  buildSyncItems,
  describeSyncStatus,
  mergeSettings,
  readSyncState,
  removedHosts,
  settingsDiffer,
  staleChunkKeys,
  syncDirection,
  withTombstones
} from "./sync.js";
import {
  applyPastedAddress,
  clearRestorePlan,
  createUi,
  renderConnectionFields,
  renderCurrentPage as renderCurrentPageView,
  renderCollapsedPanels as renderCollapsedPanelsView,
  renderEndpointLine,
  renderEndpointTag,
  renderLocalBypass,
  renderModes as renderModesView,
  renderProxyState,
  renderProxyStateError,
  renderRuleCounts,
  renderRuleTab,
  renderRules as renderRulesView,
  renderStatusPermission as renderStatusPermissionView,
  renderPortSuggestions,
  renderRestorePlan,
  renderSyncPanel,
  renderTroubleshooting,
  renderViewSwitch,
  showNotice
} from "./popup-render.js";

const fullPageMode = new URLSearchParams(window.location.search).get("full") === "1";
if (fullPageMode) {
  document.documentElement.classList.add("full-page");
  document.title = "Alaxee Proxy · 完整设置";
  const intro = document.getElementById("fullPageIntro");
  if (intro) intro.hidden = false;
  const settingsButton = document.getElementById("openSettingsButton");
  if (settingsButton) {
    settingsButton.textContent = "关闭设置";
    settingsButton.title = "关闭完整设置页，返回浏览器";
    settingsButton.setAttribute("aria-label", "关闭完整设置页");
  }
}

const ui = createUi();

let settings = { ...DEFAULT_SETTINGS, whitelist: [], blacklist: [] };
let currentHostname = null;
let currentTabUrl = "";
let proxyStateSnapshot = null;
// null means the browser's proxy value is not one this extension wrote - another
// extension, a policy, or a leftover config. The UI reports that as "unknown".
let activeMode = null;
let activeView = "overview";
let activeRuleType = "whitelist";
let ruleSearch = "";
let ruleSort = "recent";
let ruleGrouped = false;
let noticeTimer = null;

/* ------------------------------------------------------------------ */
/* Render wrappers                                                     */
/*                                                                     */
/* Rendering takes explicit inputs; these wrappers bind the current    */
/* state so the call sites below stay close to their original shape.   */
/* ------------------------------------------------------------------ */

function renderCurrentPage() {
  return renderCurrentPageView(ui, {
    currentTabUrl,
    currentHostname,
    settings,
    proxyState: proxyStateSnapshot
  });
}

function renderModes() {
  renderModesView(ui, activeMode, settings);
  renderEndpointLine(ui, settings);
  renderEndpointTag(ui, settings);
}

function renderCollapsedPanels() {
  renderCollapsedPanelsView(ui, settings);
}

function renderRules() {
  // Cheap and idempotent: keeps collapsed panels' attention state in step with the
  // settings on every render path instead of at each call site.
  renderCollapsedPanels();
  renderRulesView(ui, {
    settings,
    activeRuleType,
    search: ruleSearch,
    sort: ruleSort,
    grouped: ruleGrouped,
    matchedHost: matchedRuleHost(),
    onRemove: (host, type) => {
      void removeDomainRule(host, type).catch(reportRuleError);
    }
  });
}

/** The exact rule entry that decides the current page's route, if any. */
function matchedRuleHost() {
  if (!currentHostname) return null;
  for (const entry of [...settings.blacklist, ...settings.whitelist]) {
    if (entry.host === currentHostname) return entry.host;
  }
  return null;
}

function renderStatusPermission() {
  chrome.permissions.contains({ permissions: ["tabs"] }, (granted) => {
    renderStatusPermissionView(ui, Boolean(granted));
  });
}

function syncRuleCounts() {
  renderRuleCounts(ui, settings, activeRuleType);
}

function sendNotice(message, kind = "success", action = null) {
  noticeTimer?.();
  noticeTimer = showNotice(ui, message, kind, globalThis, action);
}

function chromeCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      target[method](...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function loadSettings() {
  const stored = await chromeCall(chrome.storage.local, "get", "settings");
  const { settings: migrated, changed, legacyMode } = migrateStoredSettings(stored?.settings);
  settings = migrated;

  // Write the migration back once. Without this the old mode name stays in
  // storage and every surface has to re-derive it on every read.
  if (changed) await chromeCall(chrome.storage.local, "set", { settings });

  syncEnabled = settings.syncEnabled === true;

  renderConnectionFields(ui, settings);
  renderRules();
  renderModes();
  renderSyncPanel(ui, { enabled: syncEnabled, status: null, pendingUpload: false });

  if (legacyMode === "clash") {
    sendNotice("已从旧版本升级：原来的「Clash 代理」模式现在叫「走代理服务器」，规则和行为都没有变。", "warning");
  } else if (legacyMode === "system") {
    sendNotice("「跟随系统代理」模式已移除，因为它会让域名规则静默失效。已切换为「直接连接」；如果你的规则需要走代理，请在概览页切换模式。", "warning");
  }
}

async function saveSettings(nextSettings) {
  // Throws RuleLimitError instead of silently dropping entries past the cap.
  // The throw happens before any write, so a rejected edit leaves state intact.
  const whitelist = normalizeDomainEntriesStrict(nextSettings.whitelist ?? settings.whitelist);
  const blacklist = normalizeDomainEntriesStrict(nextSettings.blacklist ?? settings.blacklist);
  // `updatedAt` means "the configuration was edited", not "storage was written".
  // Toggling sync is not an edit: stamping it here made a fresh install look newer
  // than the cloud the instant the user turned sync on, and its empty rule list
  // then overwrote every other device. Only content counts.
  const edited = contentShape({ ...settings, ...nextSettings, whitelist, blacklist }) !== contentShape(settings);
  settings = {
    ...settings,
    ...nextSettings,
    whitelist,
    blacklist,
    updatedAt: edited ? Date.now() : (settings.updatedAt ?? 0)
  };
  await chromeCall(chrome.storage.local, "set", { settings });
  syncRuleCounts();
  if (syncEnabled) scheduleUpload();
}

function reportRuleError(error) {
  if (error instanceof RuleLimitError) {
    sendNotice(error.message, "error");
    return;
  }
  sendNotice(`操作失败：${error.message}`, "error");
}

async function getCurrentTab() {
  if (fullPageMode) {
    const sourceTabId = Number(new URLSearchParams(window.location.search).get("sourceTabId"));
    if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
      try {
        const sourceTab = await chromeCall(chrome.tabs, "get", sourceTabId);
        if (sourceTab) return sourceTab;
      } catch {
        // The source tab may have closed or its URL may no longer be available.
      }
    }
  }
  const tabs = await chromeCall(chrome.tabs, "query", { active: true, lastFocusedWindow: true });
  if (fullPageMode) return tabs?.find((tab) => getPageHostname(tab?.url)) ?? tabs?.[0] ?? null;
  return tabs?.[0] ?? null;
}

async function inspectCurrentPage() {
  try {
    const tab = await getCurrentTab();
    currentTabUrl = tab?.url ?? "";
    currentHostname = getPageHostname(currentTabUrl);
  } catch {
    currentTabUrl = "";
    currentHostname = null;
  }
  renderCurrentPage();
}

function switchView(view) {
  activeView = view === "rules" ? "rules" : "overview";
  renderViewSwitch(ui, activeView);
  if (activeView === "rules") renderRules();
}

function switchRuleType(type) {
  activeRuleType = type === "blacklist" ? "blacklist" : "whitelist";
  renderRuleTab(ui, activeRuleType);
  renderRules();
}

async function readProxyState() {
  try {
    const result = await chromeCall(chrome.proxy.settings, "get", { incognito: false });
    proxyStateSnapshot = result;
    const level = result?.levelOfControl ?? "unknown";
    const current = result?.value ?? {};
    const label = describeProxyMode(current, settings);
    activeMode = inferActiveMode(current, settings);
    renderModes();
    renderCurrentPage();
    renderProxyState(ui, { label, level });

    if (level === "not_controllable" || level === "controlled_by_other_extensions") {
      sendNotice("浏览器代理设置当前由其他扩展或管理策略控制，Alaxee Proxy 可能无法切换。", "error");
    }
    return { level, current };
  } catch (error) {
    renderProxyStateError(ui);
    sendNotice(`读取浏览器代理状态失败：${error.message}`, "error");
    return null;
  }
}

/**
 * Persists a change and applies it to the browser when that is possible.
 *
 * Two situations save without applying, and both say so instead of failing
 * silently or pretending success:
 *   - the settings now require an endpoint the user has not entered yet
 *   - the browser proxy is owned by something else, so writing would either throw
 *     or be overwritten
 */
async function commit(nextSettings, message) {
  const merged = { ...settings, ...nextSettings };

  if (requiresProxyEndpoint(merged) && !isConfigured(merged)) {
    await saveSettings(nextSettings);
    renderRules();
    renderCurrentPage();
    renderModes();
    sendNotice(`${message} 已保存。但还没有填写代理服务器地址，所以浏览器代理尚未改变。`, "warning");
    return;
  }

  if (!activeMode) {
    await saveSettings(nextSettings);
    renderRules();
    renderCurrentPage();
    sendNotice(`${message} 已保存；浏览器代理由其他程序控制，因此没有覆盖它。`, "warning");
    return;
  }

  await applyMode(activeMode, nextSettings);
  sendNotice(`${message}。`, "success");
}

async function applyMode(mode, overrides = {}) {
  // Normalised strictly so an over-cap edit fails before the proxy is touched.
  // Throws RuleLimitError, leaving both storage and the browser proxy unchanged.
  const next = {
    ...settings,
    ...overrides,
    mode,
    whitelist: normalizeDomainEntriesStrict(overrides.whitelist ?? settings.whitelist),
    blacklist: normalizeDomainEntriesStrict(overrides.blacklist ?? settings.blacklist)
  };

  const proxyConfig = buildChromeProxyConfig(next);
  await chromeCall(chrome.proxy.settings, "set", {
    value: proxyConfig,
    scope: "regular"
  });
  await saveSettings(next);
  activeMode = mode;
  renderModes();
  renderRules();
  await readProxyState();
}

/** The shape stored as the next merge base: hosts and their subdomain flag only. */
function mergeBaseShape(entries) {
  return entries.map(({ host, includeSubdomains }) => ({ host, includeSubdomains }));
}

/**
 * Records hosts that this device removed, so the removal survives a merge.
 *
 * A merge cannot tell an absent rule from a deleted one, so deletions have to be
 * stated explicitly. Tombstones are dropped once the merged record has been
 * adopted, because after that the peer's base already reflects the removal.
 */
function noteRemovals(removed) {
  if (removed.length === 0) return;
  const existing = new Set(settings.syncTombstones ?? []);
  for (const host of removed) existing.add(host);
  settings = { ...settings, syncTombstones: [...existing] };
}

/** Everything that is synced and edited, and nothing that is only a preference flag. */
function contentShape(value) {
  return JSON.stringify({
    mode: value.mode,
    scheme: value.scheme,
    host: value.host,
    port: value.port,
    localBypass: value.localBypass !== false,
    whitelist: value.whitelist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains })),
    blacklist: value.blacklist.map(({ host, includeSubdomains }) => ({ host, includeSubdomains })),
    // A removal changes only the tombstone list, so it has to be part of the shape
    // or deleting a rule would never be uploaded.
    tombstones: [...(value.syncTombstones ?? [])].sort()
  });
}

const RULE_LABELS = Object.freeze({ blacklist: "代理黑名单", whitelist: "直连白名单" });

async function addDomainRule(type, host, includeSubdomains = true) {
  const normalized = createDomainEntry(host, includeSubdomains);
  const ownKey = type === "blacklist" ? "blacklist" : "whitelist";
  const otherKey = ownKey === "blacklist" ? "whitelist" : "blacklist";
  // Replace on the target list and drop from the other one, then let the shared
  // invariant settle any remaining overlap.
  const lists = reconcileRuleLists({
    whitelist: ownKey === "whitelist"
      ? [...settings.whitelist.filter((entry) => entry.host !== normalized.host), normalized]
      : settings.whitelist.filter((entry) => entry.host !== normalized.host),
    blacklist: ownKey === "blacklist"
      ? [...settings.blacklist.filter((entry) => entry.host !== normalized.host), normalized]
      : settings.blacklist.filter((entry) => entry.host !== normalized.host)
  });
  const next = { whitelist: lists.whitelist, blacklist: lists.blacklist };

  // applyMode persists and applies in one pass; saving here first would have
  // written storage twice and cost a second full tab refresh.
  await commit(next, `${normalized.host} 已加入${RULE_LABELS[type === "blacklist" ? "blacklist" : "whitelist"]}`);
  renderCurrentPage();
}

async function removeDomainRule(host, type) {
  const key = type === "blacklist" ? "blacklist" : "whitelist";
  const removed = settings[key].find((entry) => entry.host === host) ?? null;
  const nextEntries = settings[key].filter((entry) => entry.host !== host);
  if (nextEntries.length !== settings[key].length) noteRemovals([host]);
  await commit({ [key]: nextEntries }, `${host} 已从${RULE_LABELS[key]}移除`);
  renderCurrentPage();

  // Removing one rule is a single click on a small × and is easy to misfire. Offer the
  // way back instead of relying on the user remembering the exact host to retype.
  if (removed) {
    const restore = async () => {
      const current = settings[key].filter((entry) => entry.host !== removed.host);
      // Re-adding clears the tombstone implicitly: a rule present locally is not
      // something a peer's tombstone may suppress.
      settings.syncTombstones = (settings.syncTombstones ?? []).filter((name) => name !== removed.host);
      await commit({ [key]: [...current, removed] }, `${removed.host} 已恢复`);
      renderRules();
      renderCurrentPage();
    };
    sendNotice(`${host} 已从${RULE_LABELS[key]}移除`, "success", {
      label: "撤销",
      run: () => void restore()
    });
  }
}

async function clearActiveRules() {
  const key = activeRuleType === "blacklist" ? "blacklist" : "whitelist";
  const removed = [...settings[key]];
  if (removed.length === 0) return;

  // Clearing is a single click that destroys a whole list. Undo is offered afterwards
  // rather than a modal beforehand: a modal on every clear becomes a rubber stamp,
  // while undo catches the mistake when it actually happens.
  noteRemovals(removed.map((entry) => entry.host));
  await commit({ [key]: [] }, `${RULE_LABELS[key]}已清空`);
  renderRules();
  renderCurrentPage();

  const restore = async () => {
    const names = new Set(removed.map((entry) => entry.host));
    settings.syncTombstones = (settings.syncTombstones ?? []).filter((name) => !names.has(name));
    const current = settings[key].filter((entry) => !names.has(entry.host));
    await commit({ [key]: [...current, ...removed] }, `${RULE_LABELS[key]}已恢复 ${removed.length} 条`);
    renderRules();
    renderCurrentPage();
  };
  sendNotice(`已清空${RULE_LABELS[key]}（${removed.length} 条）`, "success", {
    label: "撤销",
    run: () => void restore()
  });
}

async function addCurrentRule(type) {
  if (!currentHostname) return;
  try {
    await addDomainRule(type, currentHostname, ui.includeSubdomains.checked);
  } catch (error) {
    reportRuleError(error);
  }
}

function requestTabsPermissionAndRun(action) {
  // This callback is invoked directly from a user click. Permission is optional;
  // rule changes work even if the user denies it.
  chrome.permissions.request({ permissions: ["tabs"] }, (granted) => {
    const permissionError = chrome.runtime.lastError;
    if (permissionError) {
      void action(false);
      return;
    }
    void action(granted);
  });
}

async function addManualRule() {
  const host = ui.ruleHostInput.value.trim();
  if (!host) {
    sendNotice("请先输入域名。", "error");
    return;
  }
  try {
    await addDomainRule(activeRuleType, host, ui.ruleIncludeSubdomains.checked);
    ui.ruleHostInput.value = "";
  } catch (error) {
    reportRuleError(error);
  }
}

async function connectProxy() {
  const config = { host: ui.host.value.trim(), port: ui.port.value.trim(), scheme: ui.scheme.value };
  try {
    const server = validateProxySettings(config);
    // Saving the endpoint always puts the browser in "proxy" mode: the user just
    // said "this is the server I want to use", so leaving them in "direct" would
    // make the save look like it did nothing.
    await applyMode("proxy", config);
    sendNotice(`已保存并启用 ${server.scheme}://${server.host}:${server.port}，Edge 的浏览器代理已切换为走这个地址。`, "success");
  } catch (error) {
    sendNotice(`连接设置未能应用：${error.message}`, "error");
  }
}

/**
 * Exports the current configuration to a downloaded file.
 *
 * object URLs rather than chrome.downloads: the extension does not request the
 * downloads permission, and an anchor click is enough for a user-initiated save.
 */
function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify(exportSettings(settings), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFilename();
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some Chromium versions.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    sendNotice(`已导出 ${countRules()} 条规则的备份文件。`, "success");
  } catch (error) {
    sendNotice(`导出失败：${error.message}`, "error");
  }
}

let pendingRestore = null;

/* ------------------------------------------------------------------ */
/* Cross-device sync                                                   */
/*                                                                     */
/* Opt-in by design: nothing is written to chrome.storage.sync until   */
/* the user turns it on. See src/sync.js for why the payload is split  */
/* and checksummed.                                                    */
/* ------------------------------------------------------------------ */

let syncEnabled = false;
let syncStatusText = null;
let syncTimer = null;
// The record last seen in the sync area. Comparing against it is what stops the
// two surfaces (popup and settings page) from re-uploading what they just read.
let lastSyncedShape = null;


/** Reads the opt-in flag and pushes the current settings if sync is on. */
async function uploadIfEnabled({ force = false } = {}) {
  if (!syncEnabled) return;
  // Adopting a synced record also writes settings, which schedules an upload. That
  // upload would push back exactly what was just read, and on every device at once.
  // Comparing against what we last saw in the sync area breaks the loop.
  if (!force && lastSyncedShape && !settingsDiffer(lastSyncedShape, settings)) {
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    return;
  }
  try {
    const generation = Date.now().toString(36);
    const deviceId = chrome.runtime.id.slice(0, 8);
    const { items } = buildSyncItems(settings, { generation, deviceId });

    // Read the area first so the previous generation's chunks can be removed in the
    // same operation. Left behind, they accumulate against the 512-item cap until
    // every write starts failing.
    const area = await chromeCall(chrome.storage.sync, "get", null);
    const stale = staleChunkKeys(area, generation);
    // META_KEY is written last: a reader that sees new metadata with old chunks
    // fails the checksum and keeps its local settings, which is the safe outcome.
    await chromeCall(chrome.storage.sync, "set", items);
    if (stale.length > 0) await chromeCall(chrome.storage.sync, "remove", stale);

    lastSyncedShape = { ...settings };
    syncStatusText = `已上传：${settings.whitelist.length + settings.blacklist.length} 条规则通过浏览器账号同步。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
  } catch (error) {
    // A quota or rate-limit failure must not be silent: the user turned sync on and
    // is entitled to know it is not working.
    syncStatusText = `上传失败：${error.message}。本机设置不受影响。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    sendNotice(syncStatusText, "error");
  }
}

// A peer writing several chunks produces several storage events. Coalescing them
// keeps one reconcile per burst instead of one per chunk.
let reconcileTimer = null;

function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileSync({ silent: true });
  }, 1200);
}

/** Debounced so a burst of rule edits becomes one upload. */
function scheduleUpload() {
  if (!syncEnabled) return;
  renderSyncPanel(ui, { enabled: true, pendingUpload: true });
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void uploadIfEnabled();
  }, 900);
}

/**
 * Applies the synced record on startup, then decides the direction of travel.
 *
 * Local wins when the two disagree and the local record is newer than the synced
 * one: the user may have edited this device while offline or before turning sync
 * on. Otherwise the synced record is adopted, because that is what "sync" means to
 * the person who just enabled it on a second machine.
 */
/**
 * Reconciles local settings with the sync area, then writes whichever side changed.
 *
 * There is deliberately **one** path here, not an "upload" path and an "adopt" path.
 * The previous version branched on a timestamp and, when local looked newer,
 * uploaded straight over the cloud record. Two devices that edited between uploads
 * therefore erased each other, last writer winning and the loser never told.
 *
 * Merging first makes both edits survive regardless of who wrote last. The decision
 * about *direction* still matters, but only for the handful of scalar fields, and
 * mergeSettings already resolves those by timestamp.
 */
async function reconcileSync({ silent = true } = {}) {
  let area;
  try {
    area = await chromeCall(chrome.storage.sync, "get", null);
  } catch (error) {
    syncStatusText = `无法读取浏览器同步存储：${error.message}。已改用本机设置。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    return;
  }

  const cloud = readSyncState(area);

  // Nothing usable in the cloud: this device becomes the source of truth.
  if (!cloud.ok) {
    syncStatusText = describeSyncStatus(cloud);
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    if (cloud.reason === "empty" || cloud.reason === "corrupt") {
      await uploadIfEnabled({ force: true });
    }
    return;
  }

  if (!settingsDiffer(cloud.settings, settings)) {
    lastSyncedShape = { ...settings };
    syncStatusText = `本机与同步数据一致（最后更新 ${new Date(cloud.meta.updatedAt).toLocaleString()}）。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    return;
  }

  let merged;
  try {
    merged = mergeSettings({ base: cloud.base, mine: settings, theirs: cloud.settings });
  } catch (error) {
    syncStatusText = `同步数据无法合并：${error.message}。本机设置保持不变。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    return;
  }

  // Tombstones are a fallback for the case where neither side carried a base: they
  // state deletions that a set merge cannot infer.
  merged.whitelist = withTombstones(merged.whitelist, settings.syncTombstones);
  merged.blacklist = withTombstones(merged.blacklist, settings.syncTombstones);

  const cloudChanged = settingsDiffer(merged, cloud.settings);
  const localChanged = settingsDiffer(merged, settings);

  if (localChanged) {
    try {
      const settled = reconcileRuleLists({ whitelist: merged.whitelist, blacklist: merged.blacklist });
      const whitelist = normalizeDomainEntriesStrict(settled.whitelist);
      const blacklist = normalizeDomainEntriesStrict(settled.blacklist);
      const adopted = {
        ...settings,
        ...merged,
        whitelist,
        blacklist,
        // The merge base is the cloud record this device just built on - NOT the
        // merged result. Advancing the base to the result would tell every peer
        // "anything in the result that you lack, you deleted", which is how B's
        // rules disappeared from A on the next reconcile.
        syncBase: {
          whitelist: mergeBaseShape(cloud.settings.whitelist),
          blacklist: mergeBaseShape(cloud.settings.blacklist)
        },
        syncTombstones: [],
        updatedAt: Date.now()
      };
      if (requiresProxyEndpoint(adopted) && !isConfigured(adopted)) {
        await saveSettings(adopted);
      } else if (activeMode) {
        await applyMode(adopted.mode, adopted);
      } else {
        await saveSettings(adopted);
      }
      renderConnectionFields(ui, settings);
      renderModes();
      renderRules();
      renderCurrentPage();
    } catch (error) {
      syncStatusText = `同步数据无法应用：${error.message}。本机设置保持不变。`;
      renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
      return;
    }
  }

  const total = settings.whitelist.length + settings.blacklist.length;
  if (cloudChanged) {
    // Upload announces the base it merged against; uploadIfEnabled reads it from
    // settings.syncBase, which was just set to the pre-merge cloud state above.
    await uploadIfEnabled({ force: true });
    syncStatusText = `已合并并上传：本机 ${total} 条规则。`;
    renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
    if (localChanged) sendNotice(`已合并两边的改动，共 ${total} 条规则。`, "success");
    return;
  }

  lastSyncedShape = { ...settings };
  syncStatusText = localChanged
    ? `已从其他设备同步：本机现共 ${total} 条规则。`
    : `本机与同步数据一致（最后更新 ${new Date(cloud.meta.updatedAt).toLocaleString()}）。`;
  renderSyncPanel(ui, { enabled: true, status: syncStatusText, pendingUpload: false });
  if (localChanged && !silent) sendNotice(syncStatusText, "success");
}

async function setSyncEnabled(enabled) {
  syncEnabled = Boolean(enabled);
  await saveSettings({ syncEnabled });
  if (!syncEnabled) {
    syncStatusText = null;
    renderSyncPanel(ui, { enabled: false, status: null, pendingUpload: false });
    sendNotice("已关闭跨设备同步。之前同步的数据仍留在浏览器账号里，可在设置中说明的方式清除；本机设置不受影响。", "warning");
    return;
  }
  renderSyncPanel(ui, { enabled: true, status: "正在检查同步数据…", pendingUpload: false });
  sendNotice("已开启跨设备同步。只同步设置和域名规则，不同步浏览数据。", "success");
  await reconcileSync({ silent: true });
}

/** Reads the chosen file and previews what importing it would do. Never applies. */
async function previewRestore(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const result = planImport(text, { normalize: normalizeDomainEntriesStrict });
    if (!result.ok) {
      pendingRestore = null;
      clearRestorePlan(ui);
      sendNotice(result.error, "error");
      return;
    }
    pendingRestore = result.plan;
    renderRestorePlan(ui, result.plan);
    sendNotice("已读取备份文件，确认下面的内容后才会替换当前设置。", "warning");
  } catch (error) {
    pendingRestore = null;
    clearRestorePlan(ui);
    sendNotice(`读取文件失败：${error.message}`, "error");
  }
}

async function applyRestore() {
  if (!pendingRestore) return;
  const plan = pendingRestore;
  pendingRestore = null;
  clearRestorePlan(ui);
  try {
    // The endpoint may be absent from an older file. Saving it as-is is correct:
    // the UI already reports "未配置" and refuses to pretend the proxy is applied.
    if (requiresProxyEndpoint(plan.settings) && !isConfigured(plan.settings)) {
      await saveSettings(plan.settings);
      renderConnectionFields(ui, settings);
      renderModes();
      renderRules();
      renderCurrentPage();
      sendNotice("备份已恢复，但文件里没有代理地址或端口，请自己填一下才会生效。", "warning");
      return;
    }
    await applyMode(plan.settings.mode, plan.settings);
    renderConnectionFields(ui, settings);
    sendNotice(`备份已恢复：白名单 ${plan.counts.whitelist} 条、黑名单 ${plan.counts.blacklist} 条。`, "success");
  } catch (error) {
    reportRuleError(error);
  }
}

async function toggleLocalBypass() {
  const enabled = ui.localBypassToggle.checked;
  renderLocalBypass(ui, enabled);
  try {
    await commit({ localBypass: enabled }, enabled ? "本机地址直连已开启" : "本机地址直连已关闭");
  } catch (error) {
    renderLocalBypass(ui, !enabled);
    reportRuleError(error);
  }
}

async function initialize() {
  try {
    await loadSettings();
    switchRuleType("whitelist");
    renderStatusPermission();
    renderLocalBypass(ui, true);
    renderModes();
    await inspectCurrentPage();
    await readProxyState();
    switchView(activeView);
    if (syncEnabled) await reconcileSync({ silent: true });
  } catch (error) {
    sendNotice(`插件初始化失败：${error.message}`, "error");
  }

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mode = button.dataset.mode;
      try {
        // Selecting "走代理服务器" before an address exists is a save, not a
        // failure: record the intent, say plainly that nothing was applied, and
        // let the user fill the address in. Throwing here would report an error
        // for an action the user is entitled to take at any point.
        if (mode === "proxy" && !isConfigured(settings)) {
          await saveSettings({ mode });
          renderModes();
          sendNotice("已选择走代理服务器。填好下方地址和端口并保存后才会真正生效。", "warning");
          return;
        }
        await applyMode(mode);
        sendNotice(
          mode === "proxy"
            ? "已切换为走代理服务器。"
            : "已切换为浏览器全局直连（黑名单仍强制走代理）。",
          "success"
        );
      } catch (error) {
        sendNotice(`切换失败：${error.message}`, "error");
      }
    });
  });

  ui.viewButtons.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  ui.whitelistTab.addEventListener("click", () => switchRuleType("whitelist"));
  ui.blacklistTab.addEventListener("click", () => switchRuleType("blacklist"));
  ui.ruleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    requestTabsPermissionAndRun(() => addManualRule());
  });
  ui.ruleSearch.addEventListener("input", () => {
    ruleSearch = ui.ruleSearch.value;
    renderRules();
  });
  ui.ruleSort.addEventListener("change", () => {
    ruleSort = ui.ruleSort.value === "name" ? "name" : "recent";
    renderRules();
  });
  ui.ruleGroup.addEventListener("change", () => {
    ruleGrouped = ui.ruleGroup.checked;
    // A grouping preference is a view choice, so it is deliberately not persisted:
    // it must never look like an edit that would advance updatedAt and trigger an
    // upload to other devices.
    renderRules();
  });
  ui.clearRules.addEventListener("click", () => {
    void clearActiveRules().catch(reportRuleError);
  });
  ui.localBypassToggle.addEventListener("change", () => {
    void toggleLocalBypass();
  });

  // The add form is folded away on this view; keeping focus in the host field when it
  // opens is what makes the extra click worth it.
  ui.toggleAddRule.addEventListener("click", () => {
    const open = ui.ruleAddArea.hidden;
    ui.ruleAddArea.hidden = !open;
    ui.toggleAddRule.setAttribute("aria-expanded", String(open));
    ui.toggleAddRule.textContent = open ? "收起" : "＋ 添加";
    if (open) ui.ruleHostInput.focus();
  });

  ui.statusPermissionButton.addEventListener("click", () => {
    chrome.permissions.request({ permissions: ["tabs"] }, (granted) => {
      if (!granted) {
        sendNotice("未授予标签页权限。域名规则仍可用，但工具栏无法逐网页更新图标。", "warning");
        renderStatusPermission();
        return;
      }
      renderStatusPermission();
      chrome.runtime.sendMessage({ type: "SYNC_ALL_TABS" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          sendNotice("权限已启用，但标签页图标同步失败；请重新打开面板重试。", "error");
          return;
        }
        sendNotice("已启用逐网页状态图标。", "success");
      });
    });
  });

  ui.saveConnect.addEventListener("click", () => {
    void connectProxy();
  });
  ui.pasteAddressButton.addEventListener("click", () => {
    applyPastedAddress(ui, ui.pasteAddress.value);
  });
  ui.pasteAddress.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyPastedAddress(ui, ui.pasteAddress.value);
  });
  renderPortSuggestions(ui, (port, hint) => {
    ui.port.value = port;
    if (!ui.host.value.trim()) ui.host.value = "127.0.0.1";
    ui.pasteAddressHint.hidden = false;
    ui.pasteAddressHint.className = "microcopy";
    ui.pasteAddressHint.textContent = `${port}：${hint}。这只是常见默认值，请对照你的代理软件确认后再保存。`;
  });
  renderTroubleshooting(ui);
  ui.syncEnable.addEventListener("click", () => {
    void setSyncEnabled(true).catch((error) => sendNotice(`开启同步失败：${error.message}`, "error"));
  });
  ui.syncDisable.addEventListener("click", () => {
    void setSyncEnabled(false).catch((error) => sendNotice(`关闭同步失败：${error.message}`, "error"));
  });
  ui.syncNow.addEventListener("click", () => {
    // Explicit user action: upload even if the shapes look equal, because the user
    // may be repairing a sync area they cleared or corrupted.
    void uploadIfEnabled({ force: true });
  });
  ui.exportBackup.addEventListener("click", exportBackup);
  ui.importBackup.addEventListener("click", () => ui.importBackupFile.click());
  ui.importBackupFile.addEventListener("change", () => {
    void previewRestore(ui.importBackupFile.files?.[0]);
  });
  ui.confirmRestore.addEventListener("click", () => {
    void applyRestore();
  });
  ui.cancelRestore.addEventListener("click", () => {
    pendingRestore = null;
    clearRestorePlan(ui);
  });
  ui.openSettings.addEventListener("click", async () => {
    try {
      if (fullPageMode) {
        const currentTab = await chromeCall(chrome.tabs, "getCurrent");
        if (currentTab?.id != null) await chromeCall(chrome.tabs, "remove", currentTab.id);
        else window.close();
        return;
      }
      const currentTab = await getCurrentTab();
      const params = new URLSearchParams({ full: "1" });
      if (currentTab?.id != null) params.set("sourceTabId", String(currentTab.id));
      await chromeCall(chrome.tabs, "create", {
        url: chrome.runtime.getURL(`src/popup.html?${params.toString()}`)
      });
    } catch (error) {
      sendNotice(`无法打开完整设置：${error.message}`, "error");
    }
  });
  ui.addCurrentDirect.addEventListener("click", () => {
    requestTabsPermissionAndRun(() => addCurrentRule("whitelist"));
  });
  ui.addCurrentProxy.addEventListener("click", () => {
    requestTabsPermissionAndRun(() => addCurrentRule("blacklist"));
  });
  ui.removeCurrentRule.addEventListener("click", async () => {
    if (!currentHostname) return;
    try {
      if (settings.blacklist.some((entry) => entry.host === currentHostname)) {
        await removeDomainRule(currentHostname, "blacklist");
      }
      if (settings.whitelist.some((entry) => entry.host === currentHostname)) {
        await removeDomainRule(currentHostname, "whitelist");
      }
    } catch (error) {
      reportRuleError(error);
    }
  });
  ui.includeSubdomains.addEventListener("change", () => {
    void saveSettings({ includeSubdomains: ui.includeSubdomains.checked })
      .catch((error) => sendNotice(`保存选项失败：${error.message}`, "error"));
  });

  startWatchingOtherSurface();
}

/**
 * Keeps this surface in sync when the other one writes settings.
 *
 * Both the toolbar popup and the full settings page can be open at once, and they
 * share one settings record. Without this, an edit on one surface left the other
 * showing stale rules and a stale current-site route until it was reopened.
 *
 * The listener only re-reads and re-renders. It never writes, so there is no
 * feedback loop between the two surfaces.
 */
function startWatchingOtherSurface() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    // The sync area changing means another device wrote, or this one did a moment
    // ago. Re-rendering storage here would be wrong - it needs a merge, not a
    // render - so the handler only updates the status line. Pulling on every event
    // would also mean a reconcile per keystroke on a peer.
    if (areaName === "sync") {
      if (syncEnabled) scheduleReconcile();
      return;
    }
    if (areaName !== "local" || !changes.settings) return;
    let migrated;
    try {
      migrated = migrateStoredSettings(changes.settings.newValue).settings;
      normalizeDomainEntriesStrict(migrated.whitelist);
      normalizeDomainEntriesStrict(migrated.blacklist);
    } catch {
      // Another surface persisted something invalid; leave the UI as it is rather
      // than rendering a half-applied state.
      return;
    }
    settings = migrated;
    renderModes();
    renderConnectionFields(ui, settings);
    renderRules();
    renderCurrentPage();
  });
}

// The service worker coalesces proxy and storage events into one refresh shortly
// after they arrive. When the popup closes right after an edit, ask for an
// immediate sync so the toolbar icon never stays on the previous state.
window.addEventListener("pagehide", () => {
  try {
    chrome.runtime.sendMessage({ type: "SYNC_ALL_TABS" });
  } catch {
    // The worker may already be idle; the coalesced refresh still covers it.
  }
});

initialize();
