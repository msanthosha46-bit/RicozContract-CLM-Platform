'use strict';

// Phase-8 regression tests for the work-item status filters on Milestones and
// Obligations.
//
// The bug: Milestones.js rendered four status chips that were plain <span>s --
// shaped and coloured like a filter row, sitting directly under a progress bar,
// with no onClick and no button role. They counted and did nothing.
// Obligations.js had no chips at all, so its table had no way to narrow by
// status even though the sibling page pretended to offer one.
//
// The fix filters client-side. That is sound here because GET /milestones and
// GET /obligations each already return the caller's complete, unpaginated set
// (Employees scoped to their own on the server, nothing more), so no query
// parameter had to be invented and the authorization rules did not move.
//
// Source-reading, as every client suite here does: the client is ESM and the
// runner is CommonJS, so a page cannot be imported.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const milestones = read('pages', 'Milestones.js');
const obligations = read('pages', 'Obligations.js');
const chips = read('components', 'Layout', 'Common', 'StatusFilterChips.js');
const PAGES = { Milestones: milestones, Obligations: obligations };

/* ---------------- the chips are real controls ---------------- */

test('each chip is a toggle button, not a styled span', () => {
  // The old markup was <span className={`rounded-full ... ${statusStyles[label]}`}>.
  // Anything that is not a <button type="button"> with an onClick is a label.
  assert.match(chips, /<button/);
  assert.match(chips, /type="button"/);
  assert.match(chips, /onClick=\{\(\) => onChange\(option\.value\)\}/);
  assert.doesNotMatch(chips, /<span[^>]*onClick/, 'a chip is still a span');
});

test('the selected state is exposed to assistive tech, not only drawn', () => {
  // aria-pressed is the canonical signal for a toggle button. A ring is drawn as
  // well, but a ring alone is invisible to a screen reader and to anyone who
  // cannot distinguish the ring colour.
  assert.match(chips, /aria-pressed=\{selected\}/);
  assert.match(chips, /role="group"/);
  assert.match(chips, /aria-label=\{label\}/);
  // Not a tablist: these do not change the panel, they filter it.
  assert.doesNotMatch(chips, /role="tablist"|role="tab"/);
});

test('the selected chip is marked by more than colour', () => {
  // The selected state is the true branch of the className ternary, so slice
  // from that branch rather than from the first "selected" in the file (which
  // is the local const, and sits before aria-pressed).
  const branch = chips.slice(chips.indexOf("? 'font-bold"), chips.indexOf("'focus-visible:opacity-100'"));
  assert.match(branch, /ring-2/, 'the selected chip needs a non-colour cue');
  assert.match(branch, /font-bold/);
  // A visible focus ring, since these are now the primary control on the page.
  assert.match(chips, /focus-visible:outline/);
  // The ring has to read against both themes: a light ring vanishes on the dark
  // card, and the offset has to match the surface it sits on (--rz-surface,
  // #141c2e under .dark) or the ring is swallowed by the fill.
  assert.match(chips, /dark:ring-white/);
  assert.match(chips, /dark:ring-offset-\[#141c2e\]/);
});

/* ---------------- All, and the counts ---------------- */

test('All is offered, and it is the default', () => {
  assert.match(chips, /const ALL = 'all'/);
  // `rows` is the local, non-null list the component counts from (it is
  // `Array.isArray(items) ? items : []`, so a failed fetch cannot crash the row).
  assert.match(chips, /value: ALL, label: 'All', count: rows\.length/);
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(src, /useState\('all'\)/, `${name} does not start on All`);
  }
});

test('the chip counts come from the whole list, never from the filtered rows', () => {
  // The classic one-way door: derive the counts from what is currently shown
  // and selecting a status collapses every other count to zero, so the chips
  // needed to switch back disappear along with the rows.
  assert.match(chips, /rows\.filter\(\(item\) => keyOf\(item\.status\) === status\)\.length/);
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(src, /items=\{milestones\}|items=\{obligations\}/, `${name} does not pass its full list`);
    assert.doesNotMatch(src, /items=\{visible\}/, `${name} passes the filtered rows, so the counts would collapse`);
  }
});

test('a status the client does not know is still reachable', () => {
  // Both pages render an unrecognised status with the rz-unknown fallback pill.
  // If the chip list came only from statusStyles, such a row would be visible
  // under All and under nothing else -- unfilterable in both directions.
  assert.match(chips, /new Set\(\[\.\.\.Object\.keys\(known\), \.\.\.rows\.map\(\(item\) => keyOf\(item\.status\)\)\]\)/);
  assert.match(chips, /const keyOf = \(status\) => \(typeof status === 'string' && status\.trim\(\) \? status : 'Unknown'\)/);
  assert.match(chips, /style: known\[status\] \|\| 'rz-pill rz-unknown'/);
});

test('the All chip survives the dark-mode colour rewrite', () => {
  // index.css maps `.dark .ricoz-shell main .text-slate-700` to a light body
  // colour but leaves .bg-slate-200 alone, so that pair renders light text on a
  // pale chip. Literal hexes the override block does not match stay put.
  const all = chips.match(/value: ALL[\s\S]*?style: '([^']+)'/);
  assert.ok(all, 'the All chip is missing');
  assert.doesNotMatch(all[1], /bg-slate|text-slate/);
});

/* ---------------- the tables actually filter ---------------- */

