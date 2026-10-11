'use strict';

// Issue 19 - the User management role/status update workflow.
//
// The page renders one controlled <select> per row for Role and one for Status.
// Changing either fires `updateUser(id, field, value)`, which PUTs
// `/users/:id/role`, and on success re-reads `/users` so the select shows the
// persisted value. This suite pins the end-to-end contract between the control,
// the API call and the persisted state:
//
//   - a successful change re-reads the list and shows the persisted role;
//   - a rejected change (the server refuses to demote the last active admin)
//     announces the error, does NOT claim success, and the control must fall
//     back to the persisted role rather than keeping the refused one on screen;
//   - an API failure does not corrupt the other rows or the load state.
//
// Same zero-install jsdom + Babel harness as issue42FinalUIUX.test.js, with a
// stateful API stub so a re-read after a PUT returns the new state.

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

const httpError = (status, message) => ({ response: { status, data: { message } } });

let rows = [];
let listError = null;
let putHandler = null;
const calls = { get: 0, put: [] };

const applyLocalRoleChange = (id, field, value) => {
  rows = rows.map((u) => (u._id === id ? { ...u, [field]: value } : u));
};

const API = {
  async get(url) {
    calls.get += 1;
    if (listError) throw listError;
    if (/\/users/.test(url)) return { data: rows };
    return { data: [] };
  },
  async put(url, body) {
    calls.put.push({ url, body });
    if (putHandler) return putHandler(url, body);
    return { data: { message: 'User updated successfully' } };
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const setValue = (element, value) => {
  const proto = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype
    : element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  element.dispatchEvent(
    new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })
  );
};

const settled = () => act(async () => {});

const mounted = [];

const mount = async () => {
  stub('services/api.js', { __esModule: true, default: API });
  delete require.cache[require.resolve(path.join(SRC, 'pages', 'UserManagement.js'))];
  const UserManagement = require(path.join(SRC, 'pages', 'UserManagement.js')).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => { root.render(React.createElement(UserManagement, null)); });
  await settled();
  return container;
};

const text = (scope) => scope.textContent.replace(/\s+/g, ' ');

const roleSelectFor = (container, name) =>
  container.querySelector(`select[aria-label="Role for ${name}"]`);
const statusSelectFor = (container, name) =>
  container.querySelector(`select[aria-label="Status for ${name}"]`);

const alert = (container) => container.querySelector('[role="alert"]');
const status = (container) => container.querySelector('[role="status"]');

const changeSelect = async (select, value) => {
  await act(async () => { setValue(select, value); });
  await settled();
};

const PEOPLE = () => ([
  { _id: 'u-admin', name: 'Ada Admin', email: 'ada@ricoz.test', role: 'Admin', status: 'Active', department: 'Legal' },
  { _id: 'u-bob', name: 'Bob Employee', email: 'bob@ricoz.test', role: 'Employee', status: 'Active', department: 'Ops' }
]);

