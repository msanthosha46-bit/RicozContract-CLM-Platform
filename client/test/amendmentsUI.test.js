'use strict';

// Amendment UI - the three components that read, write and decide amendments.
//
// WHAT THIS COVERS
// ----------------
// `client/test/amendments.test.js` pins the pure rules in utils/amendments.js,
// and `issue33ContractDetail.test.js` proves the contract detail page wires the
// history and the request button up. Neither file mounts the components
// themselves, so the behaviour that exists only inside them was untested:
//
//   * RequestAmendmentModal - the exact payload a valid request sends, the no-op
//     and refusal paths, and who is offered the assignee picker (together with
//     the gated /users/directory read behind it).
//   * AmendmentHistory - its loading and empty states, and the decision line a
//     decided request renders.
//   * AmendmentQueue - the approve/reject write, the sort that keeps Pending on
//     top, separation of duties made visible, and both failure paths.
//
// The whole file runs under TZ=America/Los_Angeles. Every fixture here is
// invented; no production data is involved.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

// Before anything reads the clock, so a device-timezone regression is observable
// on a machine in any zone.
process.env.TZ = 'America/Los_Angeles';

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
const { UNASSIGNED } = require('../src/utils/amendments.js');

const CONTRACT = {
  _id: 'c-1',
  contractNumber: 'CNT-2027-0001',
  title: 'Master services agreement',
  status: 'Active',
  amount: 250000,
  currency: 'USD',
  startDate: '2027-06-01T00:00:00.000Z',
  endDate: '2027-06-30T00:00:00.000Z',
  assignedUser: { _id: 'u-7', name: 'Bruno Buyer' }
};

const MANAGER = { _id: 'u-2', name: 'Mia Manager', role: 'Manager' };

const PENDING = {
  _id: 'a-pending',
  status: 'Pending',
  reason: 'The vendor raised its rates',
  createdAt: '2027-03-01T09:00:00.000Z',
  proposed: { amount: 3000 },
  before: { amount: 2500 },
  requestedBy: { _id: 'u-3', name: 'Rita Requester' },
  contract: { _id: 'c-1', title: 'Master services agreement', contractNumber: 'CNT-2027-0001' }
};

const APPROVED = {
  _id: 'a-approved',
  status: 'Approved',
  reason: 'Extend by one month',
  createdAt: '2027-02-01T09:00:00.000Z',
  proposed: { endDate: '2027-07-31T00:00:00.000Z' },
  before: { endDate: '2027-06-30T00:00:00.000Z' },
  requestedBy: { _id: 'u-3', name: 'Rita Requester' },
  decidedBy: { _id: 'u-4', name: 'Ada Admin' },
  decidedAt: '2027-02-02T10:00:00.000Z',
  decisionComments: 'Agreed with the vendor',
  contract: { _id: 'c-1', title: 'Master services agreement', contractNumber: 'CNT-2027-0001' }
};

const calls = [];
let directoryResponse = [];
let queueResponse = [];
let getFailure = null;
let directoryFailure = null;
let postFailure = null;
let writeFailure = null;

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (url === '/users/directory') {
      if (directoryFailure) throw directoryFailure;
      return { data: directoryResponse };
    }
    if (getFailure) throw getFailure;
    return { data: queueResponse };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    if (postFailure) throw postFailure;
    return { data: {} };
  },
  async put(url, body) {
    calls.push({ method: 'put', url, body });
    if (writeFailure) throw writeFailure;
    return { data: {} };
  }
};

// `services/api.js` and `context/AuthContext.js` live under src and resolve from
// it; react-router-dom is a package and has to be resolved by name.
const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const stubPackage = (name, exports) => {
  const filename = require.resolve(name, { paths: [SRC] });
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const ROUTER_MODULE = 'react-router-dom';
const mounted = [];

const settled = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
});

