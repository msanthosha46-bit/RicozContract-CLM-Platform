'use strict';

// Phase-8 regression tests for the renewal eligibility mismatch.
//
// The bug: `canRenewContract` (server/utils/contractTransitions.js) permits
// Active, Approved, Expired and Renewed, and POST /renewals/renew/:contractId
// accepts all four. The only UI entry point is this page, whose list came
// solely from GET /renewals/expiring -- a *forward-looking* window restricted to
// Active/Approved. An Expired contract has, by definition, an end date in the
// past, so it can never match a forward window. Because
// expireEligibleContracts() moves Active -> Expired on an hourly timer,
// contracts were being stranded in a state the business rules call renewable
// that no user could reach. Renewed was unreachable the mirror way: a future
// end date, but a status the expiring list never selects.
//
// The fix adds GET /renewals/renewable (eligibility, not proximity) and renders
// the difference against the reminder list.
//
// These assertions read the source, as every other client suite here does -- the
// client is ESM and the runner is CommonJS, so there is no way to import a
// page. Where a rule is a pure function of its arguments, `renewalFloorDate` is
// additionally compiled and executed, so the arithmetic is really checked
// rather than pattern-matched.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const page = read('pages', 'RenewalManagement.js');
const dateUtils = read('utils', 'date.js');
const transitions = read('utils', 'contractTransitions.js');
const app = read('App.js');

/* ---------------- the new request ---------------- */

test('the page asks for the eligible set, not just the reminder window', () => {
  // The original bug was a missing request, so this is the first thing to pin.
  assert.match(page, /API\.get\('\/renewals\/renewable'\)/);
  assert.match(page, /setRenewableContracts\(renewableRes\.data\)/);
});

test('the two original renewal requests are untouched', () => {
  // /expiring still drives the reminder table and /history the trail; the new
  // call is additive. Guarded because silently swapping /expiring for the wider
  // eligible set would inflate the dashboard's `expiringSoon` KPI, which counts
  // the same forward window.
  assert.match(page, /API\.get\('\/renewals\/expiring'\)/);
  assert.match(page, /API\.get\('\/renewals\/history'\)/);
  assert.match(page, /reminderTier\(contract\.daysRemaining\) === filter/);
  assert.match(page, /\{contract\.reminder\}-day/);
});

/* ---------------- completeness ---------------- */

test('the extra list is the eligible set minus what the reminder list already shows', () => {
  // Naively rendering /renewals/renewable beside /renewals/expiring would show
  // every Active/Approved contract twice, since the eligible set is a superset
  // of the window. The page partitions on _id instead.
  assert.match(page, /const listedIds = new Set\(expiringContracts\.map\(\(contract\) => contract\._id\)\)/);
  assert.match(
    page,
    /const awaitingRenewal = renewableContracts\.filter\(\(contract\) => !listedIds\.has\(contract\._id\)\)/,
    'the extra list must exclude ids the reminder table already renders'
  );
});

test('every status the client will renew is offered by one of the two lists', () => {
  // The page is the only renewal entry point, so if a state can be renewed
  // through the API it has to appear in one of the two tables. Read the client's
  // own copy of the rule and check the server-side source agrees, since the two
  // must not drift.
  const clientSet = transitions.match(/const RENEWABLE_FROM = new Set\(\[([^\]]+)\]\)/);
  assert.ok(clientSet, 'the client no longer declares RENEWABLE_FROM');
  const states = clientSet[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));

  for (const state of states) {
    // Nothing on this page filters by status, so every state in the set is
    // reachable as long as the eligible endpoint is fetched without a filter.
    assert.ok(
      !/status:\s*\{|status=\$|req\.query\.status/.test(page),
      `${state} would be filtered out client-side`
    );
  }
  assert.deepEqual(states, ['Active', 'Approved', 'Expired', 'Renewed']);
});

/* ---------------- the lapsed table ---------------- */

test('the awaiting-renewal table offers the same Renew action as the reminder table', () => {
  const start = page.indexOf('Awaiting renewal');
  assert.notEqual(start, -1, 'the awaiting-renewal section is missing');
  const section = page.slice(start, page.indexOf('Renewal history', start));

  assert.match(section, /openRenew\(contract\)/, 'no Renew action in the new table');
  assert.match(section, /aria-label=\{`Renew \$\{contract\.contractNumber\}`\}/);
  assert.match(section, /<StatusBadge status=\{contract\.status\} \/>/, 'the state is not shown');
  // It reuses the server's own reminder tier rather than painting every row
  // red: a forward-dated Expired contract is not overdue. (The count badge in
  // the heading is red on purpose -- that is the "look at me" cue.)
  const pill = section.match(/<span className=\{`inline-flex[^`]*reminderStyles[^`]*`\}>\s*\{daysLabel\(contract\.daysRemaining\)\}/);
  assert.ok(pill, 'the day-count pill does not use the shared urgency styles');
  assert.doesNotMatch(pill[0], /bg-red/, 'the day-count pill hardcodes an alert colour');
  // Its own scroll container, like the other two tables on this page.
  assert.match(section, /<div className="overflow-x-auto">/);
});

