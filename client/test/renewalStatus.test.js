'use strict';

// RenewalManagement used to carry its own `STATUS_BADGE` map alongside the
// shared StatusBadge, and the two disagreed about the same words:
//
//   renewal Active   -> bg-emerald-100 (green)   | StatusBadge -> rz-active (slate)
//   renewal Approved -> bg-blue-100    (blue)    | StatusBadge -> bg-[#eaf8f1] (green)
//   renewal Expired  -> bg-red-100     (red)     | StatusBadge -> rz-expired (pale slate)
//
// and the map only covered three of the nine contract statuses, so the other
// six fell through to a `bg-slate-100` fallback that the dark-mode overrides
// rewrite. The Status column now renders <StatusBadge> directly.
//
// How close a contract is to expiring is a different question and keeps its
// own vocabulary (`rz-urgency-*`), deliberately outside the neutral ramp.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const renewal = read('src/pages/RenewalManagement.js');
const css = read('src/index.css');
const dateUtils = read('src/utils/date.js');
const badge = read('src/components/Layout/Common/StatusBadge.js');

const parseMap = (block) => {
  const out = {};
  for (const [, k, v] of block.matchAll(/'?([A-Za-z0-9][\w ]*?)'?:\s*'([^']*)'/g)) out[k.trim()] = v;
  return out;
};

const TIERS = parseMap(renewal.slice(renewal.indexOf('const reminderStyles'), renewal.indexOf('};', renewal.indexOf('const reminderStyles'))));

/* ---------------- colour maths, same as the other suites ---------------- */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const distance = (a, b) => {
  const A = hex(a); const B = hex(b);
  return Math.sqrt(0.3 * (A[0] - B[0]) ** 2 + 0.59 * (A[1] - B[1]) ** 2 + 0.11 * (A[2] - B[2]) ** 2);
};

/** Resolve a CSS rule body, including rgba() fills. */
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};
const decl = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[\\s;{])${prop}\\s*:\\s*(#[0-9a-f]{6}|rgba?\\([^)]*\\))`, 'i'));
  return m ? m[1] : null;
};

/** Flatten an rgba() fill onto a hex card, the way a browser paints it. */
const over = (value, card) => {
  if (!value.startsWith('rgba')) return value;
  const p = value.match(/[\d.]+/g).map(Number);
  const a = p.length > 3 ? p[3] : 1;
  const b = hex(card);
  return (
    '#' +
    [0, 1, 2]
      .map((i) => Math.round(p[i] * a + b[i] * (1 - a)).toString(16).padStart(2, '0'))
      .join('')
  );
};

const CARD = { light: '#ffffff', dark: '#141c2e' };

const urgencyPill = (cls, theme) => {
  const body = rule(theme === 'dark' ? `.dark .${cls}` : `.${cls}`);
  assert.ok(body, `${theme} rule for ${cls} is missing from index.css`);
  const card = CARD[theme];
  const raw = decl(body, 'background-color');
  return {
    fill: over(raw, card),
    raw,
    text: decl(body, 'color')
  };
};

/* ---------------- the urgency vocabulary ---------------- */

test('the three urgency tiers map to the semantic classes', () => {
  assert.deepEqual(TIERS, { 30: 'rz-urgency-30', 60: 'rz-urgency-60', 90: 'rz-urgency-90' });
});

test('every urgency tier is defined for both themes and clears WCAG AA', () => {
  for (const theme of ['light', 'dark']) {
    for (const cls of Object.values(TIERS)) {
      const p = urgencyPill(cls, theme);
      const ratio = contrast(p.text, p.fill);
      assert.ok(ratio >= 4.5, `${cls} (${theme}) is ${ratio.toFixed(2)}:1, below AA`);
    }
  }
});

test('the three urgency tiers stay distinguishable in both themes', () => {
  const names = Object.values(TIERS);
  for (const theme of ['light', 'dark']) {
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = urgencyPill(names[i], theme);
        const b = urgencyPill(names[j], theme);
        const dFill = distance(a.fill, b.fill);
        const dText = distance(a.text, b.text);
        assert.ok(
          dFill >= 25 || dText >= 40,
          `${names[i]} / ${names[j]} (${theme}) too close: fill=${dFill.toFixed(0)} text=${dText.toFixed(0)}`
        );
      }
    }
  }
});

