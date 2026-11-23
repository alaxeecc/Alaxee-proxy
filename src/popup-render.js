/**
 * Pure DOM rendering for the popup and the full settings page.
 *
 * Every function here takes its inputs explicitly and only touches the DOM
 * through the `ui` table passed in. Nothing reads chrome.* APIs, storage, or
 * module-level mutable state.
 *
 * That separation is the point of the split: in the single-file version,
 * rendering was interleaved with proxy writes and hidden behind global
 * variables, so no rendering behaviour could be asserted without a live browser.
 * With explicit inputs, the route and label logic below is testable directly.
 *
 * State and chrome.* calls live in popup-controller.js.
 */
import { describeImportPlan } from "./backup.js";
import {
  COMMON_PROXY_PORTS,
  ENDPOINT_TROUBLESHOOTING,
  describeProxyEndpoint,
  isConfigured,
  isHostBlacklisted,
  isHostWhitelisted,
  isLocalHost,
  parseProxyAddress,
  resolveTabRoute
} from "./core.js";

export const ROUTE_LABELS = Object.freeze({
  proxy: "交给代理",
  direct: "浏览器直连",
  unknown: "状态未知"
});

const ROUTE_CLASSES = Object.freeze({
  proxy: "route-proxy",
  direct: "route-good",
  unknown: "route-unknown"
});

/** Builds the element lookup table. Ids are stable for the document's lifetime. */
export function createUi() {
  const $ = (id) => document.getElementById(id);
  return {
    statePill: $("statePill"),
    stateText: $("stateText"),
    modeHelp: $("modeHelp"),
    endpointLine: $("endpointLine"),
    endpointTag: $("endpointTag"),
    scheme: $("schemeInput"),
    host: $("hostInput"),
    port: $("portInput"),
    saveConnect: $("saveConnectButton"),
    currentHost: $("currentHost"),
    currentRoute: $("currentRoute"),
    routePill: $("siteRoutePill"),
    includeSubdomains: $("includeSubdomainsInput"),
    addCurrentDirect: $("addCurrentDirectButton"),
    addCurrentProxy: $("addCurrentProxyButton"),
    removeCurrentRule: $("removeCurrentRuleButton"),
    siteHint: $("siteHint"),
    notice: $("notice"),
    openSettings: $("openSettingsButton"),
    configPanel: $("configPanel"),
    ruleAddArea: $("ruleAddArea"),
    toggleAddRule: $("toggleAddRuleButton"),
    bypassPanel: $("bypassPanel"),
    statusPermissionButton: $("statusPermissionButton"),
    statusPermissionHint: $("statusPermissionHint"),
    brandMark: $("brandMark"),
    totalRuleCount: $("totalRuleCount"),
    overviewView: $("overviewView"),
    rulesView: $("rulesView"),
    viewButtons: [...document.querySelectorAll("[data-view]")],
    whitelistTab: $("whitelistTab"),
    blacklistTab: $("blacklistTab"),
    ruleDescription: $("ruleDescription"),
    ruleForm: $("ruleForm"),
    ruleHostInput: $("ruleHostInput"),
    ruleIncludeSubdomains: $("ruleIncludeSubdomainsInput"),
    addRuleButton: $("addRuleButton"),
    activeRuleTitle: $("activeRuleTitle"),
    ruleList: $("rulesList"),
    ruleEmpty: $("rulesEmpty"),
    ruleNoMatch: $("rulesNoMatch"),
    ruleCount: $("listCount"),
    clearRules: $("clearRulesButton"),
    ruleSearch: $("ruleSearch"),
    ruleSort: $("ruleSort"),
    ruleGroup: $("ruleGroupToggle"),
    pasteAddress: $("pasteAddressInput"),
    portSuggestions: $("portSuggestions"),
    pasteAddressButton: $("pasteAddressButton"),
    pasteAddressHint: $("pasteAddressHint"),
    troubleshootList: $("troubleshootList"),
    exportBackup: $("exportBackupButton"),
    importBackup: $("importBackupButton"),
    importBackupFile: $("importBackupFile"),
    restorePreview: $("restorePreview"),
    restoreSummary: $("restoreSummary"),
    confirmRestore: $("confirmRestoreButton"),
    syncPanel: $("syncPanel"),
    syncTag: $("syncTag"),
    syncPrivacy: $("syncPrivacy"),
    syncStatus: $("syncStatus"),
    syncEnable: $("syncEnableButton"),
    syncDisable: $("syncDisableButton"),
    syncNow: $("syncNowButton"),
    cancelRestore: $("cancelRestoreButton"),
    localBypassToggle: $("localBypassToggle"),
    bypassWarning: $("bypassWarning"),
    bypassTag: $("bypassTag")
  };
}

