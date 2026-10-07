'use strict';

// Issue 34 - Contract creation and editing: form validation, states and payload.
//
// WHAT THIS COVERS
// ----------------
// `CreateContract` and `EditContract` are the only two forms that write a
// contract's commercial terms. Each of the cases below is a disagreement between
// what the form will accept and what the server will accept, or a value the form
// itself loses on the way in and out:
//
//   1. Amount. The server takes any non-negative finite number - the shared
//      validator is a plain `Number()` - but `<input type="number" min="0">`
//      without a `step` defaults to `step=1`, so the HTML step algorithm marks
//      every decimal amount invalid. `inputMode="decimal"` on the same input
//      invites exactly the value the control then refuses, and the form submit
//      is blocked before a request is ever made.
//   2. A zero amount. `data.amount || ''` turns a stored 0 into an empty
//      string, so a zero-amount contract opens in the editor with a required
//      field the user has to re-enter before anything can be saved.
//   3. A failed load. When the contract cannot be read - 404, or 403 for
//      someone who cannot open it - the editor cleared its loading flag and
//      rendered a fully populated, editable form with a working Save button
//      over an empty record. That is a form offering to save a contract that
//      was never loaded.
//   4. Role logic. The status control decided who may move status with a
//      hard-coded `['Admin', 'Manager']` list, while the codebase already has
//      `canManage` for exactly that question and every other component uses it.
//   5. Regression guards for the Issue 33 date work, so the create and edit
//      forms cannot go back to device-timezone formatting.
//
// The whole file runs under TZ=America/Los_Angeles. Every contract fixture here
// is invented; no production data is involved.

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

const { formatDate } = require('../src/utils/date.js');

const CONTRACT_START = '2027-06-01T00:00:00.000Z';
const CONTRACT_END = '2027-06-30T00:00:00.000Z';

const CONTRACT = {
  _id: 'c-1',
  contractNumber: 'CNT-2027-0001',
  title: 'Master services agreement',
  type: 'Vendor',
  partyName: 'Northwind Logistics',
  description: 'Warehouse and freight services for the EU region.',
  startDate: CONTRACT_START,
  endDate: CONTRACT_END,
  amount: 250000,
  currency: 'USD',
  status: 'Draft',
  isArchived: false,
  createdBy: { _id: 'u-1', name: 'Ada Admin' },
  assignedUser: { _id: 'u-2', name: 'Mia Manager' },
  createdAt: '2027-02-01T03:00:00.000Z',
  updatedAt: '2027-02-06T06:05:00.000Z'
};

const calls = [];
let failure = null;
// A failure that applies only to the WRITE. `failure` above also fails the
// initial GET, so a test that wants "the save was refused" would otherwise
// never get a contract to edit - and an editor that refuses to render an
// editable form over a record it never read is correct behaviour, not a bug.
let writeFailure = null;
let createdContract = CONTRACT;
let loadedContract = CONTRACT;
let navigated = [];
let routeId = 'c-1';

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (failure) throw failure;
    return { data: loadedContract };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    if (writeFailure) throw writeFailure;
    if (failure) throw failure;
    return { data: { ...createdContract, _id: 'c-new' } };
  },
  async put(url, body) {
    calls.push({ method: 'put', url, body });
    if (writeFailure) throw writeFailure;
    if (failure) throw failure;
    return { data: { ...loadedContract, ...body } };
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
const settled = () => act(async () => {});

const mountPage = async (pageRelPath, { role = 'Employee' } = {}) => {
  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u-2', name: 'Mia Manager', role } })
  });
  stubPackage(ROUTER_MODULE, {
    __esModule: true,
    useParams: () => ({ id: routeId }),
    useNavigate: () => (to) => { navigated.push(to); },
    useSearchParams: () => [new URLSearchParams(''), () => {}],
    Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children)
  });

  delete require.cache[require.resolve(path.join(SRC, pageRelPath))];
  const Page = require(path.join(SRC, pageRelPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Page, null)); });
  await settled();
  return container;
};

