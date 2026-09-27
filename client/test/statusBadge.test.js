'use strict';

// Regression guard for StatusBadge's dark mode.
//
// The bug this exists for: index.css rewrites `bg-slate-*`, `text-slate-*` and
// `border-slate-*` inside `.ricoz-shell main` to theme tokens, and because
// those rules are unlayered they outrank Tailwind's `dark:` utilities. A pill
// built from slate classes therefore kept its LIGHT values in dark mode --
// Draft, Expired and Closed all collapsed onto one identical pill.
//
// The values are parsed out of the real source (index.css for the rz-* rules,
// StatusBadge.js for the utility classes) and composited over the actual card
// colour, so the assertions cannot drift away from what ships.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const css = read('index.css');
const badge = read('components/Layout/Common/StatusBadge.js');

const CARD_LIGHT = '#ffffff';
const CARD_DARK = '#141c2e'; // --rz-surface, the card the pills sit in

/* ---------------- colour maths ---------------- */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const distance = (a, b) => {
  const A = hex(a); const B = hex(b);
  return Math.sqrt(0.3 * (A[0] - B[0]) ** 2 + 0.59 * (A[1] - B[1]) ** 2 + 0.11 * (A[2] - B[2]) ** 2);
};
/** Composite `fg` at `alpha` over `bg`, the way a browser paints it. */
const over = (fg, alpha, bg) => {
  const f = hex(fg); const b = hex(bg);
  return (
    '#' +
    f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')
  );
};

/** Fetch the body of a top-level CSS rule, or null. */
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};
/** Read a `prop: #hex` declaration out of a rule body. */
const hexDecl = (body, prop) => {
  // Anchored on a boundary so `color` does not match inside `background-color`
  // or `border-color`.
  const m = body.match(new RegExp(`(?:^|[\\s;{])${prop}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  return m ? m[1] : null;
};
/** Same, but also accepts the `transparent` keyword used by the fallback. */
const declValue = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[\\s;{])${prop}\\s*:\\s*(#[0-9a-f]{6}|transparent)`, 'i'));
  return m ? m[1] : null;
};

/* ---------------- Tailwind palette, for the utility-based pills ---------------- */

const TW = {
  'amber-500': '#f59e0b', 'amber-300': '#fcd34d',
  'emerald-500': '#10b981', 'emerald-300': '#6ee7b7',
  'rose-500': '#f43f5e', 'rose-300': '#fda4af',
  'rose-100': '#ffe4e6', 'rose-800': '#9f1239',
  'slate-100': '#f1f5f9', 'slate-200': '#e2e8f0', 'slate-300': '#cbd5e1',
  'slate-500': '#64748b', 'slate-600': '#475569', 'slate-700': '#334155', 'slate-800': '#1e293b'
};
const ARBITRARY = { 'bg-[#fff3e8]': '#fff3e8', 'text-[#b45309]': '#b45309', 'border-[#fed7aa]': '#fed7aa',
  'bg-[#eaf8f1]': '#eaf8f1', 'text-[#15803d]': '#15803d', 'border-[#bbf7d0]': '#bbf7d0',
  'bg-[#fff1f2]': '#fff1f2', 'text-[#be123c]': '#be123c' };

/** Resolve one `className` token to a paint colour, or null if it is not a colour. */
const paint = (token) => {
  if (ARBITRARY[token]) return { colour: ARBITRARY[token], alpha: 1 };
  const solid = token.match(/^(?:dark:)?(?:bg|text|border)-(slate|amber|emerald|rose)-(\d{3})$/);
  if (solid) return { colour: TW[`${solid[1]}-${solid[2]}`], alpha: 1 };
  const tinted = token.match(/^(?:dark:bg|dark:text|dark:border)-(\w+)-(\d{3})\/(\d{1,3})$/);
  if (tinted) return { colour: TW[`${tinted[1]}-${tinted[2]}`], alpha: Number(tinted[3]) / 100 };
  return null;
};

/** The fill / label / border a utility class string paints, in one theme. */
const fromUtilities = (classes, theme) => {
  const card = theme === 'dark' ? CARD_DARK : CARD_LIGHT;
  const tokens = classes.split(/\s+/).filter((t) => (theme === 'dark' ? t.startsWith('dark:') : !t.startsWith('dark:')));
  const out = {};
  for (const token of tokens) {
    const p = paint(token);
    if (!p) continue;
    const slot = token.replace(/^dark:/, '').split('-')[0];
    out[slot] = p.alpha < 1 ? over(p.colour, p.alpha, card) : p.colour;
  }
  return out;
};

/* ---------------- the palette under test ---------------- */

/** Pull a `{ 'Label': 'classes' }` literal out of a slice of source. */
const parseMap = (block) => {
  const out = {};
  for (const [, key, value] of block.matchAll(/'?([A-Za-z][\w ]*?)'?:\s*'([^']*)'/g)) {
    out[key.trim()] = value;
  }
  return out;
};

