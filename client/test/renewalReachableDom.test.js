'use strict';

// Behavioural Phase-8 regression tests for the renewal eligibility mismatch.
//
// The bug: `canRenewContract` permits Active, Approved, Expired and Renewed, and
// POST /renewals/renew/:contractId accepts all four. RenewalManagement.js is the
// only entry point to that route, and its list came solely from
// GET /renewals/expiring -- a forward-looking window over Active/Approved. An
// Expired contract has by definition an end date in the past, so it can never
// match a forward window, and because expireEligibleContracts() moves
// Active -> Expired on an hourly timer, contracts were being stranded in a state
// the business rules call renewable that no user could reach. Renewed was
// unreachable the mirror way: a future end date, but a status the expiring list
// never selects.
//
// The fix adds GET /renewals/renewable and renders the difference against the
// reminder list.
//
// renewalEligibility.test.js pins this by reading the source, and
// server/test/phase8.test.js drives the endpoint itself over real HTTP. Neither
// proves the page renders a reachable, actionable row: a request that is made
// and its response thrown away passes both. So this file renders the real page
// against a stubbed transport and drives it.
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
const { act } = React;
const { createRoot } = require('react-dom/client');
const API = require('../src/services/api').default;
const RenewalManagement = require('../src/pages/RenewalManagement').default;

// server/utils/contractTransitions.js is the write-side authority. Read the real
// file so this test cannot drift from the states the API actually accepts.
const SERVER_ROOT = path.join(__dirname, '..', '..', 'server', 'utils');
const serverTransitions = fs.readFileSync(path.join(SERVER_ROOT, 'contractTransitions.js'), 'utf8');
const RENEWABLE_FROM = serverTransitions
  .match(/const RENEWABLE_FROM = new Set\(\[([^\]]+)\]\)/)[1]
  .match(/'([^']+)'/g)
  .map((s) => s.replace(/'/g, ''));

const DAY = 24 * 60 * 60 * 1000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const contract = (number, status, daysRemaining, extra = {}) => ({
  _id: number,
  contractNumber: number,
  title: `Contract ${number}`,
  partyName: 'Acme Ltd',
  status,
  endDate: day(daysRemaining),
  daysRemaining,
  // The server's own tier, so the page renders the reminder it was given.
  reminder: daysRemaining <= 30 ? 30 : daysRemaining <= 60 ? 60 : 90,
  isArchived: false,
  ...extra
});

// The server's contract for /renewals/renewable: the whole eligible set, not a
// window. ReminderFor() gives a lapsed contract the 30-day tier (daysRemaining
// <= 30), which is why it is not simply "today + 30".
const eligibleResponse = [
  contract('EXP-001', 'Expired', -400),
  contract('EXP-002', 'Expired', -1),
  contract('RNW-001', 'Renewed', 400),
  contract('ACT-001', 'Active', 200),
  contract('APR-001', 'Approved', 12)
];

// /expiring only ever returns Active/Approved inside the forward window, so the
// two lapsed Expired contracts and the far-future Renewed one are absent.
const expiringResponse = [contract('ACT-001', 'Active', 200), contract('APR-001', 'Approved', 12)];

/* ---------------- stubbed transport ---------------- */

const requested = [];
let routes = {};

const originalAdapter = API.defaults.adapter;

const installAdapter = () => {
  API.defaults.adapter = (config) => {
    const path_ = String(config.url || '');
    requested.push(path_);
    const key = Object.keys(routes).find((k) => path_.endsWith(k));
    const data = key ? routes[key] : [];
    return Promise.resolve({
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    });
  };
};

const mounted = [];

const renderPage = async () => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(React.createElement(RenewalManagement));
  });
  // The page fetches in an effect and swaps the skeleton for the tables once it
  // resolves; let that settle before reading the DOM.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

// The page renders three tables. Slice them by heading so assertions say which
// surface a row appeared on -- the whole point of the fix is that lapsed
// contracts appear on the *second* one, not that they appear somewhere.
//
// Resolved by document order from the heading, not by index into the table list:
// the reminder table is replaced by an empty state when a filter matches nothing,
// which renumbers everything after it. That is correct behaviour, and an
// index-based lookup would read it as "the awaiting-renewal table vanished".
const tableAfter = (container, heading) => {
  const h2 = [...container.querySelectorAll('h2')].find((h) => h.textContent.includes(heading));
  assert.ok(h2, `the "${heading}" section is missing`);
  const inOrder = [...container.querySelectorAll('h2, table')];
  return inOrder.slice(inOrder.indexOf(h2) + 1).find((el) => el.tagName === 'TABLE') || null;
};