/* -------------------------------------------------------------------------- */
/* Notice                                                                     */
/* -------------------------------------------------------------------------- */

/** Returns a cancel function so a newer notice can replace the pending timer. */
export function showNotice(ui, message, kind, timers = globalThis, action = null) {
  ui.notice.textContent = message;
  ui.notice.className = `notice notice-${kind}`;
  ui.notice.hidden = false;
  // A message the user can act on needs time to read and decide. 4.6s is enough to
  // notice a confirmation, not enough to notice a mistake and reach for undo.
  const lifetime = action ? 9000 : 4600;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notice-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      ui.notice.hidden = true;
      cancel();
      action.run();
    });
    ui.notice.append(button);
  }
  const handle = timers.setTimeout(() => {
    ui.notice.hidden = true;
  }, lifetime);
  const cancel = () => timers.clearTimeout(handle);
  return cancel;
}

/* -------------------------------------------------------------------------- */
/* Current page                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Message shown under the hostname, given the resolved route and rule hits.
 *
 * The local case is stated before the rule hits because "this address can only
 * mean your own machine" is a stronger and more useful explanation than "you have
 * a rule for it" when both happen to be true.
 */
export function describeRoute(route, { whitelisted, blacklisted, local }) {
  if (local && route === "direct") {
    return "这是本机或局域网地址，浏览器会直接连接，不经过代理服务器。";
  }
  switch (route) {
    case "proxy":
      return blacklisted
        ? "此网站命中代理黑名单，浏览器请求会强制交给代理服务器。"
        : "此网站未命中直连白名单，浏览器请求会交给代理服务器处理。";
    case "direct":
      return whitelisted
        ? "此网站命中直连白名单，浏览器请求会绕过浏览器代理。"
        : "当前浏览器处于全局直连模式，所有网站都会直接连接。";
    default:
      return "无法确认此网站的浏览器代理路由；可能由其他扩展或管理策略接管。";
  }
}

/**
 * Hint below the action buttons for the current page.
 *
 * An unknown route is checked first: when the browser's proxy configuration is not
 * one this extension wrote, the whitelist and blacklist are not in force, so
 * claiming "this site will skip the proxy" would be false even though the rule
 * lookup itself succeeds.
 */
export function describeSiteHint(route, { whitelisted, blacklisted, local }) {
  if (route === "unknown") {
    return "浏览器代理当前不由本扩展控制，因此这里的规则不会生效。切换上方任一模式即可重新接管。";
  }
  if (local && route === "direct") {
    return "本机地址始终直连；如需让它走代理，请在代理黑名单里加入它。";
  }
  if (blacklisted) return "当前命中代理黑名单；即使同时匹配上级白名单，也会优先交给代理服务器。";
  if (whitelisted) return "当前命中直连白名单；浏览器会跳过代理服务器。";
  return "白名单让网站直连；代理黑名单让网站强制走代理。重叠时黑名单优先。";
}