/** Hue in degrees, for asserting the tiers are different colour families. */
const hue = (h) => {
  const [r, g, b] = hex(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let deg;
  if (max === r) deg = 60 * (((g - b) / d) % 6);
  else if (max === g) deg = 60 * ((b - r) / d + 2);
  else deg = 60 * ((r - g) / d + 4);
  return (deg + 360) % 360;
};
/** Shortest distance around the colour wheel. */
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('the urgency tiers are three distinct colour families, red being the most urgent', () => {
  // Hue is what carries the meaning here, not lightness -- Tailwind's 100-level
  // tints do not form a monotonic lightness ramp and were not asked to.
  for (const theme of ['light', 'dark']) {
    const hues = [30, 60, 90].map((t) => hue(urgencyPill(TIERS[t], theme).fill));
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        assert.ok(
          hueGap(hues[i], hues[j]) >= 25,
          `${theme}: tiers ${[30, 60, 90][i]} and ${[30, 60, 90][j]} are only ` +
            `${hueGap(hues[i], hues[j]).toFixed(0)}deg apart on the wheel`
        );
      }
    }
    // Red reads as 0deg in light and drifts to ~312deg in dark, where the
    // low-alpha red is composited onto a blue-ish surface and the matching
    // label is pink. Both sit in the warm band.
    assert.ok(
      hues[0] >= 300 || hues[0] <= 20,
      `${theme}: the 30-day tier is hue ${hues[0].toFixed(0)}, expected the warm/red family`
    );
  }
});

