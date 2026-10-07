'use strict';

// Regression guard for the landing page's text contrast.
//
// The page sits outside `.ricoz-shell main`, so none of the theme-token
// overrides at the bottom of index.css reach it: every colour it renders is
// whatever the className on the element resolves to. That makes the classNames
// the only place a contrast claim can be checked, and it is exactly where the
// defects lived.
//
// Measured in headless Chrome against the production build:
//
//   How It Works step numeral    #94a3b8 on #ffffff = 2.56  ->  #5f6e83 = 5.19
//   muted copy on the page tint  #64748b on #f4f6f9 = 4.40  ->  #5f6e83 = 4.80
//   preview "Lifecycle stages"   #64748b on #162032 = 3.43  ->  slate-400 = 6.36
//   footer wordmark, dark        slate-500 on #0b1220 = 3.93  ->  slate-400 = 7.30
//
// All four are WCAG 1.4.3 failures (4.5:1 for normal text). This file reads the
// real classNames out of LandingPage.js and recomputes the ratios, so a later
// tweak to either the colour or the surface cannot quietly reintroduce one of
// them. The same arithmetic-not-a-browser approach is used by statusBadge.test.js
// and workItemStatus.test.js, because this repository has no browser test runner.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src');
const landing = fs.readFileSync(path.join(SRC, 'pages', 'LandingPage.js'), 'utf8');