/**
 * Renders the current-website card and the brand mark.
 *
 * @param {object} ui
 * @param {{currentTabUrl: string, currentHostname: string|null, settings: object, proxyState: object|null}} view
 * @returns {string} the resolved route, for callers that need it
 */
export function renderCurrentPage(ui, { currentTabUrl, currentHostname, settings, proxyState }) {
  const route = resolveTabRoute(currentTabUrl, proxyState, settings);
  const facts = {
    whitelisted: Boolean(currentHostname && isHostWhitelisted(currentHostname, settings.whitelist)),
    blacklisted: Boolean(currentHostname && isHostBlacklisted(currentHostname, settings.blacklist)),
    local: Boolean(currentHostname && isLocalHost(currentHostname))
  };
  const whitelistExact = Boolean(currentHostname && settings.whitelist.some((entry) => entry.host === currentHostname));
  const blacklistExact = Boolean(currentHostname && settings.blacklist.some((entry) => entry.host === currentHostname));

  ui.brandMark.dataset.route = route;
  ui.brandMark.setAttribute("aria-label", `当前页面状态：${ROUTE_LABELS[route]}`);
  ui.routePill.textContent = ROUTE_LABELS[route];
  ui.routePill.className = `route-pill ${ROUTE_CLASSES[route]}`;

  if (!currentHostname) {
    ui.currentHost.textContent = "当前页面不可用";
    ui.currentRoute.textContent = "请打开普通 HTTP 或 HTTPS 网站后再查看网页路由。";
    ui.addCurrentDirect.disabled = true;
    ui.addCurrentProxy.disabled = true;
    ui.removeCurrentRule.hidden = true;
    ui.includeSubdomains.disabled = true;
    ui.siteHint.textContent = "浏览器内部页面不属于普通网站，无法加入域名规则。";
    return route;
  }

  ui.currentHost.textContent = currentHostname;
  ui.currentRoute.textContent = describeRoute(route, facts);

  // Disable the add buttons when the host is already covered by any rule,
  // including a parent domain's subdomain rule. Checking exact equality only
  // left the button active on a subdomain the UI was simultaneously reporting as
  // whitelisted, which invited duplicate entries.
  ui.addCurrentDirect.disabled = facts.whitelisted;
  ui.addCurrentProxy.disabled = facts.blacklisted;

  // Removal is only offered for a rule that matches this host verbatim, because
  // the button deletes by exact host and would otherwise do nothing visible.
  ui.removeCurrentRule.hidden = !whitelistExact && !blacklistExact;
  ui.includeSubdomains.disabled = facts.whitelisted || facts.blacklisted;
  ui.siteHint.textContent = describeSiteHint(route, facts);
  return route;
}

/* -------------------------------------------------------------------------- */
/* Mode and endpoint                                                          */
/* -------------------------------------------------------------------------- */

export function describeModeHelp(activeMode, settings) {
  const configured = isConfigured(settings);
  if (activeMode === "proxy") {
    return configured
      ? "普通网站交给代理服务器；白名单网站直连，代理黑名单网站强制走代理。"
      : "还没有填写代理服务器地址，这条模式暂时不会生效。先在下方填好地址和端口。";
  }
  if (activeMode === "direct") {
    return "默认网站直接连接；代理黑名单是例外，会强制走代理服务器。";
  }
  return "当前浏览器代理设置无法识别。你仍可在这里选择一个模式接管 Edge。";
}

/** The endpoint summary under the mode buttons. */
export function renderEndpointLine(ui, settings) {
  ui.endpointLine.textContent = describeProxyEndpoint(settings);
  ui.endpointLine.classList.toggle("is-unset", !isConfigured(settings));
}