// A component is re-required on every mount so it re-binds the stubbed API
// rather than holding a stale reference from an earlier mount.
const mount = async (relPath, { props = {}, user = MANAGER } = {}) => {
  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user })
  });
  stubPackage(ROUTER_MODULE, {
    __esModule: true,
    useParams: () => ({ id: 'c-1' }),
    useNavigate: () => () => {},
    useSearchParams: () => [new URLSearchParams(''), () => {}],
    Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children)
  });

  delete require.cache[require.resolve(path.join(SRC, relPath))];
  const Component = require(path.join(SRC, relPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Component, props)); });
  await settled();
  return container;
};

test.beforeEach(() => {
  calls.length = 0;
  directoryResponse = [{ _id: 'u-9', name: 'Grace Hopper' }];
  queueResponse = [];
  getFailure = null;
  directoryFailure = null;
  postFailure = null;
  writeFailure = null;
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

const text = (scope) => scope.textContent.replace(/\s+/g, ' ');

// The ids are literal in the source, but escaping keeps a missing id from
// throwing an unhelpful selector error.
const CSS_ESCAPE = (value) => String(value).replace(/([^\w-])/g, '\\$1');

const control = (scope, label) => {
  const node = [...scope.querySelectorAll('label')].find((el) => el.textContent.trim() === label);
  if (!node) return null;
  const id = node.getAttribute('for');
  return id ? scope.querySelector(`#${CSS_ESCAPE(id)}`) : null;
};

const setValue = async (input, value) => {
  const prototype = input.tagName === 'SELECT'
    ? dom.window.HTMLSelectElement.prototype
    : input.tagName === 'TEXTAREA'
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};

const submitForm = async (container) => {
  const form = container.querySelector('form');
  assert.ok(form, 'no form was rendered');
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settled();
};

const click = async (node) => {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settled();
};

// The row's decide buttons are the only controls whose aria-label starts with
// the verb, so a filter chip reading "Approved" can never be picked by mistake.
const rowAction = (container, verb) =>
  [...container.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') || '').startsWith(`${verb} amendment for `));

const callOf = (method) => calls.find((c) => c.method === method);

const modalProps = ({ onSubmitted = () => {}, user = MANAGER, contract = CONTRACT, amendments = [] } = {}) => ({
  isOpen: true,
  contract,
  amendments,
  user,
  onClose: () => {},
  onSubmitted
});

/* ---------------- RequestAmendmentModal ---------------- */

test('a request posts only the changed fields with the trimmed reason, then reports success', async () => {
  let submissions = 0;
  const container = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ onSubmitted: () => { submissions += 1; } })
  });

  await setValue(control(container, 'Amount'), '2000');
  await setValue(control(container, 'End date'), '2027-07-01');
  await setValue(container.querySelector('#amend-reason'), '  Re-negotiated price  ');
  await submitForm(container);

  const call = callOf('post');
  assert.ok(call, 'a valid request must reach the server');
  assert.equal(call.url, '/contract-amendments');
  assert.deepEqual(call.body, {
    contract: 'c-1',
    proposed: { amount: 2000, endDate: '2027-07-01' },
    reason: 'Re-negotiated price'
  });
  assert.equal(submissions, 1);
});

test('a request that proposes the value already in force never leaves the form', async () => {
  let submissions = 0;
  const container = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ onSubmitted: () => { submissions += 1; } })
  });

  await setValue(control(container, 'Amount'), '250000');
  await setValue(container.querySelector('#amend-reason'), 'no real change');
  await submitForm(container);

  assert.equal(callOf('post'), undefined, 'a no-op amendment must not occupy the single open request slot');
  assert.equal(submissions, 0);
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the user must be told why there is no request');
  assert.match(text(alert), /already match the contract/);
});

