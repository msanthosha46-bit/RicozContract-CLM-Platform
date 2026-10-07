'use strict';

// Issue 37 - Milestones workflow regressions.
//
// One genuine defect found by the audit:
//
//  1. A failed GET /milestones was reported twice at once: the error banner said
//     the load failed *and* the table area said "No milestones yet" (or, for an
//     Employee, "No milestones assigned to you"), because both a failed read and
//     a genuinely empty list leave `milestones` empty and the render only looked
//     at its length. This is the exact defect Issue 36 fixed on Obligations and
//     left unfixed here - the same helper, the same branch, the same lie. It
//     invites the user to create a milestone that may already exist, and it tells
//     an Employee their work vanished when it is still on the server.
//
// The rest of this file pins the milestone workflow so a refactor of the shared
// transition helper or of the Issue 24 stale-option guards cannot quietly alter
// what the page offers.
//
// Same zero-install jsdom + Babel harness as obligationCreateDom.test.js, with
// the axios instance and the auth context stubbed.

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
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage',
  'FormData', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement'
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
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }]
    ]
  });
  return module._compile(code, filename);
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const PAGE = path.join(SRC, 'pages', 'Milestones.js');

// c9/u9 are deliberately absent from the directory endpoints, which is the whole
// point: they stand in for an archived contract and a deactivated user.
const CONTRACTS = [
  { _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' },
  { _id: 'c2', contractNumber: 'CT-002', title: 'Lease Agreement' }
];

const PEOPLE = [
  { _id: 'u1', name: 'Ada Admin' },
  { _id: 'u3', name: 'Eli Employee' }
];

const ARCHIVED_CONTRACT = { _id: 'c9', contractNumber: 'CT-009', title: 'Archived deal', isArchived: true };
const DEACTIVATED_USER = { _id: 'u9', name: 'Dana Deactivated' };

const milestone = (over = {}) => ({
  _id: 'm1',
  title: 'Kickoff complete',
  description: 'Signed SOW delivered',
  contract: CONTRACTS[0],
  assignedTo: PEOPLE[1],
  dueDate: '2026-11-30T00:00:00.000Z',
  status: 'Pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over
});

const calls = [];

let rows = [];
let listFailsWith = null;
let putFailsWith = null;

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (url === '/milestones') {
      if (listFailsWith) throw listFailsWith;
      return { data: rows };
    }
    if (url.startsWith('/contracts')) return { data: CONTRACTS };
    if (url === '/users/directory') return { data: PEOPLE };
    return { data: [] };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    return { data: body };
  },
  async put(url, body) {
    calls.push({ method: 'put', url, body });
    if (putFailsWith) throw putFailsWith;
    return { data: body };
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const renderAs = async (role, { initialRows = [], listError = null, putError = null } = {}) => {
  calls.length = 0;
  rows = initialRows;
  listFailsWith = listError;
  putFailsWith = putError;

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role } })
  });

  delete require.cache[require.resolve(PAGE)];
  const Milestones = require(PAGE).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Milestones, null));
  });
  await settled();
  return { container, root };
};

const body = () => dom.window.document.body;

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const buttonsMatching = (scope, pattern) =>
  Array.from(scope.querySelectorAll('button')).filter((b) => pattern.test(b.textContent));

const editButtonFor = (container, title) =>
  container.querySelector(`button[aria-label="Edit ${title}"]`);

const submit = (form) => act(async () => {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
});

const mounted = [];

test.beforeEach(() => {
  dom.window.document.body.innerHTML = '';
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ *
 * Defect 1: a failed load must not also claim the list is empty
 * ------------------------------------------------------------------ */

test('a failed first load reports the failure and never says there are none', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [],
    listError: { response: { data: { message: 'Unable to reach the milestones service' } } }
  });
  mounted.push(root);

  assert.match(body().textContent, /Unable to reach the milestones service/, 'the reason should be shown');
  assert.match(body().textContent, /Retry/, 'the user needs a way back');
  assert.doesNotMatch(
    body().textContent,
    /No milestones yet/,
    'a failed read must not be reported as an empty list'
  );
  assert.doesNotMatch(
    body().textContent,
    /Create a milestone to map out contract timelines/,
    'the empty state would invite creating a milestone that already exists'
  );
  assert.equal(container.querySelector('table'), null, 'no table should be painted over a failed read');
  assert.equal(
    container.querySelector('[role="status"]'),
    null,
    'the loader is finished; the failure is not a loading state'
  );
});

test('a failed load with no server message still does not become an empty state', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [],
    listError: new Error('Network Error')
  });
  mounted.push(root);

  assert.match(body().textContent, /Unable to load milestones/);
  assert.doesNotMatch(body().textContent, /No milestones yet/);
  assert.equal(container.querySelector('table'), null);
});

