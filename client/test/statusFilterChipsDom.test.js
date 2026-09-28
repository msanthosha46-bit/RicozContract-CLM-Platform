'use strict';

// Behavioural Phase-8 regression tests for the work-item status filter chips.
//
// statusFilterChips.test.js pins the structure: the chips are buttons, they
// carry aria-pressed, both pages derive their rows from filterByStatus, and the
// count on a chip equals the rows underneath it. All of that is asserted by
// reading the source, because the client is ESM and the runner is CommonJS.
//
// That leaves the central claim of the fix untested: that the chips *work*.
// The bug being fixed was four chips that counted and did nothing -- shaped and
// coloured like a filter row, with no onClick. A chip that renders correctly but
// never reports a click is still exactly that bug, and no regex over the source
// can tell the two apart: `onClick={() => onChange(option.value)}` is present
// whether or not the callback is ever invoked, whether the parent re-renders, or
// whether the pressed state actually moves.
//
// statusFilterChips.test.js itself notes that "the component is JSX, so the
// runner cannot import it". That is not the case here -- notificationPopup,
// controls and theme already render real components through the same zero-install
// jsdom + Babel harness. This file imports the real component and drives it.
//
// Same harness as controls.test.js.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.ricoz.test/' });

const expose = (name, value) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

for (const name of [
  'window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage'
]) {
  expose(name, dom.window[name]);
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loadJavaScript = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(SRC + path.sep)) return loadJavaScript(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' } ]
    ]
  });
  return module._compile(code, filename);
};

const React = require('react');
const { act, useState } = React;
const { createRoot } = require('react-dom/client');
const StatusFilterChipsModule = require('../src/components/Layout/Common/StatusFilterChips');
const StatusFilterChips = StatusFilterChipsModule.default;
const { filterByStatus } = StatusFilterChipsModule;

// The vocabulary both pages pass in, copied from Milestones.js/Obligations.js so
// this test pins the shared component against the real call shape.
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'rz-inprogress',
  Completed: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700'
};

const ROWS = [
  { _id: 'm1', status: 'Pending' },
  { _id: 'm2', status: 'Pending' },
  { _id: 'm3', status: 'In Progress' },
  { _id: 'm4', status: 'Completed' },
  { _id: 'm5', status: 'Overdue' },
  { _id: 'm6', status: 'Completed' }
];

const mounted = [];

const render = async (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const buttons = (container) => [...container.querySelectorAll('button')];

// The chip is identified by its label text, not its index, so the assertions do
// not silently shift if a status is added to the vocabulary.
const chipNamed = (container, label) => buttons(container).find((b) =>
  b.textContent.replace(/\d+$/, '').trim() === label
);

const countOn = (chip) => Number(chip.textContent.replace(/[^\d]/g, ''));

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
});

/* ---------------- the controls are real and reachable ---------------- */

test('every chip is a button inside a labelled group, and All comes first', async () => {
  const container = await render(React.createElement(StatusFilterChips, {
    items: ROWS, value: 'all', onChange: () => {}, statusStyles: STATUS_STYLES
  }));

  const group = container.querySelector('[role="group"]');
  assert.ok(group, 'the chips are not in a group, so a screen reader has no name for the set');
  assert.ok(group.getAttribute('aria-label'), 'the group has no accessible name');

  const labels = buttons(container).map((b) => b.textContent.replace(/\d+$/, '').trim());
  assert.deepEqual(labels, ['All', 'Pending', 'In Progress', 'Completed', 'Overdue']);
  for (const button of buttons(container)) {
    assert.equal(button.getAttribute('type'), 'button', 'a chip would submit a surrounding form');
  }
});

test('the counts on the chips are the counts of the data', async () => {
  const container = await render(React.createElement(StatusFilterChips, {
    items: ROWS, value: 'all', onChange: () => {}, statusStyles: STATUS_STYLES
  }));

  assert.equal(countOn(chipNamed(container, 'All')), 6);
  assert.equal(countOn(chipNamed(container, 'Pending')), 2);
  assert.equal(countOn(chipNamed(container, 'In Progress')), 1);
  assert.equal(countOn(chipNamed(container, 'Completed')), 2);
  assert.equal(countOn(chipNamed(container, 'Overdue')), 1);
});

