'use strict';

// Regression guard for the Contract Details Archive action.
//
// The defect this exists for: the server ships a complete archive pipeline -
// `PATCH /contracts/:id/archive` (Admin-only, activity logged) plus an
// archived-contract freeze enforced across edits, documents, obligations,
// milestones, renewals, approvals and amendments - and the client even carries
// the wiring for it (`handleArchive`, `archiveOpen`, `archiving`, `isAdmin`,
// and a `Modal` import). But none of it is ever surfaced: no Archive control
// is rendered, so an administrator cannot archive a contract from the UI at
// all. The handler logic is identical to the dead `save()` handler this suite
// already catches for Settings; Archive was finished on the server and never
// connected on the client.
//
// Same zero-install harness as controls.test.js / issue33ContractDetail.test.js:
// jsdom plus the Babel require hook, the real page mounted under stubbed
// API, AuthContext and router.

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

const CONTRACT = {
  _id: 'c-1',
  contractNumber: 'CNT-2027-0001',
  title: 'Master services agreement',
  type: 'Vendor',
  partyName: 'Northwind Logistics',
  description: 'Warehouse and freight services for the EU region.',
  startDate: '2027-06-01T00:00:00.000Z',
  endDate: '2027-06-30T00:00:00.000Z',
  amount: 250000,
  currency: 'USD',
  status: 'Active',
  isArchived: false,
  createdBy: { _id: 'u-1', name: 'Ada Admin' },
  assignedUser: { _id: 'u-2', name: 'Mia Manager' },
  createdAt: '2027-01-05T09:30:00.000Z',
  updatedAt: '2027-02-06T14:05:00.000Z'
};

const DOCUMENT = {
  _id: 'd-1',
  contract: 'c-1',
  originalname: 'signed-msa.pdf',
  fileSize: 153600,
  version: 2,
  createdAt: '2027-02-01T11:00:00.000Z',
  uploadedBy: { _id: 'u-1', name: 'Ada Admin' }
};

let contractResponse = CONTRACT;
let documentsResponse = [DOCUMENT];
let amendmentsResponse = [];
let failure = null;
let routeId = 'c-1';
const calls = { get: [], patch: [] };
let navigated = [];

const API = {
  async get(url, config = {}) {
    calls.get.push({ url, params: config.params || {} });
    if (failure) throw failure;
    if (url.startsWith('/documents/contract/')) return { data: documentsResponse };
    if (url.startsWith('/contract-amendments')) return { data: amendmentsResponse };
    if (url.startsWith('/contracts/')) return { data: contractResponse };
    return { data: [] };
  },
  async patch(url) {
    calls.patch.push(url);
    return { data: { message: 'Contract archived successfully' } };
  },
  async post() { throw new Error('not used'); },
  async put() { throw new Error('not used'); },
  async delete() { throw new Error('not used'); }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const stubPackage = (name, exports) => {
  const filename = require.resolve(name, { paths: [SRC] });
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const mounted = [];

const mountPage = async (pageRelPath, { role = 'Admin' } = {}) => {
  calls.get.length = 0;
  calls.patch.length = 0;
  navigated = [];

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u-1', name: 'Ada Admin', role } })
  });
  stubPackage('react-router-dom', {
    __esModule: true,
    useParams: () => ({ id: routeId }),
    useNavigate: () => (to) => { navigated.push(to); },
    useSearchParams: () => [new URLSearchParams(''), () => {}],
    Link: ({ to, children, ...rest }) =>
      React.createElement('a', { href: to, ...rest }, children)
  });

  delete require.cache[require.resolve(path.join(SRC, pageRelPath))];
  const Page = require(path.join(SRC, pageRelPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Page, null)); });
  return container;
};

test.beforeEach(() => {
  calls.get.length = 0;
  calls.patch.length = 0;
  navigated = [];
  routeId = 'c-1';
  failure = null;
  contractResponse = CONTRACT;
  documentsResponse = [DOCUMENT];
  amendmentsResponse = [];
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

const archiveTrigger = (container) => container.querySelector('button[aria-label="Archive contract"]');

test('an administrator is offered the Archive action', async () => {
  const container = await mountPage('pages/ContractDetails.js', { role: 'Admin' });
  assert.ok(archiveTrigger(container), 'an Admin must be able to archive a contract from the details page');
});

test('a non-administrator is never offered the Archive action', async () => {
  for (const role of ['Manager', 'Employee']) {
    const container = await mountPage('pages/ContractDetails.js', { role });
    assert.equal(archiveTrigger(container), null, `role ${role} must not see the Admin-only Archive action`);
  }
});

test('an archived contract offers no Archive action even to an administrator', async () => {
  contractResponse = { ...CONTRACT, isArchived: true };
  const container = await mountPage('pages/ContractDetails.js', { role: 'Admin' });
  assert.equal(archiveTrigger(container), null, 'an already-archived contract must not promise a second archive');
});

test('confirming the Archive dialog calls the server and navigates back to the list', async () => {
  const container = await mountPage('pages/ContractDetails.js', { role: 'Admin' });

  const trigger = archiveTrigger(container);
  assert.ok(trigger, 'the Archive action must be present for this Admin');

  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  // The action must not fire until the confirmation is given.
  assert.deepEqual(calls.patch, [], 'opening the dialog must not archive anything yet');

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, 'the Archive action must open a confirmation dialog');
  assert.match(dialog.textContent, /Archive/, 'the dialog must state what it is about');
  assert.ok(dialog.querySelector('h3'), 'the dialog carries a title');

  const confirm = [...dialog.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === 'Archive contract'
  );
  assert.ok(confirm, 'the dialog must offer a confirm action');

  await act(async () => {
    confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  assert.deepEqual(calls.patch, ['/contracts/c-1/archive'],
    'confirming must send the archive request for the contract in the route');
  assert.deepEqual(navigated, ['/contracts'],
    'a successful archive must return the user to the contract list');
});