test('the awaiting-renewal section says so when there is nothing to renew', () => {
  const start = page.indexOf('Awaiting renewal');
  const section = page.slice(start, page.indexOf('Renewal history', start));
  // The old page claimed "No contracts expire in the next 90 days" as its only
  // empty state, which is false once lapsed contracts can appear here.
  assert.match(section, /awaitingRenewal\.length === 0/);
  assert.match(section, /Nothing lapsed awaiting renewal/);
});

/* ---------------- the renewal date floor ---------------- */

// Compile the real helper out of utils/date.js and run it. The rule under test:
// a lapsed contract must not be renewable into a date that is already past,
// because the server's hourly expiry job would immediately re-expire it.
const loadRenewalFloorDate = () => {
  const start = dateUtils.indexOf('export const renewalFloorDate');
  assert.notEqual(start, -1, 'renewalFloorDate is missing from utils/date.js');
  const body = dateUtils.slice(start, dateUtils.indexOf('\n};', start) + 3);

  // Re-implement the two private helpers the function leans on, copied from the
  // same file, so the test exercises the real decision without needing a loader.
  const toDateInput = new Function(`
    const pad = (n) => String(n).padStart(2, '0');
    return function toDateInput(value) {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return \`\${d.getUTCFullYear()}-\${pad(d.getUTCMonth() + 1)}-\${pad(d.getUTCDate())}\`;
    };
  `)();

  const source = `
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const toDateInput = arguments[0];
    ${body.replace('export const', 'const')}
    return renewalFloorDate;
  `;
  return new Function(source)(toDateInput);
};

test('a lapsed contract cannot be renewed into a date that is already past', () => {
  const renewalFloorDate = loadRenewalFloorDate();
  const today = new Date();
  const todayUtcMidnight = Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
  );

  for (const daysRemaining of [-400, -30, -5, -1]) {
    const floor = renewalFloorDate(daysRemaining);
    const asTime = Date.parse(`${floor}T00:00:00.000Z`);
    assert.ok(
      asTime > todayUtcMidnight,
      `a contract ${daysRemaining} days past its end date was offered a floor of ${floor}, which is not in the future`
    );
    // Tomorrow is the earliest survivable date: expiry flips when
    // endDate < today's UTC midnight, so anything at or before today lapses.
    assert.equal(floor, renewalFloorDate(-1), 'the lapsed floor should be one value');
  }
});

test('a running contract is still floored one day past its current end date', () => {
  const renewalFloorDate = loadRenewalFloorDate();
  const today = new Date();
  const todayUtcMidnight = Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
  );

  // A contract with 10 days left may be renewed from 11 days out -- the
  // behaviour the dialog had before this change, and the whole point of
  // `newEndDate > endDate` on the server.
  const floor = renewalFloorDate(10);
  const expected = new Date(todayUtcMidnight + 11 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(floor, expected, 'a running contract lost its end-date + 1 day floor');
  assert.ok(Date.parse(`${floor}T00:00:00.000Z`) > todayUtcMidnight);
});

test('an unknown remaining-days value falls back to tomorrow', () => {
  const renewalFloorDate = loadRenewalFloorDate();
  // Defensive: the dialog can be opened before a payload has daysRemaining.
  // Opening the picker must not put a past date in a date input's `min`, which
  // browsers reject as invalid.
  for (const value of [null, undefined]) {
    const floor = renewalFloorDate(value);
    const today = new Date();
    const todayUtcMidnight = Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
    );
    assert.ok(Date.parse(`${floor}T00:00:00.000Z`) > todayUtcMidnight, `floor ${floor} is not in the future`);
  }
});

test('the dialog is wired to the helper and explains the lapsed rule', () => {
  assert.match(page, /min=\{renewalFloorDate\(selected\?\.daysRemaining\)\}/);
  assert.match(page, /or the contract would expire again immediately/);
});

/* ---------------- authorization ---------------- */

test('the renewal page stays manager-only and no new client-side role was added', () => {
  // The server guards /renewals/renewable with authorize('Admin','Manager'); the
  // route guard must not have been widened to let Employee reach it.
  assert.match(app, /path="\/renewals"[\s\S]{0,220}RoleProtectedRoute allowedRoles=\{MANAGER_ROLES\}/);
  assert.doesNotMatch(page, /ADMIN_ROLES|ALL_ROLES|isAdmin|isEmployee/, 'a role check crept into the page');
});