test('a refused request shows the server message and stays open for a retry', async () => {
  postFailure = httpError(409, "Cannot change amount on a contract in state 'Active'.");
  let submissions = 0;
  const container = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ onSubmitted: () => { submissions += 1; } })
  });

  await setValue(control(container, 'Amount'), '2000');
  await setValue(container.querySelector('#amend-reason'), 'price');
  await submitForm(container);

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the server message is what the user reads');
  assert.match(text(alert), /Cannot change amount/);
  assert.equal(submissions, 0, 'a refused request must not be reported as submitted');
  assert.equal(control(container, 'Amount').value, '2000', 'the request is not silently discarded');
  assert.equal(container.querySelector('button[type="submit"]').disabled, false, 'the user can correct it and try again');
});

test('the assignee picker is offered only to an admin or manager, and reads the directory only for them', async () => {
  const employee = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ user: { _id: 'u-5', name: 'Eli Employee', role: 'Employee' } })
  });
  assert.equal(control(employee, 'Assigned user'), null, 'an employee gets no assignee control');
  assert.equal(calls.some((c) => c.url === '/users/directory'), false, 'an employee must not trigger the gated directory read');
  assert.match(text(employee), /Ask an administrator or manager to reassign/);

  calls.length = 0;
  const manager = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ user: MANAGER })
  });
  const picker = control(manager, 'Assigned user');
  assert.ok(picker, 'a manager is offered the assignee picker');
  assert.deepEqual([...picker.options].map((o) => o.value), ['', UNASSIGNED, 'u-9']);
  assert.equal(calls.some((c) => c.url === '/users/directory'), true, 'the picker needs the directory');

  calls.length = 0;
  directoryFailure = httpError(500, 'Internal server error');
  const failed = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ user: MANAGER })
  });
  assert.equal(control(failed, 'Assigned user'), null, 'no picker over a directory that did not load');
  assert.match(text(failed), /directory could not be loaded/);
});

test('the submit control is disabled and the reason stated when the contract cannot be amended', async () => {
  const container = await mount('components/Amendments/RequestAmendmentModal.js', {
    props: modalProps({ contract: { ...CONTRACT, status: 'Draft' } })
  });

  const note = container.querySelector('[role="note"]');
  assert.ok(note, 'the reason must be stated, not just the control hidden');
  assert.match(text(note), /edited directly/);
  assert.equal(container.querySelector('button[type="submit"]').disabled, true);
});

/* ---------------- AmendmentHistory ---------------- */

test('the history announces a loading state rather than an empty trail', async () => {
  const container = await mount('components/Amendments/AmendmentHistory.js', {
    props: { amendments: [], loading: true, isEditableStatus: false }
  });

  const status = container.querySelector('[role="status"]');
  assert.ok(status, 'the loading state is announced');
  assert.equal(status.getAttribute('aria-busy'), 'true');
  assert.doesNotMatch(text(container), /No amendments/, 'a still-loading trail must not claim there is nothing there');
});

test('an empty trail explains the lock, or says no amendment is needed for a directly-edited contract', async () => {
  const locked = await mount('components/Amendments/AmendmentHistory.js', {
    props: { amendments: [], loading: false, isEditableStatus: false }
  });
  assert.match(text(locked), /No amendments yet/);
  assert.match(text(locked), /locked from submission/);

  const draft = await mount('components/Amendments/AmendmentHistory.js', {
    props: { amendments: [], loading: false, isEditableStatus: true }
  });
  assert.match(text(draft), /No amendments needed/);
});

test('a decided request renders its before/after, reason and decision, and a pending one says it awaits a decision', async () => {
  const container = await mount('components/Amendments/AmendmentHistory.js', {
    props: { amendments: [APPROVED, PENDING], loading: false, isEditableStatus: false }
  });

  assert.match(text(container), /Extend by one month/);
  assert.match(text(container), /Agreed with the vendor/);
  assert.match(text(container), /Approved by Ada Admin/);
  // The trail shows the change as before -> after, with contract dates rendered
  // as UTC calendar days, not the device-timezone day before (the 29th).
  assert.match(text(container), /30/, 'the before date stayed on the 30th');
  assert.match(text(container), /31/, 'the proposed date is the 31st');
  assert.doesNotMatch(text(container), /\b29\b/);
  assert.match(text(container), /The vendor raised its rates/);
  assert.match(text(container), /Awaiting a decision/);
});

