/**
 * Rendering behaviour.
 *
 * Before popup.js was split, none of this was testable: route labels and hints
 * lived inside functions that also read storage and wrote proxy settings, behind
 * module-level mutable state. The split moved that logic into pure functions with
 * explicit inputs, which is what these tests exercise.
 *
 * DOM-touching functions are covered through a minimal fake element, so the tests
 * stay dependency-free and do not need jsdom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { exportSettings, planImport } from "../src/backup.js";
import {
  applyPastedAddress,
  clearRestorePlan,
  describeModeHelp,
  describeRoute,
  describeSiteHint,
  groupRules,
  groupingKey,
  proxyStateClass,
  renderCurrentPage,
  renderEndpointLine,
  renderLocalBypass,
  renderPortSuggestions,
  renderRestorePlan,
  renderRuleCounts,
  renderRuleTab,
  renderRules,
  ROUTE_LABELS,
  ruleEntries,
  totalRuleCount
} from "../src/popup-render.js";

// Minimal DOM shim: renderRules builds real elements. Keeping the shim tiny means
// the render layer is tested for structure without pulling in jsdom.
function installDomShim() {
  if (globalThis.document) return;
  const makeElement = (tagName) => {
    const listeners = new Map();
    return {
      tagName,
      className: "",
      type: "",
      textContent: "",
      hidden: false,
      children: [],
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      set handler(fn) {
        listeners.set("click", fn);
      },
      click() {
        listeners.get("click")?.();
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
      }
    };
  };
  globalThis.document = {
    createElement: makeElement,
    createDocumentFragment: () => makeElement("#fragment")
  };
}
installDomShim();

const BASE = {
  mode: "proxy",
  host: "127.0.0.1",
  port: "7890",
  scheme: "socks5",
  whitelist: [],
  blacklist: []
};

/** Minimal stand-in for the elements renderCurrentPage writes to. */
function fakeUi() {
  const element = () => ({
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    dataset: {},
    attributes: {},
    value: "",
    checked: false,
    classList: {
      values: new Set(),
      toggle(name, force) {
        if (force) this.values.add(name);
        else this.values.delete(name);
      },
      contains(name) {
        return this.values.has(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      // A DocumentFragment contributes its own children when appended.
      (this.children ??= []).push(...(child?.tagName === "#fragment" ? child.children : [child]));
    }
  });
  return {
    host: element(),
    port: element(),
    scheme: element(),
    brandMark: element(),
    routePill: element(),
    currentHost: element(),
    currentRoute: element(),
    siteHint: element(),
    addCurrentDirect: element(),
    addCurrentProxy: element(),
    removeCurrentRule: element(),
    includeSubdomains: element(),
    ruleList: element(),
    ruleEmpty: element(),
    ruleNoMatch: element(),
    clearRules: element(),
    ruleCount: element(),
    totalRuleCount: element(),
    modeHelp: element(),
    whitelistTab: element(),
    blacklistTab: element(),
    activeRuleTitle: element(),
    ruleDescription: element(),
    ruleHostInput: element(),
    addRuleButton: element(),
    endpointLine: element(),
    endpointTag: element(),
    localBypassToggle: element(),
    bypassWarning: element(),
    bypassTag: element(),
    pasteAddress: element(),
    pasteAddressButton: element(),
    pasteAddressHint: element(),
    portSuggestions: element(),
    troubleshootList: element(),
    exportBackup: element(),
    importBackup: element(),
    importBackupFile: element(),
    restorePreview: { ...element(), hidden: true },
    restoreSummary: element(),
    confirmRestore: element(),
    cancelRestore: element()
  };
}

/* -------------------------------------------------------------------------- */
/* Route copy                                                                 */
/* -------------------------------------------------------------------------- */

test("every route has a user-facing label", () => {
  for (const route of ["proxy", "direct", "unknown"]) {
    assert.equal(typeof ROUTE_LABELS[route], "string");
    assert.ok(ROUTE_LABELS[route].length > 0);
  }
});

test("proxy copy distinguishes a blacklist hit from a default proxy decision", () => {
  const blacklisted = describeRoute("proxy", { whitelisted: false, blacklisted: true });
  const byDefault = describeRoute("proxy", { whitelisted: false, blacklisted: false });
  assert.match(blacklisted, /黑名单/);
  assert.match(byDefault, /未命中直连白名单/);
  assert.notEqual(blacklisted, byDefault);
});

test("direct copy distinguishes a whitelist hit from global direct mode", () => {
  const whitelisted = describeRoute("direct", { whitelisted: true, blacklisted: false });
  const globalMode = describeRoute("direct", { whitelisted: false, blacklisted: false });
  assert.match(whitelisted, /白名单/);
  assert.match(globalMode, /全局直连/);
});

test("an unknown route never claims rules are applied", () => {
  assert.match(describeRoute("unknown", {}), /无法确认/);
});

test("blacklisted hint outranks the whitelisted hint", () => {
  const both = describeSiteHint("proxy", { whitelisted: true, blacklisted: true });
  assert.match(both, /黑名单/);
});

/* -------------------------------------------------------------------------- */
/* Mode help                                                                  */
/* -------------------------------------------------------------------------- */

test("mode help states the active mode's rule semantics", () => {
  assert.match(describeModeHelp("proxy", BASE), /白名单/);
  assert.match(describeModeHelp("direct", BASE), /黑名单/);
  assert.match(describeModeHelp(null, BASE), /无法识别/);
});

test("proxy mode help warns when no endpoint has been entered yet", () => {
  // Claiming rules are live while the endpoint is blank would be a lie: the PAC
  // cannot even be generated until an address exists.
  const help = describeModeHelp("proxy", { ...BASE, host: "", port: "" });
  assert.match(help, /还没有填写代理服务器地址/);
  assert.doesNotMatch(help, /白名单网站直连/);
});

/* -------------------------------------------------------------------------- */
/* Proxy state pill                                                           */
/* -------------------------------------------------------------------------- */

test("state pill reflects control level", () => {
  assert.match(proxyStateClass("直接连接", "controlled_by_this_extension"), /state-good/);
  assert.match(proxyStateClass("直接连接", "controlled_by_other_extensions"), /state-bad/);
  assert.match(proxyStateClass("直接连接", "not_controllable"), /state-bad/);
  assert.match(proxyStateClass("直接连接", "unknown_level"), /state-neutral/);
});

test("a foreign proxy configuration is reported as a warning, not as ours", () => {
  for (const label of ["其他代理配置", "自动检测代理", "其他 PAC 配置"]) {
    assert.match(proxyStateClass(label, "controlled_by_this_extension"), /state-warn/, label);
  }
});

/* -------------------------------------------------------------------------- */
/* Current page                                                               */
/* -------------------------------------------------------------------------- */

test("unsupported pages disable every rule action and say why", () => {
  const ui = fakeUi();
  const route = renderCurrentPage(ui, {
    currentTabUrl: "edge://extensions",
    currentHostname: null,
    settings: BASE,
    proxyState: null
  });
  assert.equal(route, "unknown");
  assert.equal(ui.currentHost.textContent, "当前页面不可用");
  assert.equal(ui.addCurrentDirect.disabled, true);
  assert.equal(ui.addCurrentProxy.disabled, true);
  assert.equal(ui.removeCurrentRule.hidden, true);
  assert.match(ui.siteHint.textContent, /浏览器内部页面/);
});

test("the brand mark carries the resolved route for styling", () => {
  const ui = fakeUi();
  const settings = { ...BASE, mode: "direct" };
  renderCurrentPage(ui, {
    currentTabUrl: "https://example.com/",
    currentHostname: "example.com",
    settings,
    proxyState: { levelOfControl: "controlled_by_this_extension", value: { mode: "direct" } }
  });
  assert.equal(ui.brandMark.dataset.route, "direct");
  assert.match(ui.brandMark.attributes["aria-label"], /浏览器直连/);
});

/* -------------------------------------------------------------------------- */
/* Rule list                                                                  */
/* -------------------------------------------------------------------------- */

test("rule counts cover both lists independently of the active tab", () => {
  const settings = {
    ...BASE,
    whitelist: [{ host: "a.example", includeSubdomains: true }],
    blacklist: [{ host: "b.example", includeSubdomains: true }, { host: "c.example", includeSubdomains: false }]
  };
  const ui = fakeUi();
  renderRuleCounts(ui, settings, "blacklist");
  assert.equal(ui.totalRuleCount.textContent, "3");
  assert.equal(ui.ruleCount.textContent, "2");
  renderRuleCounts(ui, settings, "whitelist");
  assert.equal(ui.ruleCount.textContent, "1");
});

test("rule entries and totals are read-only projections of settings", () => {
  const settings = { ...BASE, whitelist: [], blacklist: [{ host: "x.example", includeSubdomains: true }] };
  assert.equal(ruleEntries(settings, "blacklist").length, 1);
  assert.equal(ruleEntries(settings, "whitelist").length, 0);
  assert.equal(totalRuleCount(settings), 1);
});

test("a whitelisted apex host disables the whitelist button and offers removal", () => {
  const ui = fakeUi();
  const settings = { ...BASE, whitelist: [{ host: "example.com", includeSubdomains: true }] };
  renderCurrentPage(ui, {
    currentTabUrl: "https://a.example.com/",
    currentHostname: "a.example.com",
    settings,
    proxyState: null
  });
  // a.example.com is covered by the subdomain rule, so adding it again is not
  // offered; removal is only offered for an exact host match.
  assert.equal(ui.addCurrentDirect.disabled, true);
  assert.equal(ui.removeCurrentRule.hidden, true, "never offer to remove a rule that does not exist verbatim");
});

test("an exact whitelisted host offers removal", () => {
  const ui = fakeUi();
  const settings = { ...BASE, whitelist: [{ host: "example.com", includeSubdomains: true }] };
  renderCurrentPage(ui, {
    currentTabUrl: "https://example.com/",
    currentHostname: "example.com",
    settings,
    proxyState: null
  });
  assert.equal(ui.removeCurrentRule.hidden, false);
});

test("an empty list shows the empty state and hides the clear action", () => {
  const ui = fakeUi();
  let removed = 0;
  renderRules(ui, {
    settings: { ...BASE, whitelist: [], blacklist: [] },
    activeRuleType: "whitelist",
    onRemove: () => { removed += 1; }
  });
  assert.equal(ui.ruleEmpty.hidden, false);
  assert.equal(ui.clearRules.hidden, true);
  assert.deepEqual(ui.ruleList.children, []);
  assert.equal(removed, 0);
});

test("rule rows pass their host and list type to the remove callback", () => {
  const ui = fakeUi();
  const calls = [];
  const settings = {
    ...BASE,
    blacklist: [
      { host: "force.example", includeSubdomains: true },
      { host: "exact.example", includeSubdomains: false }
    ]
  };
  renderRules(ui, {
    settings,
    activeRuleType: "blacklist",
    onRemove: (host, type) => calls.push([host, type])
  });
  assert.equal(ui.ruleList.children.length, 2);
  assert.equal(ui.clearRules.hidden, false);

  const row = ui.ruleList.children[0];
  const removeButton = row.children[1];
  removeButton.click();
  assert.deepEqual(calls, [["exact.example", "blacklist"]]);
});

test("rule tab copy matches the selected list", () => {
  const ui = fakeUi();
  renderRuleTab(ui, "blacklist");
  assert.match(ui.ruleDescription.textContent, /强制通过代理服务器/);
  assert.equal(ui.addRuleButton.textContent, "添加代理规则");
  renderRuleTab(ui, "whitelist");
  assert.match(ui.ruleDescription.textContent, /绕过浏览器代理/);
  assert.equal(ui.addRuleButton.textContent, "添加直连规则");
});

/* -------------------------------------------------------------------------- */
/* Rule list: search, sort, match badge                                       */
/* -------------------------------------------------------------------------- */

const RULES = [
  { host: "zeta.example", includeSubdomains: true },
  { host: "alpha.example", includeSubdomains: false },
  { host: "mike.example", includeSubdomains: true }
];

test("the rule list shows the most recently added entry first", () => {
  const ui = fakeUi();
  renderRules(ui, { settings: { ...BASE, whitelist: RULES }, activeRuleType: "whitelist", onRemove: () => {} });
  assert.deepEqual(
    ui.ruleList.children.map((row) => row.children[0].children[0].textContent),
    ["mike.example", "alpha.example", "zeta.example"]
  );
});

test("sorting by name is a view-only change and never rewrites stored order", () => {
  const settings = { ...BASE, whitelist: RULES };
  const before = settings.whitelist.map((entry) => entry.host);
  const ui = fakeUi();
  renderRules(ui, { settings, activeRuleType: "whitelist", sort: "name", onRemove: () => {} });
  assert.deepEqual(
    ui.ruleList.children.map((row) => row.children[0].children[0].textContent),
    ["alpha.example", "mike.example", "zeta.example"]
  );
  // Reordering the stored list would change the PAC fingerprint and force a
  // pointless re-apply, so sorting must stay inside the view.
  assert.deepEqual(settings.whitelist.map((entry) => entry.host), before);
});

test("searching filters without altering the stored list", () => {
  const settings = { ...BASE, whitelist: RULES };
  const ui = fakeUi();
  renderRules(ui, { settings, activeRuleType: "whitelist", search: "ALPHA", onRemove: () => {} });
  assert.equal(ui.ruleList.children.length, 1);
  assert.equal(settings.whitelist.length, 3);
  assert.equal(ui.ruleNoMatch.hidden, true);
});

test("a search with no matches explains itself instead of showing an empty list", () => {
  const ui = fakeUi();
  renderRules(ui, { settings: { ...BASE, whitelist: RULES }, activeRuleType: "whitelist", search: "nope", onRemove: () => {} });
  assert.equal(ui.ruleNoMatch.hidden, false);
  assert.equal(ui.ruleEmpty.hidden, true, "an empty search result is not an empty list");
  assert.equal(ui.clearRules.hidden, false);
});

test("the rule that decides the current page is marked in the list", () => {
  const ui = fakeUi();
  renderRules(ui, {
    settings: { ...BASE, whitelist: RULES },
    activeRuleType: "whitelist",
    matchedHost: "alpha.example",
    onRemove: () => {}
  });
  const marked = ui.ruleList.children.filter((row) =>
    row.children[0].children.some((child) => child.className === "rule-match-badge")
  );
  assert.equal(marked.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Local addresses and unconfigured state                                     */
/* -------------------------------------------------------------------------- */

test("a local host is described as local, not as a rule hit", () => {
  const copy = describeRoute("direct", { whitelisted: false, blacklisted: false, local: true });
  assert.match(copy, /本机/);
  assert.doesNotMatch(copy, /全局直连模式/);
});

test("an unconfigured proxy is surfaced on the endpoint line, not hidden in the status pill", () => {
  const ui = fakeUi();
  renderEndpointLine(ui, { ...BASE, host: "", port: "" });
  assert.match(ui.endpointLine.textContent, /尚未填写/);
  assert.equal(ui.endpointLine.classList.contains("is-unset"), true);
  renderEndpointLine(ui, BASE);
  assert.match(ui.endpointLine.textContent, /socks5:\/\/127\.0\.0\.1:7890/);
  assert.equal(ui.endpointLine.classList.contains("is-unset"), false);
});

test("disabling the local bypass shows the consequence before the user hits it", () => {
  const ui = fakeUi();
  renderLocalBypass(ui, false);
  assert.equal(ui.bypassWarning.hidden, false);
  assert.equal(ui.localBypassToggle.checked, false);
  renderLocalBypass(ui, true);
  assert.equal(ui.bypassWarning.hidden, true);
});

/* -------------------------------------------------------------------------- */
/* Endpoint discovery and backup                                              */
/* -------------------------------------------------------------------------- */

test("a pasted address fills all three connection fields", () => {
  const ui = fakeUi();
  const parsed = applyPastedAddress(ui, "http://192.168.1.5:8080");
  assert.equal(ui.host.value, "192.168.1.5");
  assert.equal(ui.port.value, "8080");
  assert.equal(ui.scheme.value, "http");
  assert.equal(ui.pasteAddressHint.hidden, false);
  assert.equal(parsed.scheme, "http");
});

test("a pasted address with credentials warns instead of pretending it will work", () => {
  const ui = fakeUi();
  applyPastedAddress(ui, "socks5://user:pass@127.0.0.1:1080");
  assert.match(ui.pasteAddressHint.textContent, /不支持用户名密码/);
  assert.match(ui.pasteAddressHint.className, /warn/);
});

test("unrecognised text leaves the fields untouched", () => {
  const ui = fakeUi();
  ui.host.value = "keep.me";
  applyPastedAddress(ui, "???");
  assert.equal(ui.host.value, "keep.me");
  assert.match(ui.pasteAddressHint.textContent, /没认出地址/);
});

test("port suggestions are real buttons that call back with their hint", () => {
  const ui = fakeUi();
  const picked = [];
  renderPortSuggestions(ui, (port, hint) => picked.push([port, hint]));
  assert.ok(ui.portSuggestions.children.length >= 5);
  ui.portSuggestions.children[0].click();
  assert.equal(picked.length, 1);
  assert.equal(picked[0][0], ui.portSuggestions.children[0].textContent);
  assert.ok(picked[0][1].length > 0);
});

test("the restore preview states what will be replaced before anything changes", () => {
  const ui = fakeUi();
  const { plan } = planImport(JSON.stringify(exportSettings({
    mode: "proxy", scheme: "socks5", host: "127.0.0.1", port: "7890",
    whitelist: [{ host: "a.example", includeSubdomains: true }],
    blacklist: [{ host: "b.example", includeSubdomains: false }]
  })));
  renderRestorePlan(ui, plan);
  assert.equal(ui.restorePreview.hidden, false);
  assert.match(ui.restoreSummary.children[0].textContent, /替换/);
  assert.match(ui.restoreSummary.children[0].textContent, /直连白名单 1 条/);
  // The literal markdown asterisks must not leak into the UI.
  assert.doesNotMatch(ui.restoreSummary.children[0].textContent, /\*\*/);
});

test("cancelling a restore hides the preview and clears the file input", () => {
  const ui = fakeUi();
  ui.importBackupFile.value = "C:\\fakepath\\backup.json";
  renderRestorePlan(ui, planImport(JSON.stringify(exportSettings(BASE))).plan);
  clearRestorePlan(ui);
  assert.equal(ui.restorePreview.hidden, true);
  assert.equal(ui.importBackupFile.value, "");
});

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

test("hosts are grouped under their registrable domain", () => {
  const cases = [
    ["example.com", "example.com"],
    ["www.example.com", "example.com"],
    ["a.b.example.com", "example.com"],
    ["api.github.com", "github.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"]
  ];
  for (const [host, expected] of cases) assert.equal(groupingKey(host), expected, host);
});

test("compound public suffixes keep three labels so unrelated sites do not merge", () => {
  // Without this, amazon.co.uk and bbc.co.uk would both group under "co.uk".
  assert.equal(groupingKey("amazon.co.uk"), "amazon.co.uk");
  assert.equal(groupingKey("www.amazon.co.uk"), "amazon.co.uk");
  assert.equal(groupingKey("bbc.co.uk"), "bbc.co.uk");
  assert.equal(groupingKey("x.com.au"), "x.com.au");
});

test("grouping preserves the order rules would otherwise appear in", () => {
  const entries = [
    { host: "b.example.com", includeSubdomains: true },
    { host: "a.other.com", includeSubdomains: true },
    { host: "a.example.com", includeSubdomains: true }
  ];
  const groups = groupRules(entries);
  assert.deepEqual(groups.map((group) => group.key), ["example.com", "other.com"]);
  assert.equal(groups[0].entries.length, 2);
  // First appearance defines group order, and members keep their relative order.
  assert.deepEqual(groups[0].entries.map((entry) => entry.host), ["b.example.com", "a.example.com"]);
});

test("grouped rendering emits one heading per domain plus every rule row", () => {
  const ui = fakeUi();
  renderRules(ui, {
    settings: { ...BASE, whitelist: [
      { host: "a.example.com", includeSubdomains: true },
      { host: "b.example.com", includeSubdomains: true },
      { host: "c.other.com", includeSubdomains: true }
    ] },
    activeRuleType: "whitelist",
    grouped: true,
    onRemove: () => {}
  });
  const headings = ui.ruleList.children.filter((row) => row.className === "rule-group-heading");
  const rows = ui.ruleList.children.filter((row) => row.className === "whitelist-item");
  assert.equal(headings.length, 2);
  assert.equal(rows.length, 3);
  const exampleHeading = headings.find((row) => row.children[0].textContent === "example.com");
  assert.ok(exampleHeading, "the example.com group has a heading");
  assert.equal(exampleHeading.children[1].textContent, "2", "heading carries the group size");
});

test("ungrouped rendering adds no headings", () => {
  const ui = fakeUi();
  renderRules(ui, {
    settings: { ...BASE, whitelist: [{ host: "a.example.com", includeSubdomains: true }] },
    activeRuleType: "whitelist",
    grouped: false,
    onRemove: () => {}
  });
  assert.equal(ui.ruleList.children.filter((row) => row.className === "rule-group-heading").length, 0);
  assert.equal(ui.ruleList.children.length, 1);
});

test("grouping composes with search and sort instead of replacing them", () => {
  const ui = fakeUi();
  renderRules(ui, {
    settings: { ...BASE, whitelist: [
      { host: "z.example.com", includeSubdomains: true },
      { host: "a.example.com", includeSubdomains: true },
      { host: "m.other.com", includeSubdomains: true }
    ] },
    activeRuleType: "whitelist",
    grouped: true,
    sort: "name",
    search: "example",
    onRemove: () => {}
  });
  const rows = ui.ruleList.children.filter((row) => row.className === "whitelist-item");
  assert.equal(rows.length, 2, "search still filters");
  assert.equal(rows[0].children[0].children[0].textContent, "a.example.com", "sort still applies");
  assert.equal(ui.ruleList.children.filter((row) => row.className === "rule-group-heading").length, 1);
});
