'use strict';

// Milestones and Obligations each keep their own four-state work-item
// vocabulary, separate from the thirteen contract statuses in StatusBadge.
//
// In Progress used to be `bg-blue-100 text-blue-700` here, which meant the
// same word rendered slate in StatusBadge and blue on these two pages. It now
// shares StatusBadge's `rz-inprogress`. Pending, Completed and Overdue keep
// their bright hue on purpose: the work-item scale is a set of four obvious
// signals, and flattening it to grey would cost the meaning.
//
// The blue "Start / Reopen" buttons are action affordances, not status
// indicators, and deliberately stay blue -- asserted below so the distinction
// is not lost the next time someone sweeps these files for blue.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const PAGES = path.join(__dirname, '..', 'src', 'pages');
const read = (f) => fs.readFileSync(path.join(PAGES, f), 'utf8');
const milestones = read('Milestones.js');
const obligations = read('Obligations.js');
const statusBadge = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'Layout', 'Common', 'StatusBadge.js'),
  'utf8'
);

/** Pull a `{ 'Label': 'classes' }` literal out of a slice of source. */
const parseMap = (block) => {
  const out = {};
  for (const [, key, value] of block.matchAll(/'?([A-Za-z][\w ]*?)'?:\s*'([^']*)'/g)) {
    out[key.trim()] = value;
  }
  return out;
};

const workItemStyles = (source) => {
  const start = source.indexOf('const statusStyles');
  assert.notEqual(start, -1, 'statusStyles is missing');
  return parseMap(source.slice(start, source.indexOf('};', start)));
};

const MILESTONE = workItemStyles(milestones);
const OBLIGATION = workItemStyles(obligations);

/* ---------------- the four work-item states ---------------- */

test('both pages define the same four work-item statuses', () => {
  const expected = ['Pending', 'In Progress', 'Completed', 'Overdue'];
  assert.deepEqual(Object.keys(MILESTONE), expected);
  assert.deepEqual(Object.keys(OBLIGATION), expected);
});

test('Pending, Completed and Overdue keep their original colours and meaning', () => {
  const preserved = {
    Pending: 'bg-amber-100 text-amber-700',
    Completed: 'bg-emerald-100 text-emerald-700',
    Overdue: 'bg-red-100 text-red-700'
  };
  for (const [label, classes] of Object.entries(preserved)) {
    assert.equal(MILESTONE[label], classes, `Milestones ${label} changed`);
    assert.equal(OBLIGATION[label], classes, `Obligations ${label} changed`);
  }
});

test('In Progress is the shared neutral class, not blue', () => {
  for (const [name, map] of [['Milestones', MILESTONE], ['Obligations', OBLIGATION]]) {
    assert.equal(map['In Progress'], 'rz-inprogress', `${name} In Progress is not rz-inprogress`);
    assert.doesNotMatch(map['In Progress'], /blue/, `${name} In Progress is still blue`);
  }
});

test('no work-item status uses a blue utility any more', () => {
  for (const [name, map] of [['Milestones', MILESTONE], ['Obligations', OBLIGATION]]) {
    for (const [label, classes] of Object.entries(map)) {
      assert.doesNotMatch(classes, /blue/, `${name} ${label} still uses blue`);
    }
  }
});

test('work-item In Progress resolves to the same class as StatusBadge', () => {
  // One source of truth: if the two ever drift, the same word looks different
  // on different pages again.
  const block = statusBadge.slice(
    statusBadge.indexOf('const neutralStyles'),
    statusBadge.indexOf('const styles')
  );
  const NEUTRAL = parseMap(block);
  assert.equal(MILESTONE['In Progress'], NEUTRAL['In Progress']);
  assert.equal(OBLIGATION['In Progress'], NEUTRAL['In Progress']);
  assert.equal(NEUTRAL['In Progress'], 'rz-inprogress');
});

/* ---------------- chips ---------------- */

test('every work-item chip span uses statusStyles and no hardcoded colours', () => {
  for (const [name, source] of [['Milestones', milestones], ['Obligations', obligations]]) {
    const chips = source
      .split('\n')
      .filter((l) => l.includes('rounded-full') && l.includes('statusStyles['));
    // Milestones has three: the table badge, the modal badge, and the span
    // inside the summary row. Obligations has the first two.
    assert.ok(chips.length >= 2, `${name} should render at least two status chips`);
    for (const chip of chips) {
      assert.match(chip, /statusStyles\[/, `${name} chip lost its lookup`);
      assert.doesNotMatch(chip, /bg-amber|bg-blue|bg-emerald|bg-red/, `${name} chip hardcodes a colour`);
      assert.doesNotMatch(chip, /bg-slate/, `${name} chip has the overridable slate fallback`);
    }
  }
});

test('an unrecognised work-item status falls back to the semantic unknown pill', () => {
  for (const [name, source] of [['Milestones', milestones], ['Obligations', obligations]]) {
    const fallbacks = source.match(/statusStyles\[\w+\.\w+\] \|\| '([^']+)'/g) || [];
    assert.equal(fallbacks.length, 2, `${name} should have two fallbacks`);
    for (const fallback of fallbacks) {
      assert.match(fallback, /\|\| 'rz-pill rz-unknown'/);
    }
    assert.doesNotMatch(source, /bg-slate-100 text-slate-700/, `${name} kept the slate fallback`);
  }
});