test.beforeEach(() => {
  calls.length = 0;
  navigated = [];
  failure = null;
  writeFailure = null;
  routeId = 'c-1';
  createdContract = CONTRACT;
  loadedContract = CONTRACT;
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

const text = (scope) => scope.textContent.replace(/\s+/g, ' ');

const named = (scope, label) => {
  const node = [...scope.querySelectorAll('label')].find((el) => el.textContent.trim() === label);
  assert.ok(node, `no label reading '${label}'`);
  return scope.querySelector(`#${CSS_ESCAPE(node.getAttribute('for'))}`);
};

// The ids are literal in the source, but escaping keeps a missing id from
// throwing an unhelpful selector error.
const CSS_ESCAPE = (value) => String(value).replace(/([^\w-])/g, '\\$1');

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

// jsdom fires `submit` whether or not the control is valid, so the validity
// state itself is asserted for the constraint cases rather than the request.
const submitForm = async (container) => {
  const form = container.querySelector('form');
  assert.ok(form, 'no form was rendered');
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settled();
  return form;
};

const completeCreateForm = async (container, overrides = {}) => {
  const values = {
    'Contract title': 'Master services agreement',
    'Counterparty or vendor name': 'Northwind Logistics',
    Amount: '250000',
    'Start date': '2027-06-01',
    'End date': '2027-06-30'
  };
  for (const [label, value] of Object.entries({ ...values, ...overrides })) {
    await setValue(named(container, label), value);
  }
};

const callOf = (method) => calls.find((c) => c.method === method);

/* ---------------- create: vocabulary the form offers ---------------- */

test('the create form offers every contract type and currency the server accepts', async () => {
  const container = await mountPage('pages/CreateContract.js');

  const types = [...named(container, 'Contract type').options].map((o) => o.value);
  assert.deepEqual(types, ['Vendor', 'Client', 'NDA', 'SLA', 'Employment', 'Partnership', 'Other']);

  const currencies = [...named(container, 'Currency').options].map((o) => o.value);
  assert.deepEqual(currencies, ['USD', 'EUR', 'GBP', 'INR']);
});

test('the create form starts blank, with the defaults the server defaults to', async () => {
  const container = await mountPage('pages/CreateContract.js');

  assert.equal(named(container, 'Contract title').value, '');
  assert.equal(named(container, 'Counterparty or vendor name').value, '');
  assert.equal(named(container, 'Description or summary').value, '');
  assert.equal(named(container, 'Amount').value, '');
  assert.equal(named(container, 'Start date').value, '');
  assert.equal(named(container, 'End date').value, '');
  assert.equal(named(container, 'Contract type').value, 'Vendor', 'the first type is the default');
  assert.equal(named(container, 'Currency').value, 'USD', 'USD is the default the model declares');
});

test('the required fields are the ones the server requires', async () => {
  const container = await mountPage('pages/CreateContract.js');

  for (const label of ['Contract title', 'Counterparty or vendor name', 'Amount', 'Start date', 'End date']) {
    assert.equal(named(container, label).required, true, `'${label}' is required on the server too`);
  }
  assert.equal(named(container, 'Description or summary').required, false, 'description is optional on the server');
  assert.equal(named(container, 'Contract type').required, false, 'a type is always selected');
  assert.equal(named(container, 'Currency').required, false, 'a currency is always selected');
});

/* ---------------- create: the amount control ---------------- */

test('the amount control accepts a decimal, which the server also accepts', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container, { Amount: '1234.56' });

  const amount = named(container, 'Amount');
  // `<input type="number">` defaults to step=1, so the HTML step algorithm
  // marks 1234.56 a mismatch and a real browser refuses to submit the form. The
  // server takes it (see issue34ContractWrite.test.js), so the control has to.
  assert.equal(amount.value, '1234.56');
  assert.equal(amount.validity.stepMismatch, false, 'a decimal amount must not be a step mismatch');
  assert.equal(amount.checkValidity(), true, 'a decimal amount must be submittable');
});

