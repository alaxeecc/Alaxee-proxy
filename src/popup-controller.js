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
  requiresProxyEndpoint,
  validateProxySettings
} from "./core.js";
import {
  createUi,
  renderConnectionFields,
  renderCurrentPage as renderCurrentPageView,
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

function renderRules() {
  renderRulesView(ui, {
    settings,
    activeRuleType,
    search: ruleSearch,
    sort: ruleSort,
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

function sendNotice(message, kind = "success") {
  noticeTimer?.();
  noticeTimer = showNotice(ui, message, kind);
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

  renderConnectionFields(ui, settings);
  renderRules();
  renderModes();

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
  settings = { ...settings, ...nextSettings, whitelist, blacklist };
  await chromeCall(chrome.storage.local, "set", { settings });
  syncRuleCounts();
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

const RULE_LABELS = Object.freeze({ blacklist: "代理黑名单", whitelist: "直连白名单" });

async function addDomainRule(type, host, includeSubdomains = true) {
  const normalized = createDomainEntry(host, includeSubdomains);
  const ownKey = type === "blacklist" ? "blacklist" : "whitelist";
  const otherKey = ownKey === "blacklist" ? "whitelist" : "blacklist";
  const ownEntries = settings[ownKey].filter((entry) => entry.host !== normalized.host);
  const otherEntries = settings[otherKey].filter((entry) => entry.host !== normalized.host);
  const next = {
    [ownKey]: [...ownEntries, normalized],
    [otherKey]: otherEntries
  };

  // applyMode persists and applies in one pass; saving here first would have
  // written storage twice and cost a second full tab refresh.
  await commit(next, `${normalized.host} 已加入${RULE_LABELS[type === "blacklist" ? "blacklist" : "whitelist"]}`);
  renderCurrentPage();
}

async function removeDomainRule(host, type) {
  const key = type === "blacklist" ? "blacklist" : "whitelist";
  const nextEntries = settings[key].filter((entry) => entry.host !== host);
  await commit({ [key]: nextEntries }, `${host} 已从${RULE_LABELS[key]}移除`);
  renderCurrentPage();
}

async function clearActiveRules() {
  const key = activeRuleType === "blacklist" ? "blacklist" : "whitelist";
  await commit({ [key]: [] }, `${RULE_LABELS[key]}已清空`);
  renderCurrentPage();
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
  ui.clearRules.addEventListener("click", () => {
    void clearActiveRules().catch(reportRuleError);
  });
  ui.localBypassToggle.addEventListener("change", () => {
    void toggleLocalBypass();
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