/** The small "未配置 / 已配置" tag in the server card heading. */
export function renderEndpointTag(ui, settings) {
  const configured = isConfigured(settings);
  // The panel collapses, so this tag is the only thing visible when it is shut. It
  // shows the current endpoint rather than just "configured", otherwise the user has
  // to open the panel to read a value that never changes.
  // host:port rather than a full URL: at 380px the scheme prefix costs 60px and the
  // value is the first thing to overflow the summary. The scheme is one click away.
  ui.endpointTag.textContent = configured ? `${settings.host}:${settings.port}` : "未配置";
  ui.endpointTag.title = configured
    ? `${settings.scheme}://${settings.host}:${settings.port}`
    : "还没有填写代理服务器地址";
  ui.endpointTag.parentElement.dataset.state = configured ? "set" : "unset";
}

/**
 * Keeps a collapsed panel honest.
 *
 * Collapsing is only safe if the reason to open the panel is visible from the
 * summary. A panel that needs attention therefore gets a marker, and - when the
 * extension ships with no endpoint at all - the setup panel opens itself.
 */
export function renderCollapsedPanels(ui, settings) {
  const configPanel = ui.configPanel;
  if (configPanel) {
    const needsSetup = !isConfigured(settings);
    configPanel.classList.toggle("needs-attention", needsSetup);
    // Opening on a first run is not a nudge, it is the only actionable thing on the
    // screen. Once a value is stored it stays closed unless the user opens it.
    if (needsSetup) configPanel.open = true;
  }
  const bypassPanel = ui.bypassPanel;
  if (bypassPanel) {
    // The bypass switch is on by default and turning it off is the risky direction,
    // so that is what the collapsed summary has to flag.
    bypassPanel.classList.toggle("needs-attention", settings.localBypass === false);
  }
}

export function renderModes(ui, activeMode, settings) {
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === activeMode));
  }
  ui.modeHelp.textContent = describeModeHelp(activeMode, settings);
}

/* -------------------------------------------------------------------------- */
/* Views and rule tabs                                                        */
/* -------------------------------------------------------------------------- */

export function renderViewSwitch(ui, activeView) {
  ui.overviewView.hidden = activeView !== "overview";
  ui.rulesView.hidden = activeView !== "rules";
  for (const button of ui.viewButtons) {
    if (button.dataset.view === activeView) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

export function renderRuleTab(ui, activeRuleType) {
  const isBlacklist = activeRuleType === "blacklist";
  ui.whitelistTab.setAttribute("aria-pressed", String(!isBlacklist));
  ui.blacklistTab.setAttribute("aria-pressed", String(isBlacklist));
  ui.activeRuleTitle.textContent = isBlacklist ? "代理黑名单" : "直连白名单";
  ui.ruleDescription.textContent = isBlacklist
    ? "命中的网站会强制通过代理服务器，即使它也匹配某条上级直连白名单。"
    : "命中的网站会绕过浏览器代理，直接连接。";
  ui.ruleHostInput.placeholder = isBlacklist ? "force-proxy.example.com" : "direct.example.com";
  ui.addRuleButton.textContent = isBlacklist ? "添加代理规则" : "添加直连规则";
}

/* -------------------------------------------------------------------------- */
/* Rule list                                                                  */
/* -------------------------------------------------------------------------- */

export function ruleEntries(settings, activeRuleType) {
  return activeRuleType === "blacklist" ? settings.blacklist : settings.whitelist;
}

export function totalRuleCount(settings) {
  return settings.whitelist.length + settings.blacklist.length;
}

/**
 * Groups rules for display.
 *
 * The list runs to 500 entries and, at the default order, is roughly twelve
 * screens long - search finds one rule, but nothing gives a sense of the shape of
 * the list. Grouping by registrable domain turns it into a browsable outline:
 * every amazon.co.uk / amazon.de / amazon.com entry lands under one "amazon" group.
 *
 * The grouping key is a heuristic, not a public-suffix lookup: shipping the PSL
 * would be a large data file for a cosmetic purpose. `co.uk`-style second-level
 * suffixes are handled by keeping the last two labels when the tail is a known
 * compound suffix. A wrong grouping only affects labels, never routing.
 */
const COMPOUND_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au",
  "net.au", "org.au", "co.nz", "com.br", "com.cn", "com.hk", "co.kr", "com.tw",
  "co.in", "com.sg", "com.mx", "co.za"
]);