/** status label -> the class StatusBadge maps it to. Parsed, not restated. */
const NEUTRAL_MAP = parseMap(
  badge.slice(badge.indexOf('const neutralStyles'), badge.indexOf('const styles'))
);

/** The coloured seven, parsed from the `styles` object. */
const COLOURED_MAP = parseMap(
  badge.slice(badge.indexOf('const styles'), badge.indexOf('const StatusBadge'))
);

const neutralPill = (cls, theme) => {
  const body = rule(theme === 'dark' ? `.dark .${cls}` : `.${cls}`);
  assert.ok(body, `${theme} rule for ${cls} is missing from index.css`);
  const card = theme === 'dark' ? CARD_DARK : CARD_LIGHT;
  const raw = declValue(body, 'background-color');
  return {
    // An unfilled pill shows the card through it, so contrast is measured
    // against the card rather than against a colour of its own.
    fill: raw === 'transparent' ? card : raw,
    unfilled: raw === 'transparent',
    text: hexDecl(body, 'color'),
    border: hexDecl(body, 'border-color')
  };
};

const colouredPill = (classes, theme) => {
  const p = fromUtilities(classes, theme);
  assert.ok(p.bg, `${theme}: no fill resolved from "${classes}"`);
  assert.ok(p.text, `${theme}: no label colour resolved from "${classes}"`);
  return { fill: p.bg, text: p.text, border: p.border || null };
};

const pillFor = (status, theme) => {
  const cls = NEUTRAL_MAP[status];
  if (cls) return neutralPill(cls, theme);
  const classes = COLOURED_MAP[status];
  assert.ok(classes, `status "${status}" is not defined in StatusBadge`);
  return colouredPill(classes, theme);
};

const ALL = [...Object.keys(NEUTRAL_MAP), ...Object.keys(COLOURED_MAP)];

/* ---------------- tests ---------------- */

test('all thirteen statuses are accounted for', () => {
  assert.equal(Object.keys(NEUTRAL_MAP).length, 6, 'expected six neutral statuses');
  assert.equal(Object.keys(COLOURED_MAP).length, 7, 'expected seven coloured statuses');
  assert.equal(ALL.length, 13);
});

test('the stylesheet defines a pill and a light and dark rule per neutral status', () => {
  assert.ok(rule('.rz-pill'), '.rz-pill is missing from index.css');
  for (const cls of Object.values(NEUTRAL_MAP)) {
    assert.ok(rule(`.${cls}`), `${cls} has no light rule`);
    assert.ok(rule(`.dark .${cls}`), `${cls} has no dark rule`);
  }
});

test('.rz-pill sets a border width, and the element supplies border-style', () => {
  // border-width does nothing while border-style is `none`, so Tailwind's
  // `border` class has to stay on the element or the palette renders fill-only.
  assert.match(rule('.rz-pill'), /border-width:\s*1px/);
  assert.match(badge, /rounded-full border /, 'StatusBadge must keep the `border` class');
});

test('every status label clears WCAG AA against its own fill', () => {
  for (const theme of ['light', 'dark']) {
    for (const status of ALL) {
      const p = pillFor(status, theme);
      const ratio = contrast(p.text, p.fill);
      assert.ok(
        ratio >= 4.5,
        `${status} (${theme}) label is ${ratio.toFixed(2)}:1, below AA 4.5:1 ` +
          `(text ${p.text} on ${p.fill})`
      );
    }
  }
});

test('the six neutral pills stay separable in both themes', () => {
  const names = Object.keys(NEUTRAL_MAP);
  for (const theme of ['light', 'dark']) {
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = pillFor(names[i], theme);
        const b = pillFor(names[j], theme);
        const dFill = distance(a.fill, b.fill);
        const dText = distance(a.text, b.text);
        const dBorder =
          a.border && b.border ? distance(a.border, b.border) : 0;
        assert.ok(
          dFill >= 25 || dText >= 40 || dBorder >= 40,
          `${names[i]} / ${names[j]} (${theme}) too close: ` +
            `fill=${dFill.toFixed(0)} text=${dText.toFixed(0)} border=${dBorder.toFixed(0)}`
        );
      }
    }
  }
});

test('no two neutral pills share a fill inside one theme', () => {
  // The exact regression: Draft, Expired and Closed rendered one identical
  // pill in dark mode. A shared fill leaves only the border and the label.
  for (const theme of ['light', 'dark']) {
    const seen = new Map();
    for (const status of Object.keys(NEUTRAL_MAP)) {
      const { fill } = pillFor(status, theme);
      assert.ok(!seen.has(fill), `${theme}: "${status}" and "${seen.get(fill)}" share fill ${fill}`);
      seen.set(fill, status);
    }
  }
});

