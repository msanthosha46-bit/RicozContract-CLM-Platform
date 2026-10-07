'use strict';

// Behavioural regression tests for Obligation creation.
//
// The report behind this file claimed the Obligations page had no Add/Create
// functionality. It does: `Obligations.js` renders a "New obligation" button in
// the header and again as the empty-state call to action, opens a "Create
// obligation" modal, and POSTs to /api/obligations.
//
// workItemStatus.test.js already pins the *source* of that flow, and
// server/test/phase3.test.js already pins the endpoint and its role gate
// (Employee 403, Manager 201). Neither of those can answer the question that
// actually matters here, which is the one a role-scoped bug would hide: does a
// real Admin or Manager, in a real mounted page, get a working control?
//
// A regex over the source sees `onClick={openCreate}` whether or not the button
// is ever rendered for the role in front of you, whether the modal opens, and
// whether submitting sends the fields the user typed. So this file mounts the
// real page for each of the three roles and drives it.
//
// Same zero-install jsdom + Babel harness as controls.test.js and
// statusFilterChipsDom.test.js, with only two seams stubbed: the axios instance
// and the auth context.

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

const CONTRACTS = [
  { _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' },
  { _id: 'c2', contractNumber: 'CT-002', title: 'Lease Agreement' }
];

const PEOPLE = [
  { _id: 'u1', name: 'Ada Admin' },
  { _id: 'u2', name: 'Mia Manager' },
  { _id: 'u3', name: 'Eli Employee' }
];

// Every request the page makes is recorded, so the tests can assert on the
// traffic itself rather than only on what ended up painted.
const calls = [];

let posted = [];
let postFailsWith = null;

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (url === '/obligations') return { data: posted.map((o) => o.saved) };
    if (url.startsWith('/contracts')) return { data: CONTRACTS };
    if (url === '/users/directory') return { data: PEOPLE };
    return { data: [] };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    if (postFailsWith) throw postFailsWith;
    posted = [...posted, { saved: { _id: `new${posted.length + 1}`, status: 'Pending', ...body } }];
    return { data: posted[posted.length - 1].saved };
  },
  async put(url, body) {
    calls.push({ method: 'put', url, body });
    return { data: body };
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const renderAs = async (role) => {
  calls.length = 0;
  posted = [];
  postFailsWith = null;

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'me', name: 'Probe', role } })
  });

  // The page binds the auth context when it is required, so a cached copy of
  // the module would keep serving the previous test's role. Reload it every
  // time or these tests silently assert against the wrong user.
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

const fillCreateForm = async (form) => {
  setValue(form.querySelector('input[placeholder="Title"]'), 'Insurance certificate');
  setValue(form.querySelectorAll('select')[0], 'c1');
  setValue(form.querySelectorAll('select')[1], 'u3');
  setValue(form.querySelector('input[type="date"]'), '2026-11-30');
  setValue(form.querySelector('textarea'), 'Proof of cover');
  await settled();
};

const submit = async (form) => act(async () => {
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
 * A manager can create an obligation
 * ------------------------------------------------------------------ */

test('a Manager is offered a create control', async () => {
  const { container, root } = await renderAs('Manager');
  mounted.push(root);

  const createButtons = buttonsMatching(container, /New obligation/i);
  assert.ok(createButtons.length >= 1, 'a Manager should see a "New obligation" button');
});

test('the empty state offers a create control to a Manager', async () => {
  const { container, root } = await renderAs('Manager');
  mounted.push(root);

  assert.match(body().textContent, /No obligations yet/);
  assert.ok(
    buttonsMatching(container, /New obligation/i).length >= 2,
    'the empty state should carry its own call to action, not only the header button'
  );
});

test('opening the create control reveals the form with contracts and people loaded', async () => {
  const { container, root } = await renderAs('Manager');
  mounted.push(root);

  await click(buttonsMatching(container, /New obligation/i)[0]);
  await settled();

  assert.match(body().textContent, /Create obligation/);
  const form = body().querySelector('#obligation-form');
  assert.ok(form, 'the create form should be in the DOM');

  // Both dropdowns are populated from the endpoints openCreate awaits before it
  // opens. An Admin/Manager pair is required: the modal is gated on canManage,
  // and /users/directory is gated authorize('Admin','Manager') server-side, so a
  // mismatch here would leave a permitted Manager staring at an empty assignee
  // list, or an unpermitted Employee reaching a directory call.
  const contractSelect = form.querySelectorAll('select')[0];
  const peopleSelect = form.querySelectorAll('select')[1];
  assert.equal(contractSelect.options.length, CONTRACTS.length + 1, 'placeholder + one option per contract');
  assert.match(contractSelect.options[1].textContent, /CT-001/);
  assert.equal(peopleSelect.options.length, PEOPLE.length + 1, 'placeholder + one option per user');
  assert.match(peopleSelect.options[1].textContent, /Ada Admin/);
});

test('an Admin submits the create form and the new obligation appears', async () => {
  const { container, root } = await renderAs('Admin');
  mounted.push(root);

  await click(buttonsMatching(container, /New obligation/i)[0]);
  await settled();

  const form = body().querySelector('#obligation-form');
  await fillCreateForm(form);
  await submit(form);
  await settled();

  const post = calls.find((c) => c.method === 'post');
  assert.ok(post, 'submitting the form should POST');
  assert.equal(post.url, '/obligations');
  assert.deepEqual(post.body, {
    title: 'Insurance certificate',
    description: 'Proof of cover',
    contract: 'c1',
    assignedTo: 'u3',
    dueDate: '2026-11-30',
    status: 'Pending'
  });

  // The list is refetched so the row is server truth rather than local state.
  assert.ok(
    calls.filter((c) => c.method === 'get' && c.url === '/obligations').length >= 2,
    'the list should be refetched after a create'
  );
  assert.match(body().textContent, /Insurance certificate/);
  assert.match(body().textContent, /Obligation created/);
  assert.doesNotMatch(body().textContent, /Create obligation/, 'the modal should close on success');
});

test('a rejected create keeps the modal open and shows the reason', async () => {
  const { container, root } = await renderAs('Admin');
  mounted.push(root);

  await click(buttonsMatching(container, /New obligation/i)[0]);
  await settled();

  postFailsWith = { response: { data: { message: 'Cannot create obligations for an archived contract' } } };

  const form = body().querySelector('#obligation-form');
  await fillCreateForm(form);
  await submit(form);
  await settled();

  assert.match(body().textContent, /archived contract/);
  assert.match(body().textContent, /Create obligation/, 'the modal should stay open so the entry is not lost');
});

/* ------------------------------------------------------------------ *
 * An employee cannot create one
 * ------------------------------------------------------------------ */

test('an Employee is offered no create control at all', async () => {
  const { container, root } = await renderAs('Employee');
  mounted.push(root);

  assert.deepEqual(buttonsMatching(container, /New obligation/i), []);

  const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent.trim());
  assert.ok(
    !labels.some((label) => /new obligation|create|add/i.test(label)),
    `an Employee should see no create affordance, saw ${JSON.stringify(labels)}`
  );
  assert.equal(body().querySelector('#obligation-form'), null);
});

test('an Employee is told the list is scoped to their assignments', async () => {
  const { container, root } = await renderAs('Employee');
  mounted.push(root);

  assert.match(body().textContent, /No obligations assigned to you/);
});

test('an Employee cannot reach POST /obligations from the page', async () => {
  const { container, root } = await renderAs('Employee');
  mounted.push(root);

  assert.equal(calls.filter((c) => c.method === 'post').length, 0);
});