const rowFor = (table, contractNumber) =>
  [...table.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(contractNumber)) || null;

const renewButton = (row) => {
  const button = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('Renew'));
  assert.ok(button, `the row for this contract has no Renew action`);
  return button;
};

test.beforeEach(() => {
  requested.length = 0;
  routes = {
    '/renewals/expiring': expiringResponse,
    '/renewals/renewable': eligibleResponse,
    '/renewals/history': []
  };
  installAdapter();
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  API.defaults.adapter = originalAdapter;
  dom.window.document.body.innerHTML = '';
});

/* ---------------- the mismatch, reproduced ---------------- */

test('a contract the API will renew but the reminder window cannot reach is on the page', async () => {
  // The regression in one assertion: EXP-002 is Expired with an end date
  // yesterday. canRenewContract('Expired') is true, so it is renewable, and
  // POST /renewals/renew/EXP-002 succeeds. Before the fix nothing on this page
  // could ever render it.
  const container = await renderPage();

  const awaiting = tableAfter(container, 'Awaiting renewal');
  assert.ok(awaiting, 'the awaiting-renewal table is missing');

  const row = rowFor(awaiting, 'EXP-002');
  assert.ok(row, 'an Expired contract one day past its end date is not on the page, so it cannot be renewed');
  assert.match(row.textContent, /Expired/, 'the row does not say which state the contract is in');
  // Reachable, not merely listed.
  renewButton(row);
});

test('the far-future Renewed contract is reachable too', async () => {
  // The mirror case: RNW-001 has a future end date, so a naive fix that widened
  // the window rather than the status set would still miss it.
  const container = await renderPage();
  const row = rowFor(tableAfter(container, 'Awaiting renewal'), 'RNW-001');
  assert.ok(row, 'a Renewed contract is not reachable on the page');
  assert.match(row.textContent, /Renewed/);
  renewButton(row);
});

test('every state canRenewContract permits is reachable on this page', async () => {
  // Read the real server rule rather than restating it, so adding a state to
  // RENEWABLE_FROM without adding a way to reach it fails here.
  assert.deepEqual(RENEWABLE_FROM, ['Active', 'Approved', 'Expired', 'Renewed']);

  const container = await renderPage();
  const rendered = container.textContent;

  for (const status of RENEWABLE_FROM) {
    assert.ok(
      rendered.includes(status),
      `${status} is renewable per the server rules but no row on the page shows that state`
    );
  }

  // And each is not just mentioned: there is a row showing the state, and that
  // row has a Renew action. Matched on the badge's own text rather than with a
  // word-boundary regex over the row: the reminder tier renders as "90-day"
  // immediately before the badge, so the row's textContent reads "90-dayActive"
  // and \bActive\b does not match. StatusBadge is the element that carries the
  // state, so read it there.
  for (const status of RENEWABLE_FROM) {
    const table = ['Active', 'Approved'].includes(status)
      ? tableAfter(container, 'Expiring contracts')
      : tableAfter(container, 'Awaiting renewal');
    const row = [...table.querySelectorAll('tbody tr')]
      .find((tr) => [...tr.querySelectorAll('span')].some((s) => s.textContent.trim() === status));
    assert.ok(row, `no row shows a ${status} contract`);
    renewButton(row);
  }
});

/* ---------------- no duplication, no loss ---------------- */

test('the two tables partition the eligible set rather than repeating it', async () => {
  // /renewable is a superset of the reminder window, so rendering it as-is
  // alongside /expiring would show every Active/Approved contract twice. The page
  // deduplicates on _id; this checks that the user sees each contract once.
  const container = await renderPage();

  const expiring = tableAfter(container, 'Expiring contracts');
  const awaiting = tableAfter(container, 'Awaiting renewal');

  const numbers = (table) => [...table.querySelectorAll('tbody tr')]
    .map((tr) => (tr.textContent.match(/[A-Z]{3}-\d{3}/) || [])[0])
    .filter(Boolean);

  const inExpiring = numbers(expiring);
  const inAwaiting = numbers(awaiting);

  assert.ok(inExpiring.includes('ACT-001'), 'the reminder table lost the contract inside its window');
  const overlap = inAwaiting.filter((n) => inExpiring.includes(n));
  assert.deepEqual(overlap, [], `contracts rendered in both tables: ${overlap.join(', ')}`);
  assert.equal(new Set([...inExpiring, ...inAwaiting]).size, inExpiring.length + inAwaiting.length);
});