/** The label a host is grouped under, or its own host when it cannot be grouped. */
export function groupingKey(host) {
  const value = String(host ?? "").toLowerCase();
  // IP literals and IPv6 have no registrable domain; group them under themselves.
  if (!value || value.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;

  const labels = value.split(".");
  if (labels.length <= 2) return value;

  const tail2 = labels.slice(-2).join(".");
  if (COMPOUND_SUFFIXES.has(tail2) && labels.length >= 3) return labels.slice(-3).join(".");
  // Everything under one second-level domain shares a group.
  return tail2;
}

/**
 * Splits visible rules into ordered groups.
 *
 * @returns {Array<{key: string, entries: object[]}>} in the same order the rules
 *   would otherwise appear, so switching grouping on never reshuffles the list.
 */
export function groupRules(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = groupingKey(entry.host);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups].map(([key, members]) => ({ key, entries: members }));
}

/**
 * Filters and orders the visible rules without touching the stored order.
 *
 * Sorting is a view concern: the PAC compares rule sets, not sequences, so
 * reordering the list must never rewrite storage and invalidate the fingerprint.
 * "Recently added" reverses the stored order because entries are appended.
 */
export function visibleRules(entries, { search = "", sort = "recent" } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) => entry.host.toLowerCase().includes(needle))
    : [...entries];
  if (sort === "name") return filtered.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return filtered.reverse();
}

export function renderRuleCounts(ui, settings, activeRuleType) {
  ui.totalRuleCount.textContent = String(totalRuleCount(settings));
  ui.ruleCount.textContent = String(ruleEntries(settings, activeRuleType).length);
}

/**
 * Rebuilds the rule list in one layout pass.
 *
 * @param {object} ui
 * @param {{settings: object, activeRuleType: string, search?: string, sort?: string,
 *          matchedHost?: string|null,
 *          onRemove: (host: string, type: string) => void}} view
 */
