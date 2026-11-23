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