test('the known work-item chips stay borderless so they match their siblings', () => {
  // rz-inprogress sets a border colour but no width or style, so it renders
  // flat exactly like Pending/Overdue/Completed. Adding rz-pill to the known
  // statuses would give one chip an outline the other three do not have.
  for (const [name, map] of [['Milestones', MILESTONE], ['Obligations', OBLIGATION]]) {
    for (const [label, classes] of Object.entries(map)) {
      assert.doesNotMatch(classes, /\bborder\b/, `${name} ${label} gained a border`);
      assert.doesNotMatch(classes, /rz-pill/, `${name} ${label} should not use rz-pill`);
    }
  }
  // The shared shape of each chip is borderless too. The `rz-pill` that does
  // appear in the markup belongs to the unknown-status fallback, which is
  // meant to be outlined and dashed.
  for (const [name, source] of [['Milestones', milestones], ['Obligations', obligations]]) {
    const shapes = source
      .split('\n')
      .filter((l) => l.includes('rounded-full') && l.includes('statusStyles['));
    for (const shape of shapes) {
      const before = shape.slice(0, shape.indexOf('statusStyles['));
      assert.doesNotMatch(before, /\bborder\b/, `${name} chip shape gained a border`);
    }
  }
});

test('the Milestones summary chips are driven by statusStyles', () => {
  // The counts row used to hardcode four colours inline, which is exactly how
  // In Progress drifted away from the badge beside it.
  const start = milestones.indexOf('flex flex-wrap gap-2 text-xs font-semibold');
  assert.notEqual(start, -1, 'the summary chip row is missing');
  const row = milestones.slice(start, milestones.indexOf('</div>', start));
  assert.match(row, /statusStyles\[label\]/, 'the chips should look their colour up');
  for (const label of ['Pending', 'In Progress', 'Overdue', 'Completed']) {
    assert.match(row, new RegExp(`'${label}',\\s*\\w+\\]`), `${label} count is missing`);
  }
  assert.doesNotMatch(row, /bg-blue-100/, 'a blue chip survived in the summary row');
  assert.doesNotMatch(row, /bg-(amber|emerald|red)-100/, 'a hardcoded chip colour survived');
});

test('the Start / Reopen action buttons stay blue', () => {
  // Actions, not statuses. Recolouring these to match the pills would
  // misread as a state change.
  for (const [name, source] of [['Milestones', milestones], ['Obligations', obligations]]) {
    assert.match(
      source,
      /rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700/,
      `${name} lost its blue action button`
    );
  }
});

/* ---------------- contrast ---------------- */

// Tailwind's own palette, confirmed against the values Chrome computed for
// these chips. The dark-mode values come from the `.dark .ricoz-shell main`
// override block in index.css, which is exercised by theme.test.js; these
// checks cover the light palette, which needs no override.
const TW = {
  'amber-100': '#fef3c7', 'amber-700': '#b45309',
  'emerald-100': '#d1fae5', 'emerald-700': '#047857',
  'red-100': '#fee2e2', 'red-700': '#b91c1c'
};

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

test('every work-item chip label clears WCAG AA in the light theme', () => {
  for (const [label, classes] of Object.entries(MILESTONE)) {
    if (classes.startsWith('rz-')) continue; // covered by statusBadge.test.js
    const fill = classes.match(/bg-(\w+)-(\d{3})/);
    const label_ = classes.match(/text-(\w+)-(\d{3})/);
    assert.ok(fill && label_, `cannot resolve the colours for ${label}`);
    const ratio = contrast(TW[`${label_[1]}-${label_[2]}`], TW[`${fill[1]}-${fill[2]}`]);
    assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
  }
});

test('Pending is the tightest work-item chip and still clears AA', () => {
  // 4.51:1 against a 4.5:1 floor. Worth pinning so a Tailwind bump to
  // amber-100 cannot quietly push it under.
  const ratio = contrast(TW['amber-700'], TW['amber-100']);
  assert.ok(ratio >= 4.5, `Pending fell to ${ratio.toFixed(2)}:1`);
  assert.ok(ratio < 5, 'if this is now comfortable, the pin can be relaxed');
});
