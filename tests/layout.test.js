/**
 * Layout claims that can be checked without a browser.
 *
 * The complaint that started this was "very long scrolling menu", which is a
 * structural property, not a styling detail: 600px viewport, four full-height
 * panels on overview and nine stacked blocks on the rules view. Each of these
 * asserts a decision that keeps the page short, so a later edit cannot quietly
 * undo it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const html = await readFile(path.join(root, "src/popup.html"), "utf8");
const css = await readFile(path.join(root, "src/popup.css"), "utf8");

/** The slice of markup belonging to one element id, up to its closing tag. */
function sectionOf(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > -1, `missing #${id}`);
  return html.slice(start, html.indexOf("</details>", start) > -1
    ? html.indexOf("</details>", start)
    : html.indexOf("</section>", start));
}

test("the two setup panels are collapsible", () => {
  // Both are configured once and then never touched, yet at full height they were
  // 688px of a 600px viewport.
  for (const id of ["configPanel", "bypassPanel"]) {
    const opening = html.lastIndexOf("<details", html.indexOf(`id="${id}"`));
    assert.ok(opening > -1, `#${id} should be a <details> so it can collapse`);
    assert.ok(
      html.slice(opening, html.indexOf(`id="${id}"`)).includes("panel-collapsible"),
      `#${id} needs the collapsible styling class`
    );
  }
});

test("a collapsed panel still shows its current value", () => {
  // Collapsing must not hide the state, only the controls.
  for (const id of ["endpointTag", "bypassTag"]) {
    const index = html.indexOf(`id="${id}"`);
    const detailsStart = html.lastIndexOf("<details", index);
    const summaryStart = html.lastIndexOf("<summary", index);
    assert.ok(summaryStart > detailsStart, `#${id} must sit inside the summary so it stays visible`);
  }
});

test("the add-rule form starts folded away", () => {
  // It cost 124px of fixed height on the view whose only job is showing the list.
  const area = html.slice(html.indexOf('id="ruleAddArea"'), html.indexOf(">", html.indexOf('id="ruleAddArea"')));
  assert.match(area, /\bhidden\b/, "the add area must start hidden");
  assert.match(html, /id="toggleAddRuleButton"/, "and there must be a control to reveal it");
});

test("the rule list keeps most of the viewport", () => {
  // Count the fixed-height blocks that precede the list on the rules view.
  const view = html.slice(html.indexOf('id="rulesView"'), html.indexOf('id="syncPanel"'));
  const listIndex = view.indexOf('id="rulesList"');
  assert.ok(listIndex > -1);
  const before = view.slice(0, listIndex);
  // Tabs, heading and one toolbar are the essentials. A form, a description and a
  // footnote ahead of the list are what pushed it off screen - but being earlier in
  // the DOM is fine as long as the block is folded away, because a hidden element
  // takes no height.
  const addAreaStart = before.indexOf('id="ruleAddArea"');
  if (addAreaStart > -1) {
    const opening = before.slice(addAreaStart, before.indexOf(">", addAreaStart));
    assert.match(opening, /\bhidden\b/, "the add form sits before the list, so it must start hidden");
  }
  assert.ok(!before.includes('class="rules-footnote"'), "the long footnote must not precede the list");
});

test("long explanatory copy is behind a disclosure, not inline", () => {
  // Three paragraphs of explanation above the fold is the same problem in text form.
  for (const marker of ["rules-footnote-details", "mode-help-details"]) {
    assert.ok(css.includes(marker), `${marker} should be styled as a disclosure`);
  }
  assert.match(html, /<details class="rules-footnote-details">/);
  assert.match(html, /<details class="mode-help-details">/);
});

test("hidden elements are actually hidden", () => {
  // Several panels use the hidden attribute; without this rule a class that sets
  // display would override it and the folded content would show through anyway.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("every overview panel is handled by the full-page grid", () => {
  // The bypass panel became a <details> and was missed by the rule that zeroes the
  // grid cells' bottom margin, so it sat 10px lower than its row. Any panel added to
  // the overview has to be listed here too, or it will be the next one misaligned.
  const block = css.slice(css.indexOf("html.full-page #overviewView {"));
  const gridSection = block.slice(0, block.indexOf("html.full-page .mode-grid"));
  for (const panel of ["mode-panel", "config-panel", "site-panel", "bypass-panel"]) {
    assert.ok(gridSection.includes(panel), `#overviewView grid rules must cover ${panel}`);
  }
});

test("a collapsible panel does not add padding on top of its summary", () => {
  // .bypass-panel declares padding: 14px and comes after the collapsible rule, so a
  // plain .panel-collapsible selector loses and the heading shifts right by 14px.
  const rule = css.match(/\.mode-panel\.panel-collapsible[^{]*\{([^}]*)\}/);
  assert.ok(rule, "the padding reset must outrank the panel's own padding");
  assert.match(rule[1], /padding:\s*0/);
  assert.match(rule[0], /\.bypass-panel\.panel-collapsible/);
});

/* -------------------------------------------------------------------------- */
/* Nothing overflows or is crushed                                            */
/* -------------------------------------------------------------------------- */

/**
 * All three of these came from the same mistake: text was added to elements that sit
 * in flex rows without any rule about what happens when it does not fit. The result
 * was an endpoint clipped by the card edge, a status label one character wide, and
 * button labels broken mid-word - all visible in a single screenshot.
 */

const rule = (selector) => {
  // Anchored to the start of a line so a mention in a comment cannot satisfy it.
  const pattern = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const match = pattern.exec(css);
  assert.ok(match, `missing rule: ${selector}`);
  const end = css.indexOf("}", match.index);
  return css.slice(match.index, end);
};

