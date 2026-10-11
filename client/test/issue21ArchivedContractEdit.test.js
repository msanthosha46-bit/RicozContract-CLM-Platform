'use strict';

// Issue 21 - Archived-contract editing restrictions (client side).
//
// The reported mismatch: the Obligations and Milestones pages render an Edit
// action for every manage-capable user, regardless of whether the item's
// contract is archived. But the server freezes all detail fields on an archived
// contract (server/utils/itemUpdate.js DETAIL_FIELDS check) - and the edit form
// always submits `title` (plus description, contract, assignee and due date), so
// every save from that form is rejected with 400 "Details of ... on an archived
// contract cannot be edited". The Edit button therefore promises an operation
// that can never succeed.
//
// The rest of the app already answers this the same way: ContractDetails.js
// hides the Archive action behind `!contract.isArchived`, and the amendments
// helpers refuse work on archived contracts. The list endpoints even populate
// `contract.isArchived` precisely so a row can decide this for itself. This
// suite pins that the two work-item pages reuse that pattern: no Edit for items
// on archived contracts, the read-only View stays, and the status quick actions
// (the one mutation the server still permits on an archived contract) survive.
//
// Same zero-install jsdom + Babel harness as the other client workflow suites.

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

const CONTRACT = { _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' };
const ARCHIVED_CONTRACT = { _id: 'c2', contractNumber: 'CT-002', title: 'Archived deal', isArchived: true };
const PEOPLE = [{ _id: 'u1', name: 'Ada Admin' }];

let rows = [];

const API = {
  async get(url) {
    if (url === '/obligations' || url === '/milestones') return { data: rows };
    if (url.startsWith('/contracts')) return { data: [CONTRACT, ARCHIVED_CONTRACT] };
    if (url === '/users/directory') return { data: PEOPLE };
    return { data: [] };
  },
  async post() { return { data: {} }; },
  async put() { return { data: {} }; }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const mount = async (pageFile, listPath, nextRows, role = 'Manager') => {
  rows = nextRows;
  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role } })
  });

  const pagePath = path.join(SRC, pageFile);
  delete require.cache[require.resolve(pagePath)];
  const Page = require(pagePath).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Page, null)); });
  await settled();
  mounted.push(root);
  return container;
};

const PAGES = [
  {
    name: 'Obligations', file: 'pages/Obligations.js', listPath: '/obligations',
    row: (over = {}) => ({
      _id: 'w1', title: 'Work item', description: '', contract: CONTRACT,
      assignedTo: PEOPLE[0], dueDate: '2026-11-30T00:00:00.000Z', status: 'Pending', ...over
    })
  },
  {
    name: 'Milestones', file: 'pages/Milestones.js', listPath: '/milestones',
    row: (over = {}) => ({
      _id: 'w1', title: 'Work item', description: '', contract: CONTRACT,
      assignedTo: PEOPLE[0], dueDate: '2026-11-30T00:00:00.000Z', status: 'Pending', ...over
    })
  }
];

const mounted = [];

const editButton = (container, title) => container.querySelector(`button[aria-label="Edit ${title}"]`);
const viewButton = (container, title) => container.querySelector(`button[aria-label="View ${title}"]`);
const rowActions = (container) => {
  const row = container.querySelector('tbody tr');
  return Array.from(row.querySelectorAll('button')).map((b) => b.textContent.trim());
};

test.beforeEach(() => {
  dom.window.document.body.innerHTML = '';
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

for (const page of PAGES) {
  test(`${page.name}: an item on an archived contract offers no Edit action`, async () => {
    const container = await mount(page.file, page.listPath, [
      page.row({ title: 'Frozen thing', contract: ARCHIVED_CONTRACT })
    ]);

    assert.match(container.textContent, /Frozen thing/, 'the row is still shown read-only');
    assert.ok(viewButton(container, 'Frozen thing'), 'the read-only View stays available');
    assert.equal(
      editButton(container, 'Frozen thing'),
      null,
      'no Edit promise for an item whose contract is archived; every save would be a 400'
    );
    assert.equal(container.querySelector('#obligation-edit-form, #milestone-edit-form'), null);
  });

  test(`${page.name}: an item on an active contract still offers Edit`, async () => {
    const container = await mount(page.file, page.listPath, [
      page.row({ title: 'Editable thing', contract: CONTRACT })
    ]);

    assert.ok(
      editButton(container, 'Editable thing'),
      'a non-archived item must stay editable - the fix must not remove the ordinary action'
    );
  });

  test(`${page.name}: the status quick actions survive on an archived contract`, async () => {
    const container = await mount(page.file, page.listPath, [
      page.row({ title: 'Frozen thing', contract: ARCHIVED_CONTRACT, status: 'Pending' })
    ]);

    // Pending may be started or completed; the server still permits status-only
    // progress on an archived contract, so hiding Edit must not hide these too.
    const actions = rowActions(container);
    assert.ok(actions.includes('Start'), `Start must remain for archived work, saw ${JSON.stringify(actions)}`);
    assert.ok(actions.includes('Complete'), `Complete must remain for archived work, saw ${JSON.stringify(actions)}`);
    assert.ok(!actions.includes('Edit'), 'only Edit is withdrawn');
  });

  test(`${page.name}: an Employee sees no Edit control either way`, async () => {
    const container = await mount(page.file, page.listPath, [
      page.row({ title: 'Mine', assignedTo: { _id: 'u1', name: 'Probe' } })
    ], 'Employee');

    assert.equal(container.querySelectorAll('button[aria-label^="Edit "]').length, 0);
  });
}
