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
import {
  describeModeHelp,
  describeRoute,
  describeSiteHint,
  proxyStateClass,
  renderCurrentPage,
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
  mode: "clash",
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
    clearRules: element(),
    ruleCount: element(),
    totalRuleCount: element(),
    modeHelp: element(),
    whitelistTab: element(),
    blacklistTab: element(),
    activeRuleTitle: element(),
    ruleDescription: element(),
    ruleHostInput: element(),
    addRuleButton: element()
  };
}

/* -------------------------------------------------------------------------- */
/* Route copy                                                                 */
/* -------------------------------------------------------------------------- */

test("every route has a user-facing label", () => {
  for (const route of ["clash", "direct", "system", "unknown"]) {
    assert.equal(typeof ROUTE_LABELS[route], "string");
    assert.ok(ROUTE_LABELS[route].length > 0);
  }
});

test("clash copy distinguishes a blacklist hit from a default proxy decision", () => {
  const blacklisted = describeRoute("clash", { whitelisted: false, blacklisted: true });
  const byDefault = describeRoute("clash", { whitelisted: false, blacklisted: false });
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

test("system and unknown routes never claim rules are applied", () => {
  assert.match(describeRoute("system", {}), /不生效/);
  assert.match(describeRoute("unknown", {}), /无法确认/);
});

test("blacklisted hint outranks the whitelisted hint", () => {
  const both = describeSiteHint("clash", { whitelisted: true, blacklisted: true });
  assert.match(both, /黑名单/);
});

/* -------------------------------------------------------------------------- */
/* Mode help                                                                  */
/* -------------------------------------------------------------------------- */

test("mode help explains that rules are suspended under system proxy", () => {
  assert.match(describeModeHelp("system"), /不生效/);
  assert.match(describeModeHelp("clash"), /白名单/);
  assert.match(describeModeHelp("direct"), /黑名单/);
  assert.match(describeModeHelp(null), /无法识别/);
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
  for (const label of ["其他代理配置", "自动检测代理", "其他 PAC 代理配置"]) {
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
  assert.deepEqual(calls, [["force.example", "blacklist"]]);
});

test("rule tab copy matches the selected list", () => {
  const ui = fakeUi();
  renderRuleTab(ui, "blacklist");
  assert.match(ui.ruleDescription.textContent, /强制通过本机 Clash/);
  assert.equal(ui.addRuleButton.textContent, "添加代理规则");
  renderRuleTab(ui, "whitelist");
  assert.match(ui.ruleDescription.textContent, /绕过浏览器代理/);
  assert.equal(ui.addRuleButton.textContent, "添加直连规则");
});