test('the amount control still refuses a negative amount before the server sees it', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container, { Amount: '-5' });

  const amount = named(container, 'Amount');
  assert.equal(amount.validity.rangeUnderflow, true, 'min=0 still blocks a negative amount');
  assert.equal(amount.checkValidity(), false);
});

test('zero is a valid amount to submit', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container, { Amount: '0' });
  assert.equal(named(container, 'Amount').checkValidity(), true);
});

/* ---------------- create: submitting ---------------- */

test('a valid create posts the form to /contracts and returns to the list', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);
  await setValue(named(container, 'Description or summary'), 'Freight services for the EU region.');

  await submitForm(container);

  const call = callOf('post');
  assert.ok(call, 'the form must send a request');
  assert.equal(call.url, '/contracts');
  assert.deepEqual(call.body, {
    title: 'Master services agreement',
    type: 'Vendor',
    partyName: 'Northwind Logistics',
    description: 'Freight services for the EU region.',
    startDate: '2027-06-01',
    endDate: '2027-06-30',
    amount: '250000',
    currency: 'USD'
  });
  assert.deepEqual(navigated, ['/contracts'], 'a created contract is left in the list, where it is visible');
});

test('the payload carries calendar dates, not shifted timestamps', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);
  await submitForm(container);

  const body = callOf('post').body;
  // An <input type="date"> yields "YYYY-MM-DD" and the server reads it as UTC
  // midnight, so the string must reach the API untouched.
  assert.equal(body.startDate, '2027-06-01');
  assert.equal(body.endDate, '2027-06-30');
  assert.equal(body.startDate, new Date(CONTRACT_START).toISOString().slice(0, 10));
  assert.equal(body.endDate, new Date(CONTRACT_END).toISOString().slice(0, 10));
});

test('nothing in the create payload can set the status, the owner or the archive flag', async () => {
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);
  await submitForm(container);

  const body = callOf('post').body;
  for (const field of ['status', 'createdBy', 'isArchived', 'contractNumber', '_id']) {
    assert.equal(field in body, false, `the form must not send '${field}'`);
  }
  assert.equal(body.amount, '250000', 'the amount is sent as typed, and the server validates it');
});

test('a second submit while the first is in flight sends nothing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowPost = API.post;
  API.post = async (url, body) => {
    calls.push({ method: 'post', url, body });
    await gate;
    return { data: createdContract };
  };

  try {
    const container = await mountPage('pages/CreateContract.js');
    await completeCreateForm(container);

    const form = container.querySelector('form');
    const button = container.querySelector('button[type="submit"]');
    const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    // Two SEPARATE interactions, each flushed before the next is delivered.
    // This is what a double tap or a second Enter key actually is: the browser
    // delivers one event, the framework renders, and only then does the next
    // event arrive. Firing both inside a single synchronous act() block is not
    // a browser sequence - React has not re-rendered between them, so the
    // handler still sees the pre-submit state - and asserting against it tests
    // React's batching rather than the form.
    await act(async () => { submit(); });
    await settled();
    assert.equal(button.disabled, true, 'the button is disabled while the first request is in flight');

    await act(async () => { submit(); });
    await settled();

    // A real click cannot reach the handler either, because the disabled
    // default button stops implicit submission from firing `submit` at all.
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settled();

    assert.equal(calls.filter((c) => c.method === 'post').length, 1, 'only one request may leave the form');
  } finally {
    API.post = slowPost;
    await act(async () => { release(); });
  }
});