export function renderRules(ui, { settings, activeRuleType, search = "", sort = "recent", grouped = false, matchedHost = null, onRemove }) {
  const all = ruleEntries(settings, activeRuleType);
  const entries = visibleRules(all, { search, sort });
  const isBlacklist = activeRuleType === "blacklist";
  const searching = String(search ?? "").trim() !== "";

  ui.ruleList.replaceChildren();
  ui.ruleCount.textContent = String(all.length);
  ui.ruleEmpty.hidden = all.length > 0;
  ui.ruleNoMatch.hidden = !(searching && all.length > 0 && entries.length === 0);
  ui.clearRules.hidden = all.length === 0;
  ui.totalRuleCount.textContent = String(totalRuleCount(settings));

  const fragment = document.createDocumentFragment();

  // Grouped rendering emits a heading per group and then the same rows as before,
  // so the row markup (and its remove handler) is defined once below.
  const sections = grouped
    ? groupRules(entries).map((group) => ({ heading: group.key, entries: group.entries }))
    : [{ heading: null, entries }];

  for (const section of sections) {
    if (section.heading) {
      const heading = document.createElement("li");
      heading.className = "rule-group-heading";
      heading.setAttribute("role", "presentation");
      const name = document.createElement("span");
      name.textContent = section.heading;
      const count = document.createElement("span");
      count.className = "rule-group-count";
      count.textContent = String(section.entries.length);
      heading.append(name, count);
      fragment.append(heading);
    }
      for (const entry of section.entries) {
      const item = document.createElement("li");
      item.className = "whitelist-item";

      const detail = document.createElement("div");
      detail.className = "rule-detail";
      const domain = document.createElement("div");
      domain.className = "whitelist-domain";
      domain.textContent = entry.host;
      const meta = document.createElement("div");
      meta.className = "whitelist-meta";
      meta.textContent = entry.includeSubdomains ? "主域名及其子域名" : "仅此主机名";
      const type = document.createElement("span");
      type.className = `rule-type-label ${isBlacklist ? "rule-type-proxy" : "rule-type-direct"}`;
      type.textContent = isBlacklist ? "强制代理" : "直连";
      detail.append(domain, meta);
      if (matchedHost && entry.host === matchedHost) {
        const badge = document.createElement("span");
        badge.className = "rule-match-badge";
        badge.textContent = "当前网站命中";
        detail.append(badge);
      }
      detail.append(type);

      const remove = document.createElement("button");
      remove.className = "remove-button";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除 ${entry.host}`);
      remove.addEventListener("click", () => onRemove(entry.host, activeRuleType));

      item.append(detail, remove);
      fragment.append(item);
    }
  }
  ui.ruleList.append(fragment);
}

/* -------------------------------------------------------------------------- */
/* Local bypass                                                               */
/* -------------------------------------------------------------------------- */

export function renderLocalBypass(ui, enabled) {
  ui.localBypassToggle.checked = Boolean(enabled);
  ui.bypassWarning.hidden = Boolean(enabled);
  ui.bypassTag.textContent = enabled ? "直接连接" : "已关闭";
}

/* -------------------------------------------------------------------------- */
/* Finding the endpoint                                                       */
/* -------------------------------------------------------------------------- */

/** Fills the troubleshooting list once; it is static reference text. */
export function renderTroubleshooting(ui, items = ENDPOINT_TROUBLESHOOTING) {
  ui.troubleshootList.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    fragment.append(li);
  }
  ui.troubleshootList.append(fragment);
}

/**
 * Fills the connection fields from a pasted address.
 *
 * Returns the parsed result so the caller can decide what to save, and writes a
 * hint explaining anything that could not be carried over - credentials in the
 * pasted URL cannot be represented in a PAC script, and silently dropping them
 * would produce a connection that fails with no explanation.
 */
export function applyPastedAddress(ui, text) {
  const parsed = parseProxyAddress(text);
  if (!parsed) {
    ui.pasteAddressHint.hidden = false;
    ui.pasteAddressHint.className = "microcopy paste-hint-warn";
    ui.pasteAddressHint.textContent = "没认出地址。请粘贴形如 127.0.0.1:7890 或 socks5://127.0.0.1:7890 的内容。";
    return null;
  }

  ui.host.value = parsed.host;
  ui.port.value = parsed.port;
  ui.scheme.value = parsed.scheme;
  ui.pasteAddressHint.hidden = false;
  ui.pasteAddressHint.className = parsed.credentials ? "microcopy paste-hint-warn" : "microcopy";
  ui.pasteAddressHint.textContent = parsed.credentials
    ? "已填入地址和端口，但浏览器代理不支持用户名密码：如果这个代理需要认证，连接会失败。"
    : `已填入 ${parsed.scheme}://${parsed.host}:${parsed.port}，点下方按钮生效。`;
  return parsed;
}

/** Suggests the common ports as one-tap fills. */
export function renderPortSuggestions(ui, onPick, ports = COMMON_PROXY_PORTS) {
  const container = ui.portSuggestions;
  if (!container) return;
  container.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const { port, hint } of ports) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "port-chip";
    button.textContent = port;
    button.title = hint;
    button.addEventListener("click", () => onPick(port, hint));
    fragment.append(button);
  }
  container.append(fragment);
}

/* -------------------------------------------------------------------------- */
/* Backup and restore                                                         */
/* -------------------------------------------------------------------------- */

export function renderRestorePlan(ui, plan) {
  ui.restorePreview.hidden = false;
  ui.restoreSummary.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = describeImportPlan(plan).replace(/\*\*/g, "");
  ui.restoreSummary.append(strong);
}