test("a status label never collapses to one character per line", () => {
  // ".local-tag span" gave every child span a 6px width, including the text one, so
  // "直接连接" wrapped to four lines. Only the leading dot may be sized.
  const dots = css.match(/\.state-dot,\s*\.local-tag > span:empty\s*\{([^}]*)\}/);
  assert.ok(dots, "the dot rule must target only the empty leading span");
  const tag = rule(".local-tag {");
  assert.match(tag, /white-space:\s*nowrap/);
  assert.match(tag, /min-width:\s*0/, "it has to be allowed to shrink, not just refuse to wrap");
});

test("the summary value shrinks instead of spilling past the card", () => {
  // The endpoint read "socks5://12" with the rest outside the panel, because the meta
  // block refused to shrink.
  const meta = rule(".panel-summary .summary-meta");
  assert.match(meta, /min-width:\s*0/);
  const heading = rule(".panel-summary > div:first-child");
  assert.match(heading, /min-width:\s*0/);
});

test("buttons do not break their labels across lines", () => {
  const secondary = rule(".secondary-button {");
  assert.match(secondary, /white-space:\s*nowrap/);
});

test("the current-site actions wrap rather than squeeze", () => {
  // Three buttons and a text link in one row at 380px cannot all fit; the row has to
  // break, and the destructive link belongs on its own line.
  const actions = rule(".site-actions {");
  assert.match(actions, /flex-wrap:\s*wrap/);
  // It must not float to the right on its own line once the row wraps.
  assert.match(rule(".site-actions .text-button"), /flex:\s*0 0 auto/);
});

test("the collapsed endpoint is short enough to fit its own summary", () => {
  // A scheme prefix costs about 60px at this width. The tooltip keeps the full URL.
  const host = "127.0.0.1";
  const port = "7890";
  const short = `${host}:${port}`;
  const full = `socks5://${host}:${port}`;
  assert.ok(short.length <= 22, "the summary value must stay short");
  assert.ok(full.length > short.length);
});

test("the header wordmark is sized to fit the popup without compressing labels", () => {
  // The brand lockup is mark + stacked wordmark + caption, and it shares one 380px
  // row with the settings button and the state pill. An earlier attempt put
  // "远黛 YUANDAI" on a single line: 128px of text into the 101px the row can
  // spare, which is the same squeezed-label failure the layout pass removed.
  //
  // The widths below are conservative estimates (CJK at 1em, Latin serif at 0.62em)
  // deliberately rather than exact metrics: this is a guard against a regression of
  // that order of magnitude, not a pixel-perfect proof.
  const inner = 318; // 380px popup minus the shell's horizontal padding
  const mark = 42;
  const lockupGap = 10;
  const actions = 68 + 80 + 7; // settings button + state pill + their gap
  const topbarGap = 10;
  const available = inner - mark - lockupGap - actions - topbarGap;

  const size = (token) => Number(new RegExp(`--${token}:\\s*([\\d.]+)px`).exec(css)?.[1]);
  const textXl = size("text-xl");
  const textXs = size("text-xs");
  assert.ok(textXl && textXs, "the type scale must define --text-xl and --text-xs");

  const wordmark = html.slice(html.indexOf('class="brand-name"'), html.indexOf('class="brand-caption"'));
  assert.ok(!/YUANDAI/.test(html.slice(html.indexOf('class="brand-name"'), html.indexOf('class="brand-sub"'))),
    "the Latin wordmark must not share a line with the Chinese one");

  // Two CJK glyphs at --text-xl, plus letter-spacing.
  const chinese = 2 * textXl * 1.02;
  // Seven Latin glyphs at --text-xs with .3em tracking.
  const latin = 7 * textXs * 0.62 + 6 * textXs * 0.3;
  // The caption is the product name; measure it as Latin rather than CJK glyphs.
  // Whichever string sits there, it must fit the same budget as the rest of the lockup.
  const caption = html.slice(html.indexOf('class="brand-caption"'));
  const captionText = /class="brand-caption">([^<]*)</.exec(caption)?.[1] ?? "";
  const captionIsCjk = /[\u4e00-\u9fff]/.test(captionText);
  const captionWidth = captionText.length * textXs * (captionIsCjk ? 1 : 0.58);

  for (const [label, width] of [["wordmark", chinese], ["Latin sub-line", latin], ["caption", captionWidth]]) {
    assert.ok(width <= available, `${label} needs ${Math.round(width)}px but only ${available}px is free`);
  }
});

test("the entrance animation cannot change layout", () => {
  // Round 10's constraint was a short page. An entrance animation that animated
  // height or margin would fight the panels' own sizing while the popup is still
  // measuring itself; opacity and transform are compositor properties and take no
  // space in the flow.
  const keyframes = /@keyframes panel-enter \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(keyframes, "the panel entrance animation is missing");

  const properties = [...keyframes.matchAll(/([a-z-]+)\s*:/g)]
    .map((match) => match[1])
    .filter((property) => property !== "from" && property !== "to");
  for (const property of new Set(properties)) {
    assert.ok(["opacity", "transform"].includes(property),
      `panel-enter animates ${property}, which triggers layout`);
  }

  // Every panel that shares the animation must also be switched off when the system
  // asks for reduced motion. A panel left out would still slide for those users.
  const reduced = /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bypass-panel[^}]*animation: none/.test(css);
  assert.ok(reduced, "the reduced-motion block must cover the animated panels");
});