test('a genuinely empty successful read still shows the empty state', async () => {
  const { container, root } = await renderAs('Manager', { initialRows: [] });
  mounted.push(root);

  assert.match(
    body().textContent,
    /No milestones yet/,
    'the empty state is correct once the list really did load empty'
  );
  assert.ok(buttonsMatching(container, /New milestone/i).length >= 1, 'and it keeps its call to action');
  assert.equal(container.querySelector('table'), null);
});

test('an Employee is not told there are no milestones when the load fails', async () => {
  const { container, root } = await renderAs('Employee', {
    initialRows: [],
    listError: { response: { data: { message: 'boom' } } }
  });
  mounted.push(root);

  assert.doesNotMatch(body().textContent, /No milestones assigned to you/, 'that is also an empty claim');
  assert.doesNotMatch(body().textContent, /No milestones yet/);
  assert.equal(
    buttonsMatching(container, /New milestone/i).length,
    0,
    'an Employee never gets a create call to action'
  );
});

test('a failed refresh after a successful load keeps the rows already on screen', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [milestone({ title: 'Kept row' })]
  });
  mounted.push(root);

  assert.match(body().textContent, /Kept row/);

  // A quick action refetches the list, so failing the next read exercises the
  // refresh path rather than only the first-load path.
  listFailsWith = { response: { data: { message: 'Temporary failure' } } };
  await click(buttonsMatching(container, /^Start$/i)[0]);
  await settled();

  assert.match(body().textContent, /Temporary failure/, 'the failure is still reported');
  assert.ok(buttonsMatching(container, /Retry/i).length >= 1, 'and a retry is offered');
  assert.match(
    body().textContent,
    /Kept row/,
    'rows already read stay visible; silently blanking them would lose the user\'s context'
  );
  assert.doesNotMatch(
    body().textContent,
    /No milestones yet/,
    'and the row set that is still on screen is never called empty'
  );
});

test('a failed mutation is never reported as success', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [milestone({ title: 'Will fail' })],
    putError: { response: { data: { message: 'Milestone status change rejected' } } }
  });
  mounted.push(root);

  await click(buttonsMatching(container, /^Start$/i)[0]);
  await settled();

  assert.match(body().textContent, /Milestone status change rejected/);
  assert.doesNotMatch(body().textContent, /Milestone updated/, 'no false success toast');
  assert.ok(
    buttonsMatching(container, /Retry/i).length >= 1,
    'the control is not permanently disabled; the user can try again'
  );
});

/* ------------------------------------------------------------------ *
 * The workflow the page offers
 * ------------------------------------------------------------------ */

test('quick actions mirror the transition matrix, not a guess', async () => {
  const initialRows = [
    milestone({ _id: 'm1', title: 'Pending one', status: 'Pending' }),
    milestone({ _id: 'm2', title: 'Running one', status: 'In Progress' }),
    milestone({ _id: 'm3', title: 'Late one', status: 'Overdue' }),
    milestone({ _id: 'm4', title: 'Done one', status: 'Completed' })
  ];
  const { container, root } = await renderAs('Manager', { initialRows });
  mounted.push(root);

  const rowActions = (title) => {
    const row = Array.from(container.querySelectorAll('tbody tr'))
      .find((tr) => tr.textContent.includes(title));
    assert.ok(row, `row for ${title} should render`);
    return Array.from(row.querySelectorAll('button')).map((b) => b.textContent.trim());
  };

  assert.deepEqual(rowActions('Pending one'), ['View', 'Edit', 'Start', 'Complete']);
  assert.deepEqual(rowActions('Running one'), ['View', 'Edit', 'Complete'], 'In Progress has nothing to start');
  assert.deepEqual(rowActions('Late one'), ['View', 'Edit', 'Start', 'Complete']);
  assert.deepEqual(rowActions('Done one'), ['View', 'Edit', 'Reopen'], 'Completed offers reopen, never complete');
});

test('a start quick action sends only the status and leaves details alone', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [milestone({ title: 'Advance me' })]
  });
  mounted.push(root);

  await click(buttonsMatching(container, /^Start$/i)[0]);
  await settled();

  const put = calls.find((c) => c.method === 'put');
  assert.ok(put, 'a status change should be attempted');
  assert.equal(put.url, '/milestones/m1');
  assert.deepEqual(put.body, { status: 'In Progress' }, 'the row payload must not smuggle other fields');
});

