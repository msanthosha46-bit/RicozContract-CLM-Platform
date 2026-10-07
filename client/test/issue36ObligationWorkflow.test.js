'use strict';

// Issue 36 - Obligations workflow regressions.
//
// Three defects found by the audit, all reachable from the page:
//
//  1. A failed GET /obligations was reported twice at once: the error banner said
//     the load failed *and* the table area said "No obligations yet", because
//     both a failed read and a genuinely empty list leave `obligations` empty and
//     the render only looked at its length. That invites the user to create an
//     obligation that already exists.
//
//  2. An obligation whose assignee has been deactivated could not be edited at
//     all. GET /users/directory filters out deactivated users, so the assignee's
//     id had no matching <option> and the `required` select fell back to its
//     empty placeholder (value ""), which native validation refuses to submit.
//
//  3. An obligation on an archived contract showed an *unrelated* contract in
//     the edit form. GET /contracts filters out archived contracts, so the
//     contract select had no matching option and the browser resolved the value
//     to the first option - the form claimed the obligation belonged to some
//     other contract than the one in the row it was opened from, leaving the user
//     editing against a contract that was not theirs.
//
//     This one is display-only by luck rather than by design: the select is
//     `disabled` and `saveEdit` sends component state, not the DOM value, so the
//     wrong option never reached the API (and the server rejects contract moves
//     regardless). The test below pins the payload invariant anyway, so a future
//     refactor cannot turn this into data corruption for free.
//
// 2 and 3 are the same missing guard (the options must be a superset of the
// record's own references) and the same fix, mirroring Milestones.js.
//
// This file mounts the real page for the role in front of you and drives it, so
// a regression is caught in the place it actually shows up rather than by a
// regex over the source. Same zero-install jsdom + Babel harness as
// obligationCreateDom.test.js, with the axios instance and the auth context
// stubbed.

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

const PAGE = path.join(SRC, 'pages', 'Obligations.js');

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

const STATUS_ALL = 'all';

const obligation = (over = {}) => ({
  _id: 'o1',
  title: 'Provide insurance certificate',
  description: 'Proof of cover',
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

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (url === '/obligations') {
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

let putFailsWith = null;

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const renderAs = async (role, { initialRows = [], listError = null } = {}) => {
  calls.length = 0;
  rows = initialRows;
  listFailsWith = listError;
  putFailsWith = null;

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role } })
  });

  delete require.cache[require.resolve(PAGE)];
  const Obligations = require(PAGE).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Obligations, null));
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

// React tracks the previous value on the node, so a plain `el.value = x`
// assignment is swallowed by the controlled-input check. Go through the
// prototype's setter, then fire the event the component actually listens for.
const setValue = (element, value) => {
  const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
    : element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(
    new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })
  );
};

const editForm = () => body().querySelector('#obligation-edit-form');

const editSelects = () => {
  const form = editForm();
  return [form.querySelectorAll('select')[0], form.querySelectorAll('select')[1]];
};

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
    listError: { response: { data: { message: 'Unable to reach the obligations service' } } }
  });
  mounted.push(root);

  assert.match(body().textContent, /Unable to reach the obligations service/, 'the reason should be shown');
  assert.match(body().textContent, /Retry/, 'the user needs a way back');
  assert.doesNotMatch(
    body().textContent,
    /No obligations yet/,
    'a failed read must not be reported as an empty list'
  );
  assert.equal(container.querySelector('table'), null, 'no table should be painted over a failed read');
});

test('a failed load with no server message still does not become an empty state', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [],
    listError: new Error('Network Error')
  });
  mounted.push(root);

  assert.match(body().textContent, /Unable to load obligations/);
  assert.doesNotMatch(body().textContent, /No obligations yet/);
  assert.equal(container.querySelector('table'), null);
});

test('a genuinely empty successful read still shows the empty state', async () => {
  const { container, root } = await renderAs('Manager', { initialRows: [] });
  mounted.push(root);

  assert.match(
    body().textContent,
    /No obligations yet/,
    'the empty state is correct once the list really did load empty'
  );
  assert.ok(buttonsMatching(container, /New obligation/i).length >= 1, 'and it keeps its call to action');
});