/* ---------------- clicking does something ---------------- */

// This is the regression. The four original chips were inert: they rendered with
// these exact counts, in this exact position, and pressing them changed nothing.
test('clicking a chip reports that status to the parent', async () => {
  const seen = [];
  const container = await render(React.createElement(StatusFilterChips, {
    items: ROWS, value: 'all', onChange: (value) => seen.push(value), statusStyles: STATUS_STYLES
  }));

  await click(chipNamed(container, 'Completed'));
  assert.deepEqual(seen, ['Completed'], 'clicking Completed did not report a selection');

  await click(chipNamed(container, 'Overdue'));
  assert.deepEqual(seen, ['Completed', 'Overdue']);

  // ...and All is the way back out, not just a label.
  await click(chipNamed(container, 'All'));
  assert.deepEqual(seen, ['Completed', 'Overdue', 'all']);
});

test('the selected chip is the only one that reports itself as pressed', async () => {
  // aria-pressed is the accessible half of the selected state; the ring is the
  // visual half. Both are asserted here on the real DOM rather than in source.
  const container = await render(React.createElement(StatusFilterChips, {
    items: ROWS, value: 'Completed', onChange: () => {}, statusStyles: STATUS_STYLES
  }));

  for (const label of ['All', 'Pending', 'In Progress', 'Completed', 'Overdue']) {
    const chip = chipNamed(container, label);
    const pressed = chip.getAttribute('aria-pressed');
    assert.ok(pressed === 'true' || pressed === 'false', `${label} has no aria-pressed`);
    assert.equal(pressed, String(label === 'Completed'), `${label} reports the wrong pressed state`);
  }

  // The selected chip is also marked by more than colour, for anyone who cannot
  // distinguish the ring from the fill.
  const selected = chipNamed(container, 'Completed');
  assert.match(selected.className, /ring-2/, 'the pressed chip has no non-colour cue');
  assert.match(selected.className, /font-bold/);
});

test('the pressed chip is exactly the one the table is filtered by', async () => {
  // Rendered the way the pages do: a controlled value fed back in, so a mismatch
  // between what is pressed and what is shown cannot hide.
  const container = await render(React.createElement(StatusFilterChips, {
    items: ROWS, value: 'Pending', onChange: () => {}, statusStyles: STATUS_STYLES
  }));

  const pressed = buttons(container).filter((b) => b.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'exactly one chip must be pressed at a time');
  assert.equal(pressed[0].textContent.replace(/\d+$/, '').trim(), 'Pending');
});

/* ---------------- end to end, the way the pages use it ---------------- */

// Milestones.js and Obligations.js both hold `statusFilter` in state, pass the
// full list to the chips, and render filterByStatus(items, statusFilter). Wired
// up here so the click, the pressed state and the row count are checked as one
// loop, which is the only way the three can be proven to agree.
const Harness = ({ items, statusStyles }) => {
  const [filter, setFilter] = useState('all');
  const visible = filterByStatus(items, filter);
  return React.createElement(
    'div',
    null,
    React.createElement(StatusFilterChips, { items, value: filter, onChange: setFilter, statusStyles }),
    React.createElement('span', { id: 'shown' }, `Showing ${visible.length} of ${items.length}`),
    React.createElement('ul', { id: 'rows' }, visible.map((row) =>
      React.createElement('li', { key: row._id }, row._id)
    ))
  );
};