test('the submit button is disabled and announced while the request is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowPost = API.post;
  API.post = async (url, body) => {
    calls.push({ method: 'post', url, body });
    await gate;
    return { data: createdContract };
  };

  try {
    const container = await mountPage('pages/CreateContract.js');
    await completeCreateForm(container);
    const button = container.querySelector('button[type="submit"]');
    assert.equal(button.disabled, false);

    await act(async () => {
      container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settled();

    assert.equal(button.disabled, true, 'the button is disabled while saving');
    assert.equal(button.getAttribute('aria-busy'), 'true', 'the busy state is announced');
    assert.match(text(button), /Saving draft/, 'the button says what it is doing');
  } finally {
    API.post = slowPost;
    await act(async () => { release(); });
  }
});

/* ---------------- create: failure handling ---------------- */

test('a rejected create shows the server message and keeps everything typed', async () => {
  failure = httpError(400, 'The end date must be on or after the start date');
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);
  await setValue(named(container, 'Description or summary'), 'Typed before the failure.');

  await submitForm(container);

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /The end date must be on or after the start date/);
  assert.equal(named(container, 'Contract title').value, 'Master services agreement', 'no typed data is lost');
  assert.equal(named(container, 'Description or summary').value, 'Typed before the failure.');
  assert.deepEqual(navigated, [], 'a rejected create must not navigate away');
  const button = container.querySelector('button[type="submit"]');
  assert.equal(button.disabled, false, 'the user can correct the value and try again');
  assert.doesNotMatch(text(button), /Saving/, 'the button is no longer claiming to be saving');
});

test('a create failure with no server message still says something useful', async () => {
  const offline = new Error('Network request failed');
  failure = offline;
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);

  await submitForm(container);

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(text(alert), /Failed to create contract/);
  assert.doesNotMatch(text(alert), /Network request failed/, 'the raw transport error is not the user-facing text');
});

test('an expired session is reported, not retried into a blank page', async () => {
  failure = httpError(401, 'Not authorized, token failed');
  const container = await mountPage('pages/CreateContract.js');
  await completeCreateForm(container);

  await submitForm(container);

  assert.match(text(container.querySelector('[role="alert"]')), /Not authorized/);
  assert.deepEqual(navigated, [], 'the interceptor owns the redirect to login; the form does not navigate');
});

/* ---------------- edit: loading ---------------- */

test('a zero-amount contract opens with its zero still in the form', async () => {
  loadedContract = { ...CONTRACT, amount: 0 };
  const container = await mountPage('pages/EditContract.js');

  const amount = named(container, 'Amount');
  assert.equal(amount.value, '0', 'a stored 0 must not become an empty required field');
  assert.equal(amount.checkValidity(), true, 'a zero-amount contract must be saveable as it stands');
});

test('a contract that cannot be read does not present an editable form', async () => {
  failure = httpError(403, 'You do not have access to this contract');
  const container = await mountPage('pages/EditContract.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the reason must be shown');
  assert.match(text(alert), /do not have access/);
  // Compared as a boolean rather than with assert.equal(node, null): when the
  // form IS present, assert.equal tries to build a diff of two jsdom nodes,
  // which exhausts memory and kills the runner before it can report anything
  // useful.
  assert.equal(container.querySelector('form') === null, true, 'there is nothing loaded, so there is nothing to edit');
  assert.equal(container.querySelector('button[type="submit"]') === null, true, 'no Save button over a record that was never read');
  assert.ok(
    [...container.querySelectorAll('button, a')].some((el) => /Back|contract list|Cancel/i.test(el.textContent)),
    'there must be a way out'
  );
});

test('a missing contract says so instead of offering an empty form', async () => {
  failure = httpError(404, 'Contract not found');
  const container = await mountPage('pages/EditContract.js');

  assert.match(text(container.querySelector('[role="alert"]')), /Contract not found/);
  assert.equal(container.querySelector('form') === null, true, 'no form over a contract that does not exist');
});

test('the editor shows a loading state and not an empty form while it reads', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowGet = API.get;
  API.get = async (url) => {
    calls.push({ method: 'get', url });
    await gate;
    return { data: loadedContract };
  };

  try {
    const container = await mountPage('pages/EditContract.js');
    const status = container.querySelector('[role="status"]');
    assert.ok(status, 'the loading state is announced');
    assert.equal(status.getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelector('form') === null, true, 'no form before the contract has arrived');
    assert.match(text(status), /Loading contract editor/);
  } finally {
    API.get = slowGet;
    await act(async () => { release(); });
  }
});

/* ---------------- edit: values and the lock ---------------- */