test.beforeEach(() => {
  rows = PEOPLE();
  listError = null;
  putHandler = null;
  calls.get = 0;
  calls.put.length = 0;
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ *
 * A successful change is sent, re-read, and shown
 * ------------------------------------------------------------------ */

test('a successful role change is persisted and reflected in the control', async () => {
  putHandler = (url, body) => {
    const id = url.split('/')[2];
    applyLocalRoleChange(id, 'role', body.role);
    return { data: { message: 'User updated successfully' } };
  };

  const container = await mount();
  assert.equal(roleSelectFor(container, 'Bob Employee').value, 'Employee', 'starts on the persisted role');

  await changeSelect(roleSelectFor(container, 'Bob Employee'), 'Manager');

  assert.deepEqual(calls.put, [{ url: '/users/u-bob/role', body: { role: 'Manager' } }],
    'the change must PUT the role to the user endpoint');
  assert.equal(roleSelectFor(container, 'Bob Employee').value, 'Manager', 'the control shows the persisted role');
  assert.ok(status(container), 'a success confirmation is shown');
  assert.match(text(status(container)), /User updated/);
  assert.equal(alert(container), null, 'a clean change shows no error banner');
});

test('a successful status change is persisted and reflected in the control', async () => {
  putHandler = (url, body) => {
    const id = url.split('/')[2];
    applyLocalRoleChange(id, 'status', body.status);
    return { data: { message: 'User updated successfully' } };
  };

  const container = await mount();
  await changeSelect(statusSelectFor(container, 'Bob Employee'), 'Inactive');

  assert.deepEqual(calls.put, [{ url: '/users/u-bob/role', body: { status: 'Inactive' } }]);
  assert.equal(statusSelectFor(container, 'Bob Employee').value, 'Inactive');
});

/* ------------------------------------------------------------------ *
 * A rejected change must not look like it succeeded
 * ------------------------------------------------------------------ */

test('a rejected role change is announced and the control reverts to the persisted role', async () => {
  putHandler = () => { throw httpError(400, 'Cannot demote or deactivate the only active administrator'); };

  const container = await mount();
  const select = roleSelectFor(container, 'Ada Admin');
  assert.equal(select.value, 'Admin');

  await changeSelect(select, 'Employee');

  assert.match(text(alert(container)), /only active administrator/, 'the refusal must be explained');
  assert.equal(status(container), null, 'a refused change must not claim success');
  assert.equal(select.value, 'Admin',
    'the control must fall back to the persisted role, not keep the refused one on screen');
});

test('a rejected update leaves the other rows intact', async () => {
  putHandler = () => { throw httpError(500, 'Directory service down'); };

  const container = await mount();
  await changeSelect(roleSelectFor(container, 'Bob Employee'), 'Admin');

  assert.equal(roleSelectFor(container, 'Ada Admin').value, 'Admin');
  assert.equal(roleSelectFor(container, 'Bob Employee').value, 'Employee', 'the refused row keeps its value');
  assert.match(text(alert(container)), /Directory service down/);
});

test('an update for a user that no longer exists reports the server message', async () => {
  putHandler = () => { throw httpError(404, 'User not found'); };

  const container = await mount();
  await changeSelect(roleSelectFor(container, 'Bob Employee'), 'Manager');

  assert.match(text(alert(container)), /User not found/);
  assert.equal(status(container), null, 'no success confirmation for a rejected update');
});

/* ------------------------------------------------------------------ *
 * Records with missing or unrecognised role information
 * ------------------------------------------------------------------ */

test('a record with a missing role is shown on a safe default, never blank or Admin', async () => {
  rows = [
    { _id: 'u-legacy', name: 'Legacy User', email: 'legacy@ricoz.test', role: null, status: null, department: 'Ops' }
  ];

  const container = await mount();
  const role = roleSelectFor(container, 'Legacy User');

  assert.notEqual(role.selectedIndex, -1, 'the role control must not be a blank selection');
  assert.equal(role.value, 'Employee', 'a missing role falls back to the schema default');
  assert.notEqual(role.value, 'Admin', 'a missing role must never be shown as an elevated role');
  assert.equal(statusSelectFor(container, 'Legacy User').value, 'Active',
    'the existing status fallback is unchanged');
});

test('a record with an unrecognised role does not render a blank or elevated option', async () => {
  rows = [
    { _id: 'u-odd', name: 'Odd User', email: 'odd@ricoz.test', role: 'SuperAdmin', status: 'Active', department: 'Ops' }
  ];

  const container = await mount();
  const role = roleSelectFor(container, 'Odd User');

  assert.notEqual(role.selectedIndex, -1, 'an unmatched value must not leave the control blank');
  assert.equal(role.value, 'Employee', 'an unmapped role falls back to the safe default');
  assert.notEqual(role.value, 'Admin', 'an unmapped role must not be shown as an elevated role');
});

/* ------------------------------------------------------------------ *
 * Load behaviour is unchanged by the update path
 * ------------------------------------------------------------------ */

test('a failed list read is reported with a retry path and never as "No users yet"', async () => {
  listError = httpError(500, 'Directory service down');

  const container = await mount();

  assert.match(text(alert(container)), /Directory service down/);
  assert.match(text(container), /could not be loaded/);
  assert.doesNotMatch(text(container), /No users yet/);
  assert.ok([...container.querySelectorAll('button')].some((b) => /Retry/.test(b.textContent)));
});