test('the dark rules are unlayered and outrank the light ones', () => {
  // `.rz-active` is (0,1,0), `.dark .rz-active` is (0,2,0). Both sit outside
  // @layer, which is what lets them beat Tailwind's utilities layer.
  for (const cls of Object.values(NEUTRAL_MAP)) {
    assert.match(css, new RegExp(`^\\.dark \\.${cls} \\{`, 'm'), `.dark ${cls} must be top level`);
  }
  assert.equal(css.match(/@layer[^{]*\{[^@]*?\.rz-/), null, 'rz-* must not sit inside an @layer');
});

test('the neutral pills carry no slate utility that the theme could rewrite', () => {
  // The overrides only reach elements that still carry slate utilities, so a
  // stray one would silently reinstate the original bug.
  const block = badge.slice(badge.indexOf('const neutralStyles'), badge.indexOf('const styles'));
  assert.doesNotMatch(block, /slate-/, 'the neutral states must not use slate utilities');
  for (const [status, cls] of Object.entries(NEUTRAL_MAP)) {
    assert.match(badge, new RegExp(`'?${status}'?:\\s*'${cls}'`),
      `${status} should map to ${cls}`);
  }
  assert.equal(new Set(Object.values(NEUTRAL_MAP)).size, 6, 'each status needs its own class');
});

test('the coloured statuses keep their original declarations', () => {
  const expected = {
    'Pending Review': /bg-\[#fff3e8\] text-\[#b45309\] border-\[#fed7aa\]/,
    'Pending Approval': /bg-\[#fff3e8\] text-\[#b45309\] border-\[#fed7aa\]/,
    Approved: /bg-\[#eaf8f1\] text-\[#15803d\] border-\[#bbf7d0\]/,
    Rejected: /bg-rose-100 text-rose-800 border-rose-300/,
    Pending: /bg-\[#fff3e8\] text-\[#b45309\]/,
    Completed: /bg-\[#eaf8f1\] text-\[#15803d\]/,
    Overdue: /bg-\[#fff1f2\] text-\[#be123c\]/
  };
  for (const [status, pattern] of Object.entries(expected)) {
    assert.ok(COLOURED_MAP[status], `status "${status}" disappeared`);
    assert.match(COLOURED_MAP[status], pattern, `${status} changed colour`);
  }
});

test('the badge prints the status string and nothing when it is absent', () => {
  assert.match(badge, /\{status\}/);
  assert.match(badge, /if \(!status\) return null;/);
});

/* ---------------- the unknown-status fallback ---------------- */

test('an unrecognised status falls back to a semantic class, not slate', () => {
  // The old fallback was `bg-slate-100 text-slate-700 dark:bg-slate-700/40
  // dark:text-slate-200`, which the `.dark .ricoz-shell main` overrides
  // rewrite -- exactly the bug this file guards against.
  assert.match(badge, /rz-pill \$\{neutralStyles\[status\] \|\| 'rz-unknown'\}/);
  assert.doesNotMatch(badge, /dark:bg-slate-700\/40/);
  const fallback = badge.slice(badge.indexOf('const StatusBadge'));
  assert.doesNotMatch(fallback, /bg-slate-/, 'the fallback must not carry a slate utility');
});

test('.rz-unknown is defined for both themes and clears AA', () => {
  for (const theme of ['light', 'dark']) {
    const p = neutralPill('rz-unknown', theme);
    const ratio = contrast(p.text, p.fill);
    assert.ok(ratio >= 4.5, `rz-unknown (${theme}) is ${ratio.toFixed(2)}:1, below AA`);
  }
});

test('.rz-unknown is marked with a dashed edge the six real states do not use', () => {
  assert.match(rule('.rz-unknown'), /border-style:\s*dashed/);
  for (const cls of Object.values(NEUTRAL_MAP)) {
    assert.doesNotMatch(rule(`.${cls}`) || '', /border-style/, `${cls} should stay solid`);
  }
});

test('.rz-unknown uses the unfilled channel, so no real state can be confused with it', () => {
  // The six states spend the whole slate ramp, so the fallback cannot be given
  // a seventh neutral fill. It is unfilled and outlined instead, which is a
  // category of its own and stays distinct however the ramp is later retuned.
  for (const theme of ['light', 'dark']) {
    const unknown = neutralPill('rz-unknown', theme);
    assert.ok(unknown.unfilled, `rz-unknown (${theme}) should have no fill of its own`);
    for (const status of Object.keys(NEUTRAL_MAP)) {
      const real = pillFor(status, theme);
      assert.equal(real.unfilled, false, `${status} (${theme}) must keep a real fill`);
    }
  }
});

test('.rz-unknown is readable against the card it shows through to', () => {
  for (const theme of ['light', 'dark']) {
    const unknown = neutralPill('rz-unknown', theme);
    const ratio = contrast(unknown.text, unknown.fill);
    assert.ok(ratio >= 4.5, `rz-unknown (${theme}) is ${ratio.toFixed(2)}:1 against the card`);
  }
});

test('the rz-* rules, including the fallback, are all unlayered', () => {
  for (const cls of [...Object.values(NEUTRAL_MAP), 'rz-unknown']) {
    assert.match(css, new RegExp(`^\\.dark \\.${cls} \\{`, 'm'), `.dark ${cls} must be top level`);
  }
});