test('the editor shows the stored contract, and renders dates as calendar days', async () => {
  const container = await mountPage('pages/EditContract.js');

  assert.equal(named(container, 'Contract title').value, 'Master services agreement');
  assert.equal(named(container, 'Counterparty or vendor name').value, 'Northwind Logistics');
  assert.equal(named(container, 'Amount').value, '250000');
  assert.equal(named(container, 'Currency').value, 'USD');
  assert.equal(named(container, 'Start date').value, '2027-06-01', 'not the day before');
  assert.equal(named(container, 'End date').value, '2027-06-30');
  assert.equal(named(container, 'Start date').value, new Date(CONTRACT_START).toISOString().slice(0, 10));
  assert.doesNotMatch(named(container, 'End date').value, /^2027-06-29$/);
});

test('a draft keeps its financial terms and dates editable', async () => {
  loadedContract = { ...CONTRACT, status: 'Draft' };
  const container = await mountPage('pages/EditContract.js');

  for (const label of ['Amount', 'Currency', 'Start date', 'End date']) {
    assert.equal(named(container, label).disabled, false, `'${label}' is editable in Draft`);
  }
  assert.equal(container.querySelector('[role="note"]'), null, 'no lock notice is shown for a draft');
});

test('an approved contract shows its terms locked, for every role', async () => {
  loadedContract = { ...CONTRACT, status: 'Active' };

  for (const role of ['Employee', 'Manager', 'Admin']) {
    const container = await mountPage('pages/EditContract.js', { role });
    for (const label of ['Amount', 'Currency', 'Start date', 'End date']) {
      assert.equal(named(container, label).disabled, true, `${role} must see '${label}' locked on an Active contract`);
    }
    assert.equal(named(container, 'Contract title').disabled, false, 'descriptive fields stay editable');
    const note = container.querySelector('[role="note"]');
    assert.ok(note, `${role} must be told why the terms cannot be changed here`);
    assert.match(text(note), /amendment/i);
  }
});

