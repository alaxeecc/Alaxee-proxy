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
  normalizeDomainEntriesStrict,
  validateProxySettings
} from "./core.js";
import {
  createUi,
  renderConnectionFields,
  renderCurrentPage as renderCurrentPageView,
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
let activeMode = "clash";
let activeView = "overview";
let activeRuleType = "whitelist";
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
  renderModesView(ui, activeMode);
}

function renderRules() {
  renderRulesView(ui, {
    settings,
    activeRuleType,
    onRemove: (host, type) => {
      void removeDomainRule(host, type).catch(reportRuleError);
    }
  });
}

function renderStatusPermission() {
  chrome.permissions.contains({ permissions: ["tabs"] }, (granted) => {
    renderStatusPermissionView(ui, Boolean(granted));
  });
}

function syncRuleCounts() {
  renderRuleCounts(ui, settings, activeRuleType);
}

function getRuleList(type) {
  return type === "blacklist" ? settings.blacklist : settings.whitelist;
}

function countRules() {
  return settings.whitelist.length + settings.blacklist.length;
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
  const raw = stored?.settings ?? {};
  settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    whitelist: normalizeWhitelist(raw.whitelist),
    blacklist: normalizeBlacklist(raw.blacklist)
  };
  activeMode = ["clash", "direct", "system"].includes(settings.mode) ? settings.mode : "clash";
  renderConnectionFields(ui, settings);
  renderRules();
  renderModes();
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

async function persistWithoutApplying(nextSettings, message) {
  await saveSettings(nextSettings);
  renderRules();
  renderCurrentPage();
  if (activeMode === "system") {
    sendNotice(`${message} 已保存；当前为系统代理模式，规则暂不生效。`, "warning");
  } else {
    sendNotice(`${message} 已保存。`, "success");
  }
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

  if (activeMode === "system" || !activeMode) {
    await persistWithoutApplying(
      next,
      `${normalized.host} 的${type === "blacklist" ? "代理黑名单" : "直连白名单"}规则`
    );
    if (!activeMode) {
      sendNotice(`${normalized.host} 的规则已保存在本机，但浏览器代理正由其他程序控制，Alaxee Proxy 没有覆盖它。`, "warning");
    }
  } else {
    // applyMode persists and applies in one pass; saving here first would have
    // written storage twice and cost a second full tab refresh.
    await applyMode(activeMode, next);
    sendNotice(`${normalized.host} 已加入${type === "blacklist" ? "代理黑名单" : "直连白名单"}。`, "success");
  }
  renderCurrentPage();
}

async function removeDomainRule(host, type) {
  const key = type === "blacklist" ? "blacklist" : "whitelist";
  const nextEntries = settings[key].filter((entry) => entry.host !== host);
  const message = `${host} 已从${type === "blacklist" ? "代理黑名单" : "直连白名单"}移除`;
  if (activeMode === "system" || !activeMode) {
    await persistWithoutApplying({ [key]: nextEntries }, message);
    if (!activeMode) sendNotice(`${message}。代理设置由其他程序控制，因此没有更改浏览器代理。`, "warning");
  } else {
    await applyMode(activeMode, { [key]: nextEntries });
    sendNotice(`${message}。`, "success");
  }
  renderCurrentPage();
}

async function clearActiveRules() {
  const key = activeRuleType === "blacklist" ? "blacklist" : "whitelist";
  const next = { [key]: [] };
  if (activeMode === "system" || !activeMode) {
    await persistWithoutApplying(next, activeRuleType === "blacklist" ? "代理黑名单已清空" : "直连白名单已清空");
    if (!activeMode) sendNotice("规则已清空；当前浏览器代理由其他程序控制，未更改其设置。", "warning");
  } else {
    await applyMode(activeMode, next);
    sendNotice(activeRuleType === "blacklist" ? "代理黑名单已清空。" : "直连白名单已清空。", "success");
  }
  renderCurrentPage();
}

async function addCurrentRule(type, permissionResult = true) {
  if (!currentHostname) return;
  try {
    await addDomainRule(type, currentHostname, ui.includeSubdomains.checked);
    if (permissionResult === false) {
      sendNotice("规则已保存，但未启用逐网页图标权限；工具栏暂时无法逐网页区分代理状态。", "warning");
    }
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

async function addManualRule(tabsPermissionGranted = null) {
  const host = ui.ruleHostInput.value.trim();
  if (!host) {
    sendNotice("请先输入域名。", "error");
    return;
  }
  try {
    await addDomainRule(activeRuleType, host, ui.ruleIncludeSubdomains.checked);
    ui.ruleHostInput.value = "";
    if (tabsPermissionGranted === false) {
      sendNotice("规则已保存；但逐网页图标权限未开启，工具栏暂时显示未知状态。", "warning");
    }
  } catch (error) {
    reportRuleError(error);
  }
}

async function connectClash() {
  const config = { host: ui.host.value, port: ui.port.value, scheme: ui.scheme.value };
  try {
    validateProxySettings(config);
    await applyMode("clash", config);
    sendNotice("Clash 地址和端口已保存，代理规则已应用到 Edge。", "success");
  } catch (error) {
    sendNotice(`连接设置未能应用：${error.message}`, "error");
  }
}

async function initialize() {
  try {
    await loadSettings();
    switchRuleType("whitelist");
    renderStatusPermission();
    renderModes();
    await inspectCurrentPage();
    await readProxyState();
    switchView(activeView);
  } catch (error) {
    sendNotice(`插件初始化失败：${error.message}`, "error");
  }

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await applyMode(button.dataset.mode);
        const message = button.dataset.mode === "clash"
          ? "已切换到 Clash 代理。"
          : button.dataset.mode === "direct"
            ? "已切换为浏览器全局直连（黑名单仍强制经 Clash）。"
            : "已切换为跟随系统代理；域名规则暂不生效。";
        sendNotice(message, "success");
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
    requestTabsPermissionAndRun((granted) => addManualRule(granted));
  });
  ui.clearRules.addEventListener("click", () => {
    void clearActiveRules().catch(reportRuleError);
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

  ui.saveConnect.addEventListener("click", connectClash);
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
    requestTabsPermissionAndRun((granted) => addCurrentRule("whitelist", granted));
  });
  ui.addCurrentProxy.addEventListener("click", () => {
    requestTabsPermissionAndRun((granted) => addCurrentRule("blacklist", granted));
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
    const stored = changes.settings.newValue ?? {};
    let whitelist;
    let blacklist;
    try {
      whitelist = normalizeDomainEntriesStrict(stored.whitelist);
      blacklist = normalizeDomainEntriesStrict(stored.blacklist);
    } catch {
      // Another surface persisted something invalid; leave the UI as it is rather
      // than rendering a half-applied state.
      return;
    }
    settings = { ...DEFAULT_SETTINGS, ...stored, whitelist, blacklist };
    if (["clash", "direct", "system"].includes(settings.mode)) activeMode = settings.mode;
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