/* ---------------- AmendmentQueue ---------------- */

test('approving a row sends the action and comment, toasts the result, and reloads the queue', async () => {
  queueResponse = [PENDING];
  const container = await mount('pages/AmendmentQueue.js');

await setValue(container.querySelector('[aria-label="Optional comment for CNT-2027-0001"]'), 'Looks right');
  const approve = rowAction(container, 'Approve');
  assert.ok(approve, 'a decidably pending row offers an approve action');
  await click(approve);

  const call = callOf('put');
  assert.ok(call, 'the decision must reach the server');
  assert.equal(call.url, '/contract-amendments/a-pending/action');
  assert.deepEqual(call.body, { action: 'Approved', comments: 'Looks right' });
  const toast = container.querySelector('[role="status"]');
  assert.ok(toast, 'the outcome is announced');
  assert.match(text(toast), /Amendment approved/);
  assert.ok(calls.filter((c) => c.method === 'get').length >= 2, 'the queue reloads after a decision');
});

test('a requester sees no decision buttons on their own request, only the reason', async () => {
  queueResponse = [{ ...PENDING, requestedBy: { _id: 'u-2', name: 'Mia Manager' } }];
  const container = await mount('pages/AmendmentQueue.js', { user: MANAGER });

  const row = container.querySelector('[data-amendment-id="a-pending"]');
  assert.ok(row, 'the request is listed for its requester too');
  assert.equal([...row.querySelectorAll('button')].some((b) => /Approve|Reject/.test(b.textContent)), false,
    'the separation-of-duties rule is visible, not reported as a 400');
  assert.match(text(row), /cannot approve or reject your own amendment/);
});

test('pending requests are listed before decided ones whatever order the server returns', async () => {
  queueResponse = [APPROVED, PENDING];
  const container = await mount('pages/AmendmentQueue.js');

  const ids = [...container.querySelectorAll('[data-amendment-id]')].map((r) => r.getAttribute('data-amendment-id'));
  assert.deepEqual(ids, ['a-pending', 'a-approved'],
    'the work sits on top of the history, so it is not scrolled out of reach');
});

test('a queue that cannot be loaded reports the error and never claims it is empty', async () => {
  getFailure = httpError(500, 'Internal server error');
  const container = await mount('pages/AmendmentQueue.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /Internal server error/);
  assert.equal(container.querySelector('[data-amendment-id]'), null, 'no requests are listed over a failed read');
  assert.doesNotMatch(text(container), /No amendment requests/, 'a failed load must not read as an empty queue');
  assert.match(text(container), /amendment list could not be loaded/);
});

test('a successful read that returns no requests keeps the empty state', async () => {
  queueResponse = [];
  const container = await mount('pages/AmendmentQueue.js');

  assert.equal(container.querySelector('[role="alert"]'), null, 'an empty result is not an error');
  assert.match(text(container), /No amendment requests/, 'the empty queue still explains itself');
  assert.doesNotMatch(text(container), /could not be loaded/, 'a success must not borrow the failure message');
});

test('a decision refused because the contract moved is reported and leaves the row actionable', async () => {
  queueResponse = [PENDING];
  writeFailure = httpError(409, 'The contract changed since this request was raised');
  const container = await mount('pages/AmendmentQueue.js');

  const approve = rowAction(container, 'Approve');
  assert.ok(approve);
  await click(approve);

  assert.match(text(container.querySelector('[role="alert"]')), /contract changed/);
  const stillThere = rowAction(container, 'Approve');
  assert.ok(stillThere, 'the row is still listed with its actions');
  assert.equal(stillThere.disabled, false, 'the row is not left stuck in a busy state');
});