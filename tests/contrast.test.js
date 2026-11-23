/**
 * Text contrast.
 *
 * This exists because the earlier readability pass fixed font sizes and never
 * checked colour: enlarging text that is too light does not make it readable. Three
 * pairs failed when measured, all in the light theme.
 *
 * Computed from the stylesheet rather than hardcoded, so a palette change is checked
 * instead of the test restating today's numbers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const css = await readFile(path.join(process.cwd(), "src/popup.css"), "utf8");

/** Pulls one custom property out of a :root block. */
function readTheme(block) {
  const values = {};
  for (const match of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    values[match[1]] = match[2];
  }
  return values;
}

function themeBlocks() {
  const lightStart = css.indexOf(":root {");
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  const light = css.slice(lightStart, darkStart > lightStart ? darkStart : undefined);
  const dark = darkStart > -1 ? css.slice(darkStart, css.indexOf("}", css.indexOf(":root {", darkStart))) : "";
  return { light: readTheme(light), dark: readTheme(dark) };
}

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function rgb(hex) {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pairs that actually occur in the markup, at body size.
 *
 * 4.5:1 is the AA threshold for text below 18.66px bold / 24px regular. Nothing in
 * this panel is that large, so everything is held to 4.5.
 */
const PAIRS = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "surface-soft"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent", "accent-soft"],
  ["accent-strong", "accent-soft"],
  ["danger", "surface"],
  ["danger", "bg"]
];

for (const [name, theme] of Object.entries(themeBlocks())) {
  test(`every text pair meets WCAG AA in the ${name} theme`, () => {
    const missing = PAIRS.flat().filter((token) => !theme[token]);
    assert.deepEqual(missing, [], `theme is missing tokens: ${missing.join(", ")}`);

    const failures = [];
    for (const [foreground, background] of PAIRS) {
      const value = contrast(theme[foreground], theme[background]);
      if (value < 4.5) {
        failures.push(`${foreground} on ${background} = ${value.toFixed(2)}:1 (needs 4.5)`);
      }
    }
    assert.deepEqual(failures, [], `contrast failures in ${name}:\n  ${failures.join("\n  ")}`);
  });
}

test("the stylesheet references no font size below 10px", () => {
  // 9px body text was the readability complaint; the type scale exists so it does
  // not creep back in as a one-off.
  const tooSmall = [...css.matchAll(/font-size:\s*([\d.]+)px/g)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 10);
  assert.deepEqual(tooSmall, []);
});

test("the type scale is defined and used rather than duplicated", () => {
  const scale = [...css.matchAll(/--text-[a-z0-9]+:\s*[\d.]+px/g)].map((match) => match[0]);
  assert.ok(scale.length >= 4, "the scale should define at least four steps");
  const uses = [...css.matchAll(/font-size:\s*var\(--text-[a-z0-9]+\)/g)].length;
  assert.ok(uses > 20, `the scale should be the normal way to set text size, saw ${uses}`);
});

test("every colour outside the brand mark comes from a variable", () => {
  // This is what makes a re-theme possible. Before it, changing the accent colour
  // meant finding 53 hardcoded hex values across the stylesheet, and the amber
  // warning family existed in seven separate places. Colours belonging to the logo
  // SVG are exempt on purpose: they follow the logo, not the theme.
  const start = css.indexOf("}", css.indexOf(":root {"));
  const body = css.slice(start);
  const offenders = [];
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().split("\n").pop().trim();
    if (/brand-mark|:root|xee|route-(proxy|direct|unknown)/.test(selector)) continue;
    for (const colour of match[2].match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
      offenders.push(`${selector} -> ${colour}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded colours outside variables:\n  ${offenders.join("\n  ")}`);
});

test("both themes define the same colour variables", () => {
  // A variable added to one theme and not the other falls back to the light value,
  // which is how a dark theme ends up with a bright amber block in the middle.
  const blocks = css.match(/:root \{([\s\S]*?)\}/g) ?? [];
  assert.ok(blocks.length >= 2, "expected a light and a dark :root block");
  const names = (block) => new Set([...block.matchAll(/--([a-z-]+):/g)].map((m) => m[1]).filter((n) => !n.startsWith("text-")));
  const [light, dark] = blocks.map(names);
  const missingInDark = [...light].filter((name) => !dark.has(name));
  const missingInLight = [...dark].filter((name) => !light.has(name));
  assert.deepEqual(missingInDark, [], `dark theme is missing: ${missingInDark.join(", ")}`);
  assert.deepEqual(missingInLight, [], `light theme is missing: ${missingInLight.join(", ")}`);
});