export function clearRestorePlan(ui) {
  ui.restorePreview.hidden = true;
  ui.restoreSummary.replaceChildren();
  ui.importBackupFile.value = "";
}

/* -------------------------------------------------------------------------- */
/* Cross-device sync                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Renders the opt-in panel.
 *
 * The privacy block is only shown while sync is off: once the user has read it and
 * turned sync on, repeating the warning in every popup is noise. It stays one click
 * away because the turn-off button is always visible, and the state is never
 * silently re-enabled.
 */
export function renderSyncPanel(ui, { enabled, status, pendingUpload }) {
  ui.syncPanel.classList.toggle("sync-enabled", Boolean(enabled));
  ui.syncTag.textContent = enabled ? "已开启" : "关闭";
  ui.syncTag.parentElement.dataset.state = enabled ? "set" : "unset";
  ui.syncEnable.hidden = Boolean(enabled);
  ui.syncDisable.hidden = !enabled;
  ui.syncNow.hidden = !enabled;
  ui.syncPrivacy.hidden = Boolean(enabled);

  if (!enabled) {
    ui.syncStatus.textContent = "同步关闭中：设置只保存在这台设备上。";
    return;
  }
  if (pendingUpload) {
    ui.syncStatus.textContent = "设置已改变，正在上传…";
    return;
  }
  ui.syncStatus.textContent = status ?? "同步已开启。";
}

/* -------------------------------------------------------------------------- */
/* Proxy state and permissions                                                */
/* -------------------------------------------------------------------------- */

const LEVEL_CLASSES = Object.freeze({
  controlled_by_this_extension: "state-good",
  not_controllable: "state-bad",
  controlled_by_other_extensions: "state-bad"
});

const FOREIGN_LABELS = new Set(["其他代理配置", "自动检测代理", "其他 PAC 配置"]);

/** Maps a describeProxyMode() label plus levelOfControl onto pill styling. */
export function proxyStateClass(label, level) {
  if (FOREIGN_LABELS.has(label)) return "state-pill state-warn";
  return `state-pill ${LEVEL_CLASSES[level] ?? "state-neutral"}`;
}

export function renderProxyState(ui, { label, level }) {
  ui.stateText.textContent = label;
  ui.statePill.className = proxyStateClass(label, level);
}

export function renderProxyStateError(ui) {
  ui.stateText.textContent = "无法读取状态";
  ui.statePill.className = "state-pill state-bad";
}

export function renderStatusPermission(ui, granted) {
  // The old granted-state label read "已启用 · 刷新" (enabled / refresh), which states
  // a status and then appends a verb. Users could not tell that the button was the
  // thing to press, so nothing got refreshed and the toolbar icons stayed stale
  // until the popup was reopened. A granted permission is now presented as an action.
  ui.statusPermissionButton.textContent = granted ? "刷新图标" : "启用逐网页显示";
  ui.statusPermissionButton.setAttribute("aria-pressed", String(granted));
  ui.statusPermissionButton.title = granted
    ? "重新计算所有标签页的图标状态"
    : "允许扩展读取标签页网址，以便按网页显示路由";
  ui.statusPermissionHint.textContent = granted
    ? "逐网页状态已启用。图标会按白名单、黑名单和全局模式分别显示；只在本机读取标签页网址。"
    : "逐网页图标需要读取标签页网址；不会读取网页内容，也不上传浏览数据。未启用时添加规则仍然可用。";
  // A granted permission deserves a quieter treatment than a call to action.
  ui.statusPermissionButton.classList.toggle("is-granted", Boolean(granted));
}

/** Fills the connection fields from saved settings. */
export function renderConnectionFields(ui, settings) {
  ui.host.value = settings.host;
  ui.port.value = settings.port;
  ui.scheme.value = settings.scheme;
  ui.includeSubdomains.checked = settings.includeSubdomains !== false;
  ui.ruleIncludeSubdomains.checked = true;
}