test('only a manager or admin is offered the status control, and the roles helper decides', async () => {
  const source = fs.readFileSync(path.join(SRC, 'pages', 'EditContract.js'), 'utf8');
  assert.match(
    source,
    /canManage/,
    "the page must decide the role question with the shared canManage() helper, not a hard-coded role list"
  );

  loadedContract = { ...CONTRACT, status: 'Draft' };
  for (const [role, offered] of [['Employee', false], ['Manager', true], ['Admin', true]]) {
    const container = await mountPage('pages/EditContract.js', { role });
    const control = [...container.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Status');
    if (offered) {
      assert.ok(control, `${role} is offered the status control`);
      assert.equal(container.querySelector('#edit-status').value, 'Draft');
    } else {
      assert.equal(control, undefined, `${role} is not offered the status control`);
    }
  }
});

test('an employee cannot smuggle a status change into the payload', async () => {
  loadedContract = { ...CONTRACT, status: 'Draft' };
  const container = await mountPage('pages/EditContract.js', { role: 'Employee' });
  await setValue(named(container, 'Contract title'), 'Renamed by an employee');
  await submitForm(container);

  const body = callOf('put').body;
  assert.equal('status' in body, false, 'the status is dropped rather than sent and refused');
  assert.equal(body.title, 'Renamed by an employee');
});

/* ---------------- edit: submitting ---------------- */

test('a successful edit returns to the contract it edited', async () => {
  const container = await mountPage('pages/EditContract.js');
  await setValue(named(container, 'Contract title'), 'Renamed master services agreement');
  await submitForm(container);

  const call = callOf('put');
  assert.ok(call);
  assert.equal(call.url, '/contracts/c-1');
  assert.deepEqual(navigated, ['/contracts/c-1']);
});

test('an edit resubmits the unchanged locked values and is accepted', async () => {
  loadedContract = { ...CONTRACT, status: 'Active' };
  const container = await mountPage('pages/EditContract.js');
  await setValue(named(container, 'Contract title'), 'Corrected title');
  await submitForm(container);

  const body = callOf('put').body;
  assert.equal(body.title, 'Corrected title');
  assert.equal(body.amount, '250000', 'the always-full form still sends the amount');
  assert.equal(body.startDate, '2027-06-01');
  assert.equal(body.endDate, '2027-06-30');
});

test('an edit refused by the server explains itself and keeps the form usable', async () => {
  // Only the SAVE is refused. The contract itself loads, so the form is real
  // and has to survive the refusal with everything the user typed.
  writeFailure = httpError(409, 'Cannot change amount on a contract in state \'Active\'.');
  const container = await mountPage('pages/EditContract.js');
  await setValue(named(container, 'Contract title'), 'Renamed anyway');
  await submitForm(container);

  const alert = container.querySelector('[role="alert"]');
  assert.match(text(alert), /Cannot change amount/);
  assert.equal(named(container, 'Contract title').value, 'Renamed anyway', 'the edit is not silently discarded');
  assert.deepEqual(navigated, [], 'a refused edit must not navigate away');
  assert.equal(container.querySelector('button[type="submit"]').disabled, false, 'the user can correct it and retry');
});

test('an edit of an archived contract is refused by the server and reported', async () => {
  writeFailure = httpError(400, 'Archived contracts cannot be edited');
  loadedContract = { ...CONTRACT, isArchived: true };
  const container = await mountPage('pages/EditContract.js');
  await setValue(named(container, 'Contract title'), 'Renamed anyway');
  await submitForm(container);

  assert.match(text(container.querySelector('[role="alert"]')), /Archived contracts cannot be edited/);
  assert.deepEqual(navigated, []);
});

/* ---------------- navigation and regression guards ---------------- */

test('the create page has a cancel that returns to the list, and the editor one to its contract', async () => {
  const create = await mountPage('pages/CreateContract.js');
  const cancel = [...create.querySelectorAll('button')].find((b) => /Cancel/.test(b.textContent));
  assert.ok(cancel, 'the create form offers a cancel');
  await act(async () => { cancel.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.deepEqual(navigated, ['/contracts']);

  navigated = [];
  const edit = await mountPage('pages/EditContract.js');
  const editCancel = [...edit.querySelectorAll('button')].find((b) => /Cancel/.test(b.textContent));
  assert.ok(editCancel);
  await act(async () => { editCancel.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.deepEqual(navigated, ['/contracts/c-1']);
});

test('both forms have exactly one page heading, and every control has a label', async () => {
  for (const page of ['CreateContract.js', 'EditContract.js']) {
    const container = await mountPage(`pages/${page}`);
    assert.equal(container.querySelectorAll('h1').length, 1, `${page} has one h1`);

    for (const input of container.querySelectorAll('input, select, textarea')) {
      const hasLabel = Boolean(
        dom.window.document.querySelector(`label[for="${input.getAttribute('id')}"]`)
      );
      assert.ok(hasLabel, `${page}: the control named '${input.getAttribute('name')}' has no associated label`);
    }
  }
});

test('neither form renders a contract date in the device timezone', async () => {
  for (const page of ['CreateContract.js', 'EditContract.js']) {
    const source = fs.readFileSync(path.join(SRC, 'pages', page), 'utf8');
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(
      withoutComments,
      /toLocaleDateString/,
      `${page} must not format a calendar date with the device timezone (Issue 33 regression)`
    );
  }
  // The helper the two forms rely on is still UTC-pinned.
  assert.equal(formatDate(CONTRACT_END), '30 Jun 2027');
  assert.equal(formatDate(CONTRACT_START), '1 Jun 2027');
});

test('neither form carries demo or fake contract content', async () => {
  for (const page of ['CreateContract.js', 'EditContract.js']) {
    const source = fs.readFileSync(path.join(SRC, 'pages', page), 'utf8');
    for (const forbidden of [
      'Lorem ipsum', 'John Doe', 'Jane Doe', 'Acme Corp', 'Test Contract',
      'invoice', 'Invoice', 'payment', 'Payment', 'billing', 'Billing',
      'subscription', 'Subscription', 'receivable', 'RicozInvoice', 'TODO', 'FIXME'
    ]) {
      assert.equal(source.includes(forbidden), false, `${page} contains '${forbidden}'`);
    }
  }
});