test('rows, progress and counts render from a successful load', async () => {
  const initialRows = [
    milestone({ _id: 'm1', title: 'Alpha', status: 'Pending' }),
    milestone({ _id: 'm2', title: 'Bravo', status: 'Completed' }),
    milestone({ _id: 'm3', title: 'Charlie', status: 'Overdue' })
  ];
  const { container, root } = await renderAs('Manager', { initialRows });
  mounted.push(root);

  assert.match(body().textContent, /Alpha/);
  assert.match(body().textContent, /Bravo/);
  assert.match(body().textContent, /Charlie/);
  assert.equal(container.querySelector('tbody').querySelectorAll('tr').length, 3);
  assert.match(body().textContent, /1 of 3 completed · 33%/, 'the progress panel reads the whole set');

  const overdueChip = buttonsMatching(container, /Overdue/i)[0];
  await click(overdueChip);
  await settled();

  const shown = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent);
  assert.ok(shown.some((t) => /Charlie/.test(t)));
  assert.ok(!shown.some((t) => /Bravo/.test(t)), 'the filter should hide non-matching rows');
  assert.match(body().textContent, /Showing 1 of 3/, 'the narrowed count is announced');

  const allChip = buttonsMatching(container, /^All/)[0];
  await click(allChip);
  await settled();
  assert.equal(container.querySelector('tbody').querySelectorAll('tr').length, 3, 'All restores every row');
  assert.match(body().textContent, /1 of 3 completed · 33%/, 'and the summary does not narrow with the table');
});

/* ------------------------------------------------------------------ *
 * Issue 24's stale-option guards are still in place
 * ------------------------------------------------------------------ */

test('a milestone on an archived contract keeps its own contract in the edit form', async () => {
  const target = milestone({ title: 'Closed out deal', contract: ARCHIVED_CONTRACT, assignedTo: PEOPLE[0] });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Closed out deal'));
  await settled();

  const form = body().querySelector('#milestone-edit-form');
  assert.ok(form, 'the edit form should open');
  const [contractSelect, peopleSelect] = form.querySelectorAll('select');
  const labels = Array.from(contractSelect.options).map((o) => o.textContent);

  assert.ok(labels.some((l) => /CT-009/.test(l)), 'the milestone\'s own contract must be listed');
  assert.equal(
    contractSelect.value,
    'c9',
    'without the guard the browser resolves the value to the first contract'
  );

  assert.equal(peopleSelect.value, 'u1', 'the active assignee resolves normally');
});

test('a milestone with a deactivated assignee stays editable', async () => {
  const target = milestone({ title: 'Needs a new owner', assignedTo: DEACTIVATED_USER });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Needs a new owner'));
  await settled();

  const form = body().querySelector('#milestone-edit-form');
  assert.ok(form, 'the edit form should open');
  const peopleSelect = form.querySelectorAll('select')[1];
  const names = Array.from(peopleSelect.options).map((o) => o.textContent);

  assert.ok(
    names.some((n) => /Dana Deactivated/.test(n)),
    `the deactivated assignee must be selectable, saw ${JSON.stringify(names)}`
  );
  assert.equal(peopleSelect.value, 'u9');
  assert.equal(
    peopleSelect.checkValidity(),
    true,
    'a required select holding "" made the form unsubmittable for everyone'
  );
});

test('an archived-contract milestone cannot be moved to another contract', async () => {
  const target = milestone({ title: 'Closed out deal', contract: ARCHIVED_CONTRACT, assignedTo: PEOPLE[0] });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Closed out deal'));
  await settled();

  const form = body().querySelector('#milestone-edit-form');
  const [contractSelect] = form.querySelectorAll('select');
  assert.equal(contractSelect.disabled, true, 'a milestone cannot be moved between contracts from this form');
  assert.equal(contractSelect.value, 'c9');

  const titleInput = form.querySelector('input[placeholder="Title"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(titleInput, 'Renamed');
  titleInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await settled();

  await submit(form);
  await settled();

  const put = calls.find((c) => c.method === 'put');
  assert.ok(put, 'renaming should still be attempted');
  assert.equal(put.body.contract, 'c9', 'the payload carries the milestone\'s real contract');
  assert.equal(put.body.title, 'Renamed');
});

/* ------------------------------------------------------------------ *
 * Role surface
 * ------------------------------------------------------------------ */

test('an Employee sees their milestones but no management controls', async () => {
  const { container, root } = await renderAs('Employee', {
    initialRows: [milestone({ title: 'Assigned to me', assignedTo: { _id: 'u1', name: 'Probe' } })]
  });
  mounted.push(root);

  assert.match(body().textContent, /Assigned to me/);
  assert.equal(
    container.querySelectorAll('button[aria-label^="Edit "]').length,
    0,
    'an Employee has no edit control'
  );
  assert.equal(buttonsMatching(container, /New milestone/i).length, 0, 'and no create control');
  assert.ok(
    buttonsMatching(container, /^Complete$/i).length >= 1,
    'but they may still advance their own work'
  );
});