test('both pages narrow the table by the selected status', () => {
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(
      src,
      /const visible = filterByStatus\((milestones|obligations), statusFilter\)/,
      `${name} does not derive its rows from statusFilter`
    );
    // And the table renders the filtered rows, not the full list.
    assert.match(src, /\{visible\.map\(/, `${name} still maps the unfiltered list`);
    // It must be the shared helper, not a second copy of the predicate.
    assert.doesNotMatch(src, /\.filter\(\s*\w+ => \w+\.status === statusFilter/, `${name} re-implements the predicate`);
  }
});

test('an empty filter is not reported as an empty repository', () => {
  // Milestones has three distinct empty states and conflating them is how the
  // dashboard came to claim "0 contracts" on a failed request.
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(src, /visible\.length === 0/, `${name} has no filtered-empty branch`);
    assert.match(src, /No \w+ in this status/, `${name} does not distinguish the two empties`);
    assert.match(src, /of the \$\{total\} \w+ here are \$\{statusFilter\}/, `${name} does not say what is hidden`);
    // ...and offers the way back out.
    assert.match(src, /onClick=\{\(\) => setStatusFilter\('all'\)\}/, `${name} gives no way back to All`);
  }
});

test('the summary progress figures are not filtered', () => {
  // The progress bar answers "how is this page doing", not "how is this filter
  // doing"; narrowing it would make the page look broken after one click.
  const start = milestones.indexOf('Milestone progress');
  const panel = milestones.slice(start, milestones.indexOf('Filter', start));
  assert.match(panel, /\{completed\} of \{total\} completed/);
  assert.doesNotMatch(panel, /visible/);
});

test('the filtered count is announced politely', () => {
  // The row count changes with no navigation and no focus move, so a screen
  // reader needs to be told.
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(src, /aria-live="polite"/, `${name} does not announce the filtered count`);
    assert.match(src, /Showing \{visible\.length\} of \{total\}/, `${name} does not show the filtered count`);
  }
});

/* ---------------- the count and the rows cannot disagree ---------------- */

// The component is JSX, so the runner cannot import it, but the two helpers the
// chip counts and the table filter both go through are plain JS. Compile and run
// them for real rather than pattern-matching the source: the bug this pins is a
// behavioural one, and a regex over the file cannot see it.

const loadHelpers = () => {
  const start = chips.indexOf('const ALL =');
  assert.notEqual(start, -1, 'the ALL constant is missing from StatusFilterChips');
  const end = chips.indexOf('const StatusFilterChips');
  assert.notEqual(end, -1, 'the component declaration is missing');
  // Drop the `export` keywords -- this is evaluated as a script, not a module.
  const body = chips.slice(start, end).replace(/export const/g, 'const');
  return new Function(`${body}\nreturn { ALL, keyOf, filterByStatus };`)();
};

test('a chip count is always the number of rows its selection shows', () => {
  // This is the invariant the whole control rests on: the count a chip advertises
  // is the count of rows the table then renders. It broke when the chips
  // normalised a blank status to Unknown but the pages only special-cased a
  // falsy one, so a whitespace-only status produced a chip reading 1 above a
  // table insisting the status was empty.
  const { ALL, filterByStatus } = loadHelpers();

  const rows = [
    { _id: '1', status: 'Pending' },
    { _id: '2', status: 'Pending' },
    { _id: '3', status: 'Completed' },
    { _id: '4', status: '   ' },   // blank but truthy
    { _id: '5', status: '' },      // empty
    { _id: '6' },                  // absent entirely
    { _id: '7', status: 'In Progress' }
  ];

  for (const key of [ALL, 'Pending', 'Completed', 'In Progress', 'Unknown']) {
    const chipCount = key === ALL
      ? rows.length
      : rows.filter((row) => (typeof row.status === 'string' && row.status.trim() ? row.status : 'Unknown') === key).length;
    const shown = filterByStatus(rows, key).length;
    assert.equal(shown, chipCount, `selecting ${key} shows ${shown} rows but its chip counts ${chipCount}`);
  }

  // Spelled out, because this is the case that actually regressed.
  assert.equal(filterByStatus(rows, 'Unknown').length, 3, 'every blank/absent status must be reachable under Unknown');
  assert.equal(filterByStatus(rows, ALL).length, rows.length, 'All must show every row, unknown statuses included');
  assert.deepEqual(filterByStatus(rows, 'Pending').map((r) => r._id), ['1', '2']);
  assert.deepEqual(filterByStatus([], ALL), [], 'an empty list must not throw');
  assert.deepEqual(filterByStatus(undefined, 'Pending'), [], 'a missing list must not throw');
});

/* ---------------- nothing else moved ---------------- */

test('no new request, role check or endpoint was introduced on these pages', () => {
  for (const [name, src] of Object.entries(PAGES)) {
    assert.match(src, /API\.get\('\/milestones'\)|API\.get\('\/obligations'\)/, `${name} changed its list request`);
    // The list call must stay unpaginated and unfiltered on the server, which
    // is what makes client-side filtering complete.
    assert.doesNotMatch(src, /status=\$\{|params:\s*\{[^}]*status/, `${name} pushed filtering to the server`);
    // canManage is unchanged: the filter is available to every role that can
    // already see the rows.
    assert.match(src, /const canManage = \['Admin', 'Manager'\]\.includes\(user\?\.role\)/, `${name} changed its role check`);
    assert.doesNotMatch(src, /canManage &&\s*<StatusFilterChips/, `${name} gated the filter behind a role`);
  }
});

test('the quick-action and edit affordances still render for the filtered rows', () => {
  // Filtering must not remove the ability to act on what is left.
  for (const [name, src] of Object.entries(PAGES)) {
    const body = src.slice(src.indexOf('{visible.map('));
    assert.match(body, /quickActions\(/, `${name} lost its quick actions`);
    assert.match(body, /setViewTarget\(/, `${name} lost View`);
    assert.match(body, /openEdit\(/, `${name} lost Edit`);
  }
});
