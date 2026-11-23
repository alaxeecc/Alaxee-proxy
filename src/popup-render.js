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
import {
  isHostBlacklisted,
  isHostWhitelisted,
  resolveTabRoute
} from "./core.js";

export const ROUTE_LABELS = Object.freeze({
  clash: "交给 Clash",
  direct: "浏览器直连",
  system: "系统代理",
  unknown: "状态未知"
});

const ROUTE_CLASSES = Object.freeze({
  clash: "route-proxy",
  direct: "route-good",
  system: "route-system",
  unknown: "route-unknown"
});

/** Builds the element lookup table. Ids are stable for the document's lifetime. */
export function createUi() {
  const $ = (id) => document.getElementById(id);
  return {
    statePill: $("statePill"),
    stateText: $("stateText"),
    modeHelp: $("modeHelp"),
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
    ruleCount: $("listCount"),
    clearRules: $("clearRulesButton")
  };
}

/* -------------------------------------------------------------------------- */
/* Notice                                                                     */
/* -------------------------------------------------------------------------- */

/** Returns a cancel function so a newer notice can replace the pending timer. */
export function showNotice(ui, message, kind, timers = globalThis) {
  ui.notice.textContent = message;
  ui.notice.className = `notice notice-${kind}`;
  ui.notice.hidden = false;
  const handle = timers.setTimeout(() => {
    ui.notice.hidden = true;
  }, 4600);
  return () => timers.clearTimeout(handle);
}

/* -------------------------------------------------------------------------- */
/* Current page                                                               */
/* -------------------------------------------------------------------------- */

/** Message shown under the hostname, given the resolved route and rule hits. */
export function describeRoute(route, { whitelisted, blacklisted }) {
  switch (route) {
    case "clash":
      return blacklisted
        ? "此网站命中代理黑名单，浏览器请求会强制交给本机 Clash。"
        : "此网站未命中直连白名单，浏览器请求会交给本机 Clash 处理。";
    case "direct":
      return whitelisted
        ? "此网站命中直连白名单，浏览器请求会绕过浏览器代理。"
        : "当前浏览器处于全局直连模式，所有网站都会直接连接。";
    case "system":
      return "此网站跟随 Windows 系统代理设置；白名单和黑名单在此模式下暂不生效。";
    default:
      return "无法确认此网站的浏览器代理路由；可能由其他扩展或管理策略接管。";
  }
}

/** Hint below the action buttons for the current page. */
export function describeSiteHint(route, { whitelisted, blacklisted }) {
  if (route === "system") return "系统代理模式会把规则暂时搁置；切回 Clash 或全局直连后规则会重新生效。";
  if (blacklisted) return "当前命中代理黑名单；即使同时匹配上级白名单，也会优先交给 Clash。";
  if (whitelisted) return "当前命中直连白名单；浏览器会跳过本机代理。";
  return "白名单让网站直连；代理黑名单让网站强制经 Clash。重叠时黑名单优先。";
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
  const whitelisted = Boolean(currentHostname && isHostWhitelisted(currentHostname, settings.whitelist));
  const blacklisted = Boolean(currentHostname && isHostBlacklisted(currentHostname, settings.blacklist));
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
  ui.currentRoute.textContent = describeRoute(route, { whitelisted, blacklisted });

  // Disable the add buttons when the host is already covered by any rule,
  // including a parent domain's subdomain rule. Checking exact equality only
  // left the button active on a subdomain the UI was simultaneously reporting as
  // whitelisted, which invited duplicate entries.
  ui.addCurrentDirect.disabled = whitelisted;
  ui.addCurrentProxy.disabled = blacklisted;

  // Removal is only offered for a rule that matches this host verbatim, because
  // the button deletes by exact host and would otherwise do nothing visible.
  ui.removeCurrentRule.hidden = !whitelistExact && !blacklistExact;
  ui.includeSubdomains.disabled = whitelisted || blacklisted;
  ui.siteHint.textContent = describeSiteHint(route, { whitelisted, blacklisted });
  return route;
}

/* -------------------------------------------------------------------------- */
/* Mode                                                                       */
/* -------------------------------------------------------------------------- */

export function describeModeHelp(activeMode) {
  if (activeMode === "clash") return "默认网站交给 Clash；白名单网站直连，代理黑名单网站强制经 Clash。";
  if (activeMode === "direct") return "默认网站直接连接；代理黑名单是例外，会强制经本机 Clash。";
  if (activeMode === "system") return "Edge 使用 Windows 系统代理设置；域名白名单和黑名单在此模式下暂不生效。";
  return "当前代理设置无法识别。你仍可在这里选择一个模式接管 Edge。";
}

export function renderModes(ui, activeMode) {
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === activeMode));
  }
  ui.modeHelp.textContent = describeModeHelp(activeMode);
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
    ? "命中的网站会强制通过本机 Clash，即使它也匹配某条上级直连白名单。"
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

export function renderRuleCounts(ui, settings, activeRuleType) {
  ui.totalRuleCount.textContent = String(totalRuleCount(settings));
  ui.ruleCount.textContent = String(ruleEntries(settings, activeRuleType).length);
}

/**
 * Rebuilds the rule list in one layout pass.
 *
 * @param {object} ui
 * @param {{settings: object, activeRuleType: string, onRemove: (host: string, type: string) => void}} view
 */
export function renderRules(ui, { settings, activeRuleType, onRemove }) {
  const entries = ruleEntries(settings, activeRuleType);
  const isBlacklist = activeRuleType === "blacklist";

  ui.ruleList.replaceChildren();
  ui.ruleCount.textContent = String(entries.length);
  ui.ruleEmpty.hidden = entries.length > 0;
  ui.clearRules.hidden = entries.length === 0;
  ui.totalRuleCount.textContent = String(totalRuleCount(settings));

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
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
    type.textContent = isBlacklist ? "强制 Clash" : "直连";
    detail.append(domain, meta, type);

    const remove = document.createElement("button");
    remove.className = "remove-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${entry.host}`);
    remove.addEventListener("click", () => onRemove(entry.host, activeRuleType));

    item.append(detail, remove);
    fragment.append(item);
  }
  ui.ruleList.append(fragment);
}

/* -------------------------------------------------------------------------- */
/* Proxy state and permissions                                                */
/* -------------------------------------------------------------------------- */

const LEVEL_CLASSES = Object.freeze({
  controlled_by_this_extension: "state-good",
  not_controllable: "state-bad",
  controlled_by_other_extensions: "state-bad"
});

const FOREIGN_LABELS = new Set(["其他代理配置", "自动检测代理", "其他 PAC 代理配置"]);

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
  ui.statusPermissionButton.textContent = granted ? "已启用 · 刷新" : "启用逐网页显示";
  ui.statusPermissionButton.setAttribute("aria-pressed", String(granted));
  ui.statusPermissionHint.textContent = granted
    ? "逐网页状态已启用：根据白名单、黑名单和全局模式分别显示。仅本地读取标签页网址。"
    : "逐网页图标需要读取标签页网址；不会读取网页内容或上传浏览数据。添加规则仍然可用。";
}

/** Fills the connection fields from saved settings. */
export function renderConnectionFields(ui, settings) {
  ui.host.value = settings.host;
  ui.port.value = settings.port;
  ui.scheme.value = settings.scheme;
  ui.includeSubdomains.checked = settings.includeSubdomains !== false;
  ui.ruleIncludeSubdomains.checked = true;
}