test('nothing eligible is dropped between the two tables', async () => {
  // The union must equal the eligible response exactly. A contract missing here
  // is one that can be renewed through the API and cannot be reached on screen.
  const container = await renderPage();
  const rendered = container.textContent;

  for (const item of eligibleResponse) {
    assert.ok(
      rendered.includes(item.contractNumber),
      `${item.contractNumber} (${item.status}) is offered by /renewals/renewable but is not on the page`
    );
  }
});

test('the page does not re-implement the eligibility rule, so the two cannot drift', async () => {
  // The server is the only place eligibility is decided: GET /renewals/renewable
  // filters on RENEWABLE_FROM, and POST /renewals/renew/:id rejects anything
  // else with a 400 (covered over real HTTP in server/test/phase8.test.js).
  //
  // So if the page filtered client-side as well, that copy would be a second
  // source of truth -- and it is precisely how the original mismatch was
  // introduced, with a list that was narrower than the rule. A state added to
  // RENEWABLE_FROM server-side would be silently hidden again by a stale client
  // filter. Rendering the server's list verbatim is the behaviour to protect.
  routes['/renewals/renewable'] = [
    ...eligibleResponse,
    contract('DRF-001', 'Draft', 5),
    contract('CLS-001', 'Closed', 5)
  ];

  const container = await renderPage();
  const rendered = container.textContent;

  assert.ok(
    rendered.includes('DRF-001') && rendered.includes('CLS-001'),
    'the page filtered the eligible list by status itself, creating a second eligibility rule'
  );

  // Every one of them still carries a Renew action, and the server is what turns
  // the ineligible ones down.
  for (const number of ['DRF-001', 'CLS-001']) {
    const table = rendered.indexOf(number) >= 0
      ? tableAfter(container, 'Awaiting renewal')
      : null;
    assert.ok(table, `the extra contract ${number} was not rendered at all`);
  }
  assert.ok(
    requested.includes('/renewals/renewable'),
    'eligibility must still come from the server, not from a local list'
  );
});

/* ---------------- the Renew action actually opens that contract ---------------- */

test('the Renew action on a lapsed row opens the dialog for that contract', async () => {
  // Reachability is not the same as being actionable. If the second table's
  // buttons were wired to the wrong contract, or to nothing, the state would be
  // visible and still not renewable.
  const container = await renderPage();

  await click(renewButton(rowFor(tableAfter(container, 'Awaiting renewal'), 'EXP-002')));

  const dialog = container.querySelector('[role="dialog"]') || container;
  assert.match(dialog.textContent, /EXP-002/, 'the dialog did not open for the clicked contract');

  // ...and the date floor protects the renewal from silently lapsing again: the
  // server's hourly job re-expires anything whose endDate is at or before
  // today's UTC midnight, so a lapsed contract must be floored at tomorrow.
  const input = dialog.querySelector('input[type="date"]');
  assert.ok(input, 'the renewal dialog has no date input');
  const floor = Date.parse(`${input.getAttribute('min')}T00:00:00.000Z`);
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
  );
  assert.ok(floor > todayUtc, `a lapsed contract was offered a floor of ${input.getAttribute('min')}, which is not in the future`);
});

/* ---------------- the reminder filter cannot hide a reachable contract ---------------- */

test('the reminder window filter does not strand a lapsed contract', async () => {
  // The reminder table's own 30/60/90 filter narrows the first table only. If it
  // also drove the second, a lapsed contract would vanish for a reason that has
  // nothing to do with its own end date.
  const container = await renderPage();

  const filterButton = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'Within 30 days');
  assert.ok(filterButton, 'the reminder window filter is missing');

  await click(filterButton);

  const awaiting = tableAfter(container, 'Awaiting renewal');
  assert.ok(rowFor(awaiting, 'EXP-002'), 'filtering the reminder window hid a lapsed contract');
  assert.ok(rowFor(awaiting, 'RNW-001'), 'filtering the reminder window hid the Renewed contract');
});

/* ---------------- nothing else moved ---------------- */

test('the page asks for the eligible set and still asks for the reminder window', async () => {
  // /expiring drives the reminder table and the dashboard's expiringSoon KPI;
  // swapping it for the wider eligible set would inflate that count.
  const container = await renderPage();
  assert.ok(requested.includes('/renewals/expiring'), 'the reminder window is no longer requested');
  assert.ok(requested.includes('/renewals/renewable'), 'the eligible set is not requested');
  assert.ok(requested.includes('/renewals/history'), 'the renewal trail is no longer requested');
});