test('clicking a chip narrows the rows, and the counts do not collapse with them', async () => {
  // The one-way door: derive the counts from the visible rows and selecting a
  // status zeroes every other chip, so the controls needed to switch back vanish
  // at the moment they are needed. Selecting Overdue (1 row of 6) is the case
  // where that is most obvious.
  const container = await render(React.createElement(Harness, { items: ROWS, statusStyles: STATUS_STYLES }));
  const shown = () => container.querySelector('#shown').textContent;
  const rows = () => [...container.querySelectorAll('#rows li')].map((li) => li.textContent);

  assert.equal(shown(), 'Showing 6 of 6');
  assert.deepEqual(rows(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

  await click(chipNamed(container, 'Overdue'));
  assert.equal(shown(), 'Showing 1 of 6', 'the row count did not follow the selection');
  assert.deepEqual(rows(), ['m5']);
  assert.equal(chipNamed(container, 'Overdue').getAttribute('aria-pressed'), 'true');

  // The other counts are unchanged, and still clickable.
  assert.equal(countOn(chipNamed(container, 'Completed')), 2, 'the Completed count collapsed');
  assert.equal(countOn(chipNamed(container, 'All')), 6, 'the All count collapsed');

  await click(chipNamed(container, 'Completed'));
  assert.deepEqual(rows(), ['m4', 'm6']);
  assert.equal(countOn(chipNamed(container, 'Overdue')), 1, 'the Overdue count collapsed');

  await click(chipNamed(container, 'All'));
  assert.deepEqual(rows(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], 'All did not restore every row');
  assert.equal(chipNamed(container, 'All').getAttribute('aria-pressed'), 'true');
  assert.equal(chipNamed(container, 'Completed').getAttribute('aria-pressed'), 'false');
});

test('a row whose status the client does not know is still filterable', async () => {
  // Milestones and Obligations render an unrecognised status with the
  // rz-unknown pill. A chip list built only from statusStyles would leave such a
  // row visible under All and under nothing else, so it could never be isolated.
  const items = [
    { _id: 'x1', status: 'Pending' },
    { _id: 'x2', status: 'Deferred' }
  ];
  const container = await render(React.createElement(Harness, { items, statusStyles: STATUS_STYLES }));

  const deferred = chipNamed(container, 'Deferred');
  assert.ok(deferred, 'a status present in the data got no chip');

  await click(deferred);
  assert.deepEqual([...container.querySelectorAll('#rows li')].map((li) => li.textContent), ['x2']);
});

test('rows with a blank or missing status are reachable, and agree with their chip', async () => {
  // The invariant that actually broke once: the chips normalised a whitespace-only
  // status to Unknown while the page only special-cased a falsy one, producing a
  // chip reading 1 above a table insisting the status was empty.
  const items = [
    { _id: 'b1', status: 'Pending' },
    { _id: 'b2', status: '   ' },
    { _id: 'b3', status: '' },
    { _id: 'b4' }
  ];
  const container = await render(React.createElement(Harness, { items, statusStyles: STATUS_STYLES }));

  const unknown = chipNamed(container, 'Unknown');
  assert.ok(unknown, 'blank and absent statuses have no chip to select');
  assert.equal(countOn(unknown), 3, 'the Unknown count does not match the rows it will show');

  await click(unknown);
  assert.deepEqual(
    [...container.querySelectorAll('#rows li')].map((li) => li.textContent),
    ['b2', 'b3', 'b4'],
    'selecting Unknown did not show every blank or absent status'
  );
});

test('an empty list renders no chips rather than throwing', async () => {
  // Both pages guard the filter row behind `total > 0`, but the component must
  // not depend on that: it still has to survive an empty or missing list.
  for (const items of [[], undefined, null]) {
    const container = await render(React.createElement(StatusFilterChips, {
      items, value: 'all', onChange: () => {}, statusStyles: STATUS_STYLES
    }));
    const all = chipNamed(container, 'All');
    assert.ok(all, 'the All chip is missing');
    assert.equal(countOn(all), 0);
  }
});

test('filterByStatus does not mutate the list it was given', async () => {
  // The pages pass their state array straight in, and both keep the full list
  // for the progress figures. A sort or splice in the shared helper would corrupt
  // both the counts and the summary.
  const items = [{ _id: 'p1', status: 'Pending' }, { _id: 'p2', status: 'Completed' }];
  const snapshot = JSON.stringify(items);
  const filtered = filterByStatus(items, 'Pending');

  assert.deepEqual(filtered.map((r) => r._id), ['p1']);
  assert.equal(JSON.stringify(items), snapshot, 'filterByStatus mutated its input');
  assert.equal(items.length, 2, 'the input list was truncated');
});