test('an Employee is not told there are no obligations when the load fails', async () => {
  const { container, root } = await renderAs('Employee', {
    initialRows: [],
    listError: { response: { data: { message: 'boom' } } }
  });
  mounted.push(root);

  assert.doesNotMatch(body().textContent, /No obligations assigned to you/, 'that is also an empty claim');
  assert.doesNotMatch(body().textContent, /No obligations yet/);
});

test('a failed refresh after a successful load keeps the rows already on screen', async () => {
  const { container, root } = await renderAs('Manager', {
    initialRows: [obligation({ title: 'Kept row' })]
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
});

/* ------------------------------------------------------------------ *
 * Defect 2: an obligation whose assignee was deactivated stays editable
 * ------------------------------------------------------------------ */

test('an obligation with a deactivated assignee can be opened for editing', async () => {
  const target = obligation({ title: 'Needs a new owner', assignedTo: DEACTIVATED_USER });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Needs a new owner'));
  await settled();

  assert.ok(editForm(), 'the edit form should open');
});

test('the assignee select offers the deactivated assignee and stays valid', async () => {
  const target = obligation({ title: 'Needs a new owner', assignedTo: DEACTIVATED_USER });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Needs a new owner'));
  await settled();

  const [, peopleSelect] = editSelects();
  const names = Array.from(peopleSelect.options).map((o) => o.textContent);

  assert.ok(
    names.some((n) => /Dana Deactivated/.test(n)),
    `the deactivated assignee must be selectable, saw ${JSON.stringify(names)}`
  );
  assert.equal(
    peopleSelect.value,
    'u9',
    'the form must resolve to the real assignee, not the empty placeholder'
  );
  assert.equal(
    peopleSelect.checkValidity(),
    true,
    'the defect: a required select holding "" made the form unsubmittable for everyone'
  );
});

test('an obligation with a deactivated assignee can be submitted after a reassignment', async () => {
  const target = obligation({ title: 'Needs a new owner', assignedTo: DEACTIVATED_USER });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Needs a new owner'));
  await settled();

  const form = editForm();
  setValue(form.querySelector('input[placeholder="Title"]'), 'Reassigned obligation');
  setValue(editSelects()[1], 'u3');
  setValue(form.querySelector('input[type="date"]'), '2026-12-15');
  await settled();

  await submit(form);
  await settled();

  const put = calls.find((c) => c.method === 'put');
  assert.ok(put, 'the form should submit; the defect made it impossible');
  assert.equal(put.url, '/obligations/o1');
  assert.equal(put.body.assignedTo, 'u3');
  assert.equal(put.body.title, 'Reassigned obligation');
  assert.equal(put.body.dueDate, '2026-12-15');
});

test('an obligation whose assignee is still active is unchanged and not duplicated', async () => {
  const target = obligation({ title: 'Normal owner', assignedTo: PEOPLE[1] });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Normal owner'));
  await settled();

  const [, peopleSelect] = editSelects();
  assert.equal(peopleSelect.value, 'u3');
  assert.equal(
    peopleSelect.options.length,
    PEOPLE.length + 1,
    'placeholder + one option per active user; a live assignee must not be appended twice'
  );
});

/* ------------------------------------------------------------------ *
 * Defect 3: an obligation on an archived contract names its own contract
 * ------------------------------------------------------------------ */

test('the contract select offers an archived contract that is missing from the list', async () => {
  const target = obligation({
    title: 'Closed out deal',
    contract: ARCHIVED_CONTRACT,
    assignedTo: PEOPLE[0]
  });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Closed out deal'));
  await settled();

  const [contractSelect] = editSelects();
  const labels = Array.from(contractSelect.options).map((o) => o.textContent);

  assert.ok(
    labels.some((l) => /CT-009/.test(l)),
    `the obligation's own contract must be listed, saw ${JSON.stringify(labels)}`
  );
  assert.equal(
    contractSelect.value,
    'c9',
    'the defect: with no matching option the browser resolved the value to the first contract'
  );
});

test('the live contract list order is preserved and nothing is duplicated', async () => {
  const target = obligation({ contract: ARCHIVED_CONTRACT, assignedTo: PEOPLE[0] });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Provide insurance certificate'));
  await settled();

  const [contractSelect] = editSelects();
  assert.equal(contractSelect.options.length, CONTRACTS.length + 1, 'both live contracts plus the archived one');
  assert.match(contractSelect.options[0].textContent, /CT-001/, 'existing options keep their order');
  assert.match(contractSelect.options[1].textContent, /CT-002/);
  assert.match(contractSelect.options[2].textContent, /CT-009/, 'the archived one is appended, not swapped in');
});

test('a live contract obligation is not given a duplicate option', async () => {
  const target = obligation({ title: 'Live deal', contract: CONTRACTS[1], assignedTo: PEOPLE[0] });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Live deal'));
  await settled();

  const [contractSelect] = editSelects();
  assert.equal(contractSelect.options.length, CONTRACTS.length, 'one option per contract, nothing appended');
  assert.equal(contractSelect.value, 'c2');
});

test('an archived-contract obligation keeps its own contract through a submit', async () => {
  const target = obligation({
    title: 'Closed out deal',
    contract: ARCHIVED_CONTRACT,
    assignedTo: PEOPLE[0]
  });
  const { container, root } = await renderAs('Manager', { initialRows: [target] });
  mounted.push(root);

  await click(editButtonFor(container, 'Closed out deal'));
  await settled();

  const form = editForm();
  const [contractSelect] = editSelects();
  assert.equal(contractSelect.disabled, true, 'an obligation cannot be moved between contracts from this form');
  assert.equal(contractSelect.value, 'c9', 'the form must display the contract the obligation belongs to');

  setValue(form.querySelector('input[placeholder="Title"]'), 'Renamed');
  setValue(form.querySelector('input[type="date"]'), '2026-12-01');
  await settled();

  await submit(form);
  await settled();

  const put = calls.find((c) => c.method === 'put');
  assert.ok(put, 'renaming should still be attempted');
  assert.equal(
    put.body.contract,
    'c9',
    'the payload must carry the obligation\'s real contract, never the first option'
  );
  assert.equal(put.body.title, 'Renamed');
  assert.equal(put.body.dueDate, '2026-12-01');
});

/* ------------------------------------------------------------------ *
 * The list itself still behaves
 * ------------------------------------------------------------------ */

test('rows, status filtering and counts render from a successful load', async () => {
  const initialRows = [
    obligation({ _id: 'o1', title: 'Alpha', status: 'Pending' }),
    obligation({ _id: 'o2', title: 'Bravo', status: 'Completed' }),
    obligation({ _id: 'o3', title: 'Charlie', status: 'Overdue' })
  ];
  const { container, root } = await renderAs('Manager', { initialRows });
  mounted.push(root);

  assert.match(body().textContent, /Alpha/);
  assert.match(body().textContent, /Bravo/);
  assert.match(body().textContent, /Charlie/);
  assert.equal(container.querySelector('tbody').querySelectorAll('tr').length, 3);

  const pendingChip = buttonsMatching(container, /Pending/i)[0];
  await click(pendingChip);
  await settled();

  const shown = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent);
  assert.ok(shown.some((t) => /Alpha/.test(t)));
  assert.ok(!shown.some((t) => /Bravo/.test(t)), 'the filter should hide non-matching rows');

  const allChip = buttonsMatching(container, new RegExp(STATUS_ALL === 'all' ? /All/i : /./))[0];
  await click(allChip);
  await settled();
  assert.equal(container.querySelector('tbody').querySelectorAll('tr').length, 3, 'All restores every row');
});

test('an Employee still sees only their own assignments', async () => {
  const { container, root } = await renderAs('Employee', {
    initialRows: [obligation({ assignedTo: { _id: 'u1', name: 'Probe' } })]
  });
  mounted.push(root);

  assert.match(body().textContent, /Provide insurance certificate/);
  assert.equal(
    container.querySelectorAll('button[aria-label^="Edit "]').length,
    0,
    'an Employee has no edit control'
  );
});