// The Tailwind default steps the landing page actually names.
const SLATE = { 100: '#f1f5f9', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b' };

// The surfaces these strings are measured against, taken from the page's own
// container classes: the root wrapper, the white step card, the dark step card,
// the preview panel, and the preview panel's dark fill.
const PAGE_LIGHT = '#f4f6f9'; // bg-[#f4f6f9]
const PAGE_DARK = '#0b1220'; // dark:bg-[#0b1220]
const CARD_LIGHT = '#ffffff'; // bg-white
const CARD_DARK = '#141c2e'; // dark:bg-[#141c2e]
const PREVIEW_LIGHT = '#f8fafc'; // bg-[#f8fafc]
const PREVIEW_DARK = '#162032'; // dark:bg-[#162032]
const HEADER_LIGHT = '#fefefe'; // bg-white/90 over PAGE_LIGHT
const HEADER_DARK = '#101726'; // bg-[#101827]/90 over PAGE_DARK
const BREADCRUMB_DARK = '#1a2436'; // dark:bg-[#1a2436]

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
/** `bg-white/90` and friends paint as an alpha wash over whatever is behind. */
const over = (fg, alpha, bg) => {
  const f = hex(fg);
  const b = hex(bg);
  return (
    '#' +
    f
      .map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0'))
      .join('')
  );
};

/**
 * The `className="..."` that governs the element rendered at `needle`. The
 * needle sits inside that element, so the className is the nearest one before
 * it. `last` picks the final match instead of the first, for text that appears
 * more than once on the page.
 */
const classNameAt = (needle, { last = false } = {}) => {
  const at = last ? landing.lastIndexOf(needle) : landing.indexOf(needle);
  assert.notEqual(at, -1, `no "${needle}" in LandingPage.js`);
  const before = landing.lastIndexOf('className="', at);
  assert.notEqual(before, -1, `no className before "${needle}"`);
  const start = before + 'className="'.length;
  const end = landing.indexOf('"', start);
  assert.notEqual(end, -1, `unterminated className before "${needle}"`);
  return landing.slice(start, end);
};

/**
 * The single className in the file that contains `fragment`. Used where the
 * element's own children sit between it and the className, which makes a
 * backwards search from a text needle land on the wrong element.
 */
const classNameContaining = (fragment) => {
  const matches = Array.from(landing.matchAll(/className="([^"]*)"/g), (m) => m[1]).filter((c) =>
    c.includes(fragment)
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one className containing "${fragment}", found ${matches.length}`
  );
  return matches[0];
};

/**
 * The foreground a className resolves to in one theme. The light pass reads the
 * base utility, the dark pass the `dark:` one; a colour that has no `dark:`
 * counterpart renders unchanged in both, which is precisely what went wrong
 * with the step numeral.
 */
const foreground = (className, theme) => {
  const variant = theme === 'dark' ? 'dark:' : '';
  // The utility has to start the className or follow a space, never a `:` --
  // that would mean `hover:` or another variant standing in for the element's
  // own colour.
  const patterns = [
    { re: new RegExp(`(?:^|[\\s"])${variant}text-\\[#([0-9a-f]{6})\\]`, 'i'), hex: true },
    { re: new RegExp(`(?:^|[\\s"])${variant}text-slate-(\\d{3})(?![0-9])`), hex: false }
  ];
  for (const { re, hex: isHex } of patterns) {
    const m = className.match(re);
    if (m) {
      const step = isHex ? m[1].toLowerCase() : SLATE[Number(m[1])];
      assert.ok(step, `unmapped colour in: ${className}`);
      return isHex ? `#${step}` : step;
    }
  }
  throw new Error(`no ${variant}text-* colour in: ${className}`);
};

// Every string below plays the same role: secondary copy. `colourAt` is where
// the element that sets its colour lives, which is not always the element the
// text sits on -- the section links inherit theirs from the <nav>.
const CASES = [
  {
    name: 'How It Works step numeral',
    colourAt: '>0{index + 1}</span>',
    light: CARD_LIGHT,
    dark: CARD_DARK
  },
  {
    name: 'hero lede paragraph',
    colourAt: 'RicozContract is a workspace for the whole contract lifecycle',
    light: PAGE_LIGHT,
    dark: PAGE_DARK
  },
  {
    name: 'How It Works intro paragraph',
    colourAt: 'Each step maps to a screen in the app',
    light: PAGE_LIGHT,
    dark: PAGE_DARK
  },
  {
    // The header nav was already legible (4.72:1) and reads as navigation rather
    // than secondary copy, so it keeps its own stronger colour and is excluded
    // from the shared-muted-value checks below.
    name: 'header section link',
    colourAt: 'aria-label="Sections"',
    mutedRole: false,
    light: HEADER_LIGHT,
    dark: HEADER_DARK
  },
  {
    name: 'footer section link',
    colourAt: 'aria-label="Footer"',
    light: PAGE_LIGHT,
    dark: PAGE_DARK
  },
  {
    name: 'footer wordmark second half',
    colourAt: '>Contract</span>',
    last: true,
    light: PAGE_LIGHT,
    dark: PAGE_DARK
  },
  {
    name: 'product preview breadcrumb',
    colourAt: 'min-w-0 items-center gap-2 text-xs font-medium',
    inside: true,
    light: PREVIEW_LIGHT,
    dark: BREADCRUMB_DARK
  },
  {
    name: 'product preview "Lifecycle stages"',
    colourAt: '>Lifecycle stages</div>',
    light: PREVIEW_LIGHT,
    dark: PREVIEW_DARK
  }
];

/** Resolves a case's `colourAt` to the className that carries its colour. */
const classNameFor = (item) =>
  item.inside
    ? classNameContaining(item.colourAt)
    : classNameAt(item.colourAt, { last: item.last });

/** The strings that fill the muted-copy role, as opposed to the header nav. */
const MUTED_CASES = CASES.filter((item) => item.mutedRole !== false);

test('every audited landing page string clears WCAG AA for normal text', (t) => {
  for (const item of CASES) {
    const className = classNameFor(item);

    for (const theme of ['light', 'dark']) {
      const fg = foreground(className, theme);
      const painted = item[theme];
      const ratio = contrast(fg, painted);
      t.diagnostic(
        `${item.name} (${theme})`.padEnd(46) +
          `${fg} on ${painted}`.padEnd(28) +
          `= ${ratio.toFixed(2)}:1`
      );
      assert.ok(
        ratio >= 4.5,
        `${item.name} is ${ratio.toFixed(2)}:1 in the ${theme} theme, below the 4.5:1 minimum`
      );
    }
  }
});

test('the surfaces the audit measures against are the ones the page paints', () => {
  // These are hand-transcribed constants, so they get checked against the
  // classNames they were taken from. If a container's fill moves, the audit is
  // measuring the wrong background and has to be re-derived.
  assert.match(classNameAt('min-h-screen'), /bg-\[#f4f6f9\]/);
  assert.match(classNameAt('min-h-screen'), /dark:bg-\[#0b1220\]/);
  assert.match(classNameAt('relative mx-auto mt-12 max-w-5xl'), /bg-white/);
  assert.match(classNameAt('relative mx-auto mt-12 max-w-5xl'), /dark:bg-\[#141c2e\]/);
  assert.match(classNameAt('rounded-xl bg-[#f8fafc] p-4'), /dark:bg-\[#162032\]/);
  assert.match(classNameAt('sticky top-0 z-50'), /bg-white\/90/);
  assert.match(classNameAt('sticky top-0 z-50'), /dark:bg-\[#101827\]\/90/);
});

test('the step numeral carries its own dark-theme colour', () => {
  // The root cause of the original 2.56:1 was one `text-[#94a3b8]` doing duty
  // for both themes: legible on the dark card (6.63:1), unreadable on the white
  // one. Any colour that lands on both cards therefore has to be stated per
  // theme rather than once.
  const className = classNameAt('>0{index + 1}</span>');
  assert.match(
    className,
    /(?:^|\s)dark:text-\S+/,
    `expected a dark: colour alongside the light one in: ${className}`
  );
});

test('the failed muted value is gone from the landing page', () => {
  // `#64748b` is the colour that measured 4.40:1 on the `#f4f6f9` page tint and
  // 3.43:1 on the dark preview panel. It is a legitimate Tailwind step, so a
  // stray `text-[#64748b]` on this page would reintroduce the failure silently.
  const offenders = landing.match(/(?:^|\s)(?:dark:)?text-\[#64748b\]/g) || [];
  assert.deepEqual(offenders, [], 'the landing page still paints muted text with #64748b');
});

test('all of the muted copy on the page shares one light-mode colour', () => {
  // The page used to spell its muted grey out in seven places, which is how the
  // hero, preview and footer drifted apart. One value for the role means the next
  // surface it lands on cannot fail on its own.
  const values = new Set(
    MUTED_CASES.map((item) => foreground(classNameFor(item), 'light'))
  );
  assert.deepEqual(Array.from(values), ['#5f6e83']);
});

test('all of the muted copy on the page shares one dark-mode colour', () => {
  const values = new Set(
    MUTED_CASES.map((item) => foreground(classNameFor(item), 'dark'))
  );
  assert.deepEqual(Array.from(values), ['#94a3b8']);
});

test('the alpha header fill composites the way the audit assumed', () => {
  // HEADER_LIGHT and HEADER_DARK are pre-composited constants; re-derive them so
  // a change to the header's alpha or its dark fill cannot go unnoticed.
  assert.equal(over('#ffffff', 0.9, PAGE_LIGHT), HEADER_LIGHT);
  assert.equal(over('#101827', 0.9, PAGE_DARK), HEADER_DARK);
});