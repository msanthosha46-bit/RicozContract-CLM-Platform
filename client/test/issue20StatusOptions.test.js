'use strict';

// Issue 20 - Obligations & Milestones update workflow consistency (client side).
//
// One genuine defect found by the audit, on both pages:
//
//   The edit form's status <select> built its options from `editForm.status` -
//   the *live* form value - instead of the work item's persisted status. Because
//   `statusOptionsFor` returns "[current] plus everything current may become",
//   the option set was recomputed the moment the user changed the selection. A
//   Completed item initially offers [Pending, In Progress, Completed] (the server
//   forbids Completed -> Overdue), but as soon as the user picked "In Progress"
//   the dropdown recomputed for In Progress and offered "Overdue" as well. Saving
//   that choice sent `status: 'Overdue'` for an item whose stored status was still
//   Completed, and the server rejected it with 400 - a false affordance the user
//   could not have predicted, offered by the very control that teaches the
//   transition rules.
//
//   The fix bases the options on `editTarget?.status`, the item as loaded, so the
//   offered set is stable and exactly the transitions the server will accept.
//
// The rest of the file pins the option contract for every status so a future
// change to the shared helper or the two pages cannot quietly reopen the gap.
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

const CONTRACTS = [{ _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' }];
const PEOPLE = [{ _id: 'u1', name: 'Ada Admin' }];

const API = {
  async get(url) {
    if (url === '/obligations' || url === '/milestones') return { data: rows };
    if (url.startsWith('/contracts')) return { data: CONTRACTS };
    if (url === '/users/directory') return { data: PEOPLE };
    return { data: [] };
  },
  async post() { return { data: {} }; },
  async put(url, body) { return { data: body }; }
};

let rows = [];

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const setSelect = (element, value) => act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
});

const optionLabels = (select) => Array.from(select.options).map((o) => o.textContent);
const statusSelectIn = (form) => form.querySelectorAll('select')[2];

// The two pages are the same workflow under two names; every case below runs
// against both so neither can regress on its own.
const PAGES = [
  {
    name: 'Obligations',
    file: 'pages/Obligations.js',
    listPath: '/obligations',
    formId: 'obligation-edit-form',
    row: (over = {}) => ({
      _id: 'w1', title: 'Done thing', description: '', contract: CONTRACTS[0],
      assignedTo: PEOPLE[0], dueDate: '2026-11-30T00:00:00.000Z', status: 'Completed', ...over
    })
  },
  {
    name: 'Milestones',
    file: 'pages/Milestones.js',
    listPath: '/milestones',
    formId: 'milestone-edit-form',
    row: (over = {}) => ({
      _id: 'w1', title: 'Done thing', description: '', contract: CONTRACTS[0],
      assignedTo: PEOPLE[0], dueDate: '2026-11-30T00:00:00.000Z', status: 'Completed', ...over
    })
  }
];

const mounted = [];

const openEdit = async (page, item) => {
  rows = [item];
  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role: 'Manager' } })
  });

  const pagePath = path.join(SRC, page.file);
  delete require.cache[require.resolve(pagePath)];
  const Page = require(pagePath).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Page, null)); });
  await settled();
  mounted.push(root);

  const editButton = container.querySelector(`button[aria-label="Edit ${item.title}"]`);
  assert.ok(editButton, `${page.name}: the edit control should render for a completed item`);
  await click(editButton);
  await settled();

  const form = dom.window.document.body.querySelector(`#${page.formId}`);
  assert.ok(form, `${page.name}: the edit form should open`);
  return { container, form };
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
  test(`${page.name}: a completed item never offers Overdue, even after picking In Progress`, async () => {
    const { form } = await openEdit(page, page.row({ status: 'Completed' }));
    const status = statusSelectIn(form);

    assert.deepEqual(
      optionLabels(status),
      ['Pending', 'In Progress', 'Completed'],
      `${page.name}: Completed must not offer Overdue on open (the server forbids it)`
    );

    await setSelect(status, 'In Progress');

    assert.deepEqual(
      optionLabels(statusSelectIn(form)),
      ['Pending', 'In Progress', 'Completed'],
      `${page.name}: the option set must not drift with the live selection`
    );
    assert.ok(
      !optionLabels(statusSelectIn(form)).includes('Overdue'),
      `${page.name}: Overdue would be a 400 waiting to happen`
    );
  });

  test(`${page.name}: the option set is recomputed from the item, not the form`, async () => {
    const { form } = await openEdit(page, page.row({ status: 'Pending' }));
    const status = statusSelectIn(form);

    // Pending may legitimately become any of the other three.
    assert.deepEqual(optionLabels(status), ['Pending', 'In Progress', 'Completed', 'Overdue']);

    // Choosing Completed must not shrink the set to Completed's own reachable
    // states, because the item on the server is still Pending.
    await setSelect(status, 'Completed');
    assert.deepEqual(
      optionLabels(statusSelectIn(form)),
      ['Pending', 'In Progress', 'Completed', 'Overdue'],
      `${page.name}: the item is still Pending; its transition set must not be replaced by the picked value's`
    );
  });

  test(`${page.name}: an overdue item keeps every legal landing spot`, async () => {
    const { form } = await openEdit(page, page.row({ status: 'Overdue' }));
    const status = statusSelectIn(form);

    assert.deepEqual(
      optionLabels(status),
      ['Pending', 'In Progress', 'Completed', 'Overdue'],
      `${page.name}: Overdue may go anywhere except back to Overdue (which is a no-op value, kept)`
    );

    await setSelect(status, 'Pending');
    assert.deepEqual(
      optionLabels(statusSelectIn(form)),
      ['Pending', 'In Progress', 'Completed', 'Overdue'],
      `${page.name}: switching to Pending must not hide Overdue`
    );
  });
}