test('the urgency rules are unlayered, so the dark overrides cannot rewrite them', () => {
  for (const cls of Object.values(TIERS)) {
    assert.match(css, new RegExp(`^\\.dark \\.${cls} \\{`, 'm'), `.dark ${cls} must be top level`);
  }
  assert.equal(css.match(/@layer[^{]*\{[^@]*?rz-urgency/), null, 'rz-urgency must not sit in an @layer');
});

test('no urgency tier reuses a legacy utility the theme rewrites', () => {
  for (const [tier, cls] of Object.entries(TIERS)) {
    assert.doesNotMatch(cls, /bg-|text-/, `tier ${tier} should be a bare semantic class`);
  }
  assert.doesNotMatch(renewal.slice(0, renewal.indexOf('};', renewal.indexOf('const reminderStyles'))), /blue/, 'blue is gone from the urgency map');
});

/* ---------------- status column ---------------- */

test('the Status column renders the shared StatusBadge', () => {
  assert.match(renewal, /import StatusBadge from '\.\.\/components\/Layout\/Common\/StatusBadge';/);
  assert.match(renewal, /<StatusBadge status=\{contract\.status\} \/>/);
});

test('the local STATUS_BADGE map is gone', () => {
  assert.doesNotMatch(renewal, /STATUS_BADGE/);
  // The three values it used to carry.
  for (const stale of ['bg-emerald-100 text-emerald-700', 'bg-blue-100 text-blue-700', 'bg-red-100 text-red-700']) {
    assert.doesNotMatch(renewal, new RegExp(stale.replace(/[[\]#]/g, '\\$&')), `${stale} survived`);
  }
});

test('every contract status the server can return is covered by StatusBadge', () => {
  const server = fs.readFileSync(
    path.join(ROOT, '..', 'server', 'utils', 'contractTransitions.js'),
    'utf8'
  );
  const statuses = [...server.match(/VALID_STATUSES[\s\S]*?\]/)[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(statuses.length, 9, 'expected nine contract statuses');
  const neutral = parseMap(badge.slice(badge.indexOf('const neutralStyles'), badge.indexOf('const styles')));
  const coloured = parseMap(badge.slice(badge.indexOf('const styles'), badge.indexOf('const StatusBadge')));
  for (const s of statuses) {
    assert.ok(neutral[s] || coloured[s], `StatusBadge does not render "${s}"`);
  }
});

test('the Status cell keeps no slate fallback of its own', () => {
  assert.doesNotMatch(renewal, /bg-slate-100 text-slate-/, 'an overridable slate fallback survived');
  // The cell holds nothing but the shared component, so the unknown-status
  // fallback comes from StatusBadge rather than being duplicated here.
  // `rz-unknown` is still expected on the page, for the two reminder chips.
  assert.match(
    renewal,
    /<td className="px-4 py-3">\s*<StatusBadge status=\{contract\.status\} \/>\s*<\/td>/,
    'the Status cell should contain only <StatusBadge>'
  );
});

/* ---------------- de-duplication ---------------- */

test('the Days Remaining chip reuses reminderTier instead of re-deriving the thresholds', () => {
  // The inline `daysRemaining <= 30 ? ... : <= 60 ? ...` ternary duplicated
  // reminderTier(), which is what let the two columns drift apart.
  assert.doesNotMatch(renewal, /daysRemaining\s*<=\s*30/, 'the inline tier ternary is back');
  assert.match(renewal, /reminderStyles\[reminderTier\(contract\.daysRemaining\)\]/);
  assert.match(dateUtils, /export const reminderTier/, 'reminderTier must still exist');
});

test('reminderTier boundaries still match the chip tiers', () => {
  const body = dateUtils.slice(dateUtils.indexOf('export const reminderTier'));
  const fn = body.slice(0, body.indexOf('};'));
  assert.match(fn, /days\s*<=\s*30\)\s*return 30/);
  assert.match(fn, /days\s*<=\s*60\)\s*return 60/);
  assert.match(fn, /return 90/);
  for (const tier of [30, 60, 90]) {
    assert.ok(TIERS[tier], `tier ${tier} has no chip class`);
  }
});

test('an unrecognised reminder falls back to the shared unknown pill', () => {
  // Two chips on the reminder table, plus one on the awaiting-renewal table
  // added in phase 8. The count is a floor, not an exact total -- what matters
  // is that *every* chip carries the fallback, which the loop below checks.
  const uses = renewal.match(/reminderStyles\[[^\]]+\] \|\| '([^']+)'/g) || [];
  assert.ok(uses.length >= 2, 'the reminder chips should have fallbacks');
  for (const use of uses) {
    assert.match(use, /\|\| 'rz-pill rz-unknown'/);
  }
});

test('the reminder chips stay borderless so all three tiers match', () => {
  for (const cls of Object.values(TIERS)) {
    assert.doesNotMatch(cls, /rz-pill/, `${cls} should not request a border`);
  }
  const chips = renewal.split('\n').filter((l) => l.includes('rounded-full') && l.includes('reminderStyles['));
  assert.ok(chips.length >= 2, 'expected the Days Remaining and Reminder chips');
  for (const chip of chips) {
    const before = chip.slice(0, chip.indexOf('reminderStyles['));
    assert.doesNotMatch(before, /\bborder\b/, 'a chip gained a border');
  }
});

/* ---------------- the recolouring trap ---------------- */

test('no chip depends on a colour utility that index.css recolours or Tailwind purges', () => {
  // Verified in real Chrome, not just in the stylesheet:
  //
  //   light  .bg-blue-100 -> rgba(0,0,0,0)     (bare utility purged; only the
  //                                               .dark override survives)
  //   light  .text-blue-700 -> rgb(213,29,41)   (index.css:472 forces brand red)
  //
  // So the old `bg-blue-100 text-blue-700` chips rendered as brand-red text on
  // #dbeafe at 4.26:1 in light mode -- below AA, and reading as a warning rather
  // than the state it named. These are now semantic classes, so assert the
  // utilities stay out of the maps entirely.
  assert.match(
    css,
    /\.ricoz-shell main \.text-blue-600,\s*\.ricoz-shell main \.text-blue-700 \{\s*color: #d51d29;/,
    'index.css no longer rewrites text-blue-700, so this guard can be revisited'
  );
  for (const [tier, cls] of Object.entries(TIERS)) {
    assert.doesNotMatch(cls, /blue/, `the ${tier}-day tier reached for a blue utility`);
  }
  assert.doesNotMatch(renewal, /text-blue-700|bg-blue-100/, 'a chip reached for a recoloured blue utility');
});

/* ---------------- untouched behaviour ---------------- */

test('the error banner, Retry button and Renew action keep their colours', () => {
  assert.match(renewal, /rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700/, 'error banner changed');
  assert.match(renewal, /border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100/, 'Retry changed');
  assert.match(renewal, /bg-\[#0f172a\] px-3 py-2 text-xs font-semibold text-white hover:bg-\[#1e293b\]/, 'Renew action changed');
  assert.match(renewal, /bg-\[#0f172a\] text-white|filter === option\.value \? 'bg-\[#0f172a\] text-white'/, 'filter chip changed');
});

test('no status value, permission or request was touched', () => {
  // The two endpoints and their verbs, unchanged.
  assert.match(renewal, /API\.get\('\/renewals\/expiring'\)/);
  assert.match(renewal, /API\.get\('\/renewals\/history'\)/);
  // Tier filtering still goes through reminderTier, as it did before.
  assert.match(renewal, /reminderTier\(contract\.daysRemaining\) === filter/);
  // Still keyed by the server-supplied reminder number.
  assert.match(renewal, /\{contract\.reminder\}-day/);
});
