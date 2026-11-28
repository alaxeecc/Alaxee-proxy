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

/**
 * Pulls the custom properties out of a :root block.
 *
 * Colour tokens are kept in their raw form, including `var(--accent)` aliases, so
 * that tests can decide how to resolve them; anything that is not a colour (radii,
 * durations) is dropped, since the contrast pairs have no meaning for it.
 */
function readTheme(block) {
  const values = {};
  for (const match of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|var\(--[a-z-]+\))/g)) {
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

function rgb(value) {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16));
}

/**
 * Resolves a colour to opaque RGB.
 *
 * The brand tokens use rgba() for translucent surfaces (a rose wash at 9% over the
 * page). Measuring such a value directly is meaningless - it has to be composited
 * onto whatever it sits on first. Without this the contrast test would either ignore
 * those tokens or report nonsense.
 */
function resolve(value, backdrop = "#FFFFFF") {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return value;
  const [r, g, b, a = 1] = match[1].split(",").map((part) => parseFloat(part));
  const [br, bg, bb] = rgb(backdrop);
  const mix = (foreground, behind) => Math.round(foreground * a + behind * (1 - a));
  return `#${[mix(r, br), mix(g, bg), mix(b, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex) {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

let pageBackdrop = "#FAF6F4";

function contrast(foreground, background) {
  // Translucent backgrounds are resolved against the page colour first, which is what
  // the eye sees. The backdrop is set per theme before the pairs are measured.
  const solid = resolve(background, pageBackdrop);
  const front = resolve(foreground, solid);
  const [lighter, darker] = [luminance(front), luminance(solid)].sort((x, y) => y - x);
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
    pageBackdrop = theme.bg;
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

test("the dark theme is the one that actually applies", () => {
  // Two :root blocks can both exist and both look right while the second silently
  // overrides the first - which is what happened when the brand palette was added
  // alongside the previous dark theme instead of replacing it: every dark value was
  // overwritten, so dark mode kept rendering in the old teal. Counting blocks does
  // not catch that; resolving the cascade does.
  const blocks = [...css.matchAll(/:root \{([\s\S]*?)\}/g)].map((match) => match[1]);
  assert.equal(blocks.length, 2, "expected exactly one light and one dark :root");

  const effective = {};
  for (const block of blocks) {
    for (const match of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
      effective[match[1]] = match[2].trim();
    }
  }

  // Values taken from the dark block. If an older block is ever re-added after it,
  // these revert to the previous palette and this fails.
  assert.equal(effective.bg, "#141013");
  assert.equal(effective.accent, "#EE8AB6");
  assert.equal(effective["route-direct"], "#5FC9B4");
  assert.equal(effective["route-forced"], "#F0B56E");
});

test("both themes define the same colour variables", () => {
  // A variable added to one theme and not the other falls back to the light value,
  // which is how a dark theme ends up with a bright amber block in the middle.
  const blocks = css.match(/:root \{([\s\S]*?)\}/g) ?? [];
  assert.ok(blocks.length >= 2, "expected a light and a dark :root block");
  // Only colour tokens are expected per theme. Radii, fonts and motion curves are
  // theme-independent and live once in :root.
  const names = (block) => new Set(
    [...block.matchAll(/--([a-z-]+):/g)].map((m) => m[1])
      .filter((n) => !n.startsWith("text-") && !n.startsWith("radius") && !n.startsWith("font")
        && !["ease-ui", "ease-spring", "ease-breath", "ui-duration", "view-duration", "breath"].includes(n))
  );
  const [light, dark] = blocks.map(names);
  const missingInDark = [...light].filter((name) => !dark.has(name));
  const missingInLight = [...dark].filter((name) => !light.has(name));
  assert.deepEqual(missingInDark, [], `dark theme is missing: ${missingInDark.join(", ")}`);
  assert.deepEqual(missingInLight, [], `light theme is missing: ${missingInLight.join(", ")}`);
});

/**
 * sRGB -> OKLab.
 *
 * Luminance contrast cannot answer "are these two colours distinguishable": a rose
 * and a grey can share a relative luminance exactly (measured 1.00:1 here) while
 * looking nothing alike. Perceptual distance in OKLab can.
 */
function toLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function oklab(hex) {
  const [r, g, b] = rgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function deltaE(a, b) {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

test("the four route colours are distinguishable from each other and from the page", () => {
  // The states are told apart by colour alone, at 16px, so the colours have to be
  // perceptually far apart - not merely different hex strings. Darker-than-0.05 is
  // the threshold where a difference stops being a judgement call and becomes
  // visible in one glance.
  for (const [name, theme] of Object.entries(themeBlocks())) {
    const page = resolve(theme.bg);
    const routes = ["proxy", "direct", "forced", "unknown"].map((route) => {
      const raw = theme[`route-${route}`];
      assert.ok(raw, `${name}: --route-${route} is undefined`);
      // Some route colours alias an existing token rather than restating a hex.
      const alias = /^var\(--([a-z-]+)\)$/.exec(raw);
      const value = alias ? theme[alias[1]] : raw;
      assert.ok(value, `${name}: --route-${route} aliases an unknown token`);
      return [route, resolve(value, page)];
    });

    for (const [route, colour] of routes) {
      // 3:1 is the AA threshold for non-text graphics, and a toolbar icon is that.
      assert.ok(contrast(colour, theme.surface) >= 3, `${name}: ${route} is under 3:1 on the surface`);
    }

    for (let i = 0; i < routes.length; i += 1) {
      for (let j = i + 1; j < routes.length; j += 1) {
        const distance = deltaE(routes[i][1], routes[j][1]);
        assert.ok(
          distance >= 0.05,
          `${name}: ${routes[i][0]} and ${routes[j][0]} are too close (deltaE ${distance.toFixed(3)})`
        );
      }
    }
  }
});

test("pill text stays legible on its own tint", () => {
  // The pill paints route-coloured text over an 9-11% tint of that same colour. It
  // is the tightest pairing in the palette, and a test that only reads :root never
  // sees it: the first draft of the teal and amber passed as bare values on white
  // but measured 3.59:1 and 3.07:1 once tinted.
  //
  // The alphas below mirror .route-good / .route-proxy / .route-forced in popup.css.
  const TINTS = { proxy: 0.09, direct: 0.09, forced: 0.11 };

  for (const [name, theme] of Object.entries(themeBlocks())) {
    pageBackdrop = theme.bg;
    for (const [route, alpha] of Object.entries(TINTS)) {
      const raw = theme[`route-${route}`];
      const alias = /^var\(--([a-z-]+)\)$/.exec(raw);
      const colour = resolve(alias ? theme[alias[1]] : raw, theme.bg);

      const surface = rgb(theme.surface);
      const tinted = `#${rgb(colour)
        .map((value, index) => Math.round(value * alpha + surface[index] * (1 - alpha)).toString(16).padStart(2, "0"))
        .join("")}`;

      const value = contrast(colour, tinted);
      assert.ok(value >= 4.5, `${name}: ${route} pill text is ${value.toFixed(2)}:1 (needs 4.5)`);
    }
  }
});
