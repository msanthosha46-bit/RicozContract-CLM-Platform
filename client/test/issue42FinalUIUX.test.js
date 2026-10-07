'use strict';

// Issue 42 - Final UI/UX consistency & polish.
//
// Four pages masked a failed first load as "there is nothing to show":
// ContractsList, ApprovalRequests, UserManagement and RenewalManagement all
// fell back to their empty state when the first GET failed, so the user saw
// "No contracts found" / "No pending approvals" / "No users yet" / "Nothing
// expiring soon" right beside an error banner, and only ContractsList and
// RenewalManagement offered a way to retry. The fix mirrors the Obligations
// guard (issue36): when the read failed the empty language is suppressed in
// favour of an explicit "could not be loaded" callout, and every page now
// offers Retry.
//
// Success paths must be untouched: a genuinely empty read still paints the
// real empty state, which the assertions below pin as the negative control.
//
// Same zero-install jsdom + Babel harness as issue33/issue36, with the axios
// instance and the router stubbed.

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

const ROOT = require.resolve('react-router-dom');

// A failing read, shaped like an axios 500 so the pages read
// `err.response.data.message` exactly as they would in the browser.
const httpError = (status, message) => ({
  response: { status, data: { message } }
});

const calls = [];
let failing = []; // [{ pattern, error }]
let contractsPayload = [];
let approvalsPayload = [];
let usersPayload = [];

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    for (const { pattern, error } of failing) {
      if (pattern.test(url)) throw error;
    }
    if (/\/contracts/.test(url)) return { data: { contracts: contractsPayload, total: contractsPayload.length, totalPages: 1 } };
    if (/\/approvals\/pending/.test(url)) return { data: approvalsPayload };
    if (/\/users/.test(url)) return { data: usersPayload };
    if (/\/renewals\/(expiring|history|renewable)/.test(url)) return { data: [] };
    return { data: [] };
  },
  async post() {
    return { data: {} };
  },
  async put() {
    return { data: {} };
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const stubRouter = () => {
  require.cache[ROOT] = {
    id: ROOT,
    filename: ROOT,
    loaded: true,
    exports: {
      __esModule: true,
      useParams: () => ({ id: 'c-1' }),
      useNavigate: () => () => {},
      useSearchParams: () => [new URLSearchParams(), () => {}],
      Link: ({ to, children, ...rest }) =>
        React.createElement('a', { href: to, ...rest }, children)
    },
    children: [],
    paths: []
  };
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const settled = () => act(async () => {});

// ContractsList debounces its search box by 350 ms and only fetches once the
// debounce has settled, so it needs real time to pass before it paints.
const flushDebounce = () => act(async () => {
  await new Promise((resolve) => { setTimeout(resolve, 450); });
});

const mounted = [];

const mount = async (pageRelPath, { role = 'Manager' } = {}) => {
  stubRouter();
  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role } })
  });

  delete require.cache[require.resolve(path.join(SRC, pageRelPath))];
  const Page = require(path.join(SRC, pageRelPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Page, null)); });
  await settled();
  if (pageRelPath.endsWith('ContractsList.js')) await flushDebounce();
  return container;
};

const text = (scope) => scope.textContent.replace(/\s+/g, ' ');

test.beforeEach(() => {
  calls.length = 0;
  failing = [];
  contractsPayload = [];
  approvalsPayload = [];
  usersPayload = [];
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  dom.window.document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ *
 * ContractsList: a failed first read must not read as an empty repo
 * ------------------------------------------------------------------ */

test('a failed first read of the contract list is reported, not shown as empty', async () => {
  failing = [{ pattern: /\/contracts/, error: httpError(500, 'Contract service down') }];

  const container = await mount('pages/ContractsList.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /Contract service down/);
  assert.match(text(container), /could not be loaded\. Use Retry above to try again/, 'the explicit failure callout is expected');
  assert.doesNotMatch(text(container), /No contracts found/, 'a failed read must not be reported as an empty repository');
  assert.ok(
    [...container.querySelectorAll('button')].some((b) => /Retry/.test(b.textContent)),
    'a failed read still needs a retry path'
  );
  assert.equal(container.querySelector('tbody'), null, 'no half-rendered table behind the error');
});

test('an empty but successful read of the contract list still shows the empty state', async () => {
  const container = await mount('pages/ContractsList.js');

  assert.match(text(container), /No contracts found/);
  assert.match(text(container), /Create your first contract/);
  assert.equal(container.querySelector('[role="alert"]'), null, 'no error banner on a clean read');
});

/* ------------------------------------------------------------------ *
 * ApprovalRequests: same failed-load guard, plus a recovered error
 * ------------------------------------------------------------------ */

test('a failed first read of the approval list is reported, not shown as empty', async () => {
  failing = [{ pattern: /\/approvals\/pending/, error: httpError(500, 'Approval service down') }];

  const container = await mount('pages/ApprovalRequests.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /Approval service down/);
  assert.match(text(container), /could not be loaded\. Use Retry above to try again/);
  assert.doesNotMatch(text(container), /No pending approvals/, 'a failed read must not be reported as an empty queue');
  assert.ok(
    [...container.querySelectorAll('button')].some((b) => /Retry/.test(b.textContent)),
    'the approval page also needs a retry path'
  );
  assert.equal(container.querySelector('tbody'), null, 'no table in the failed state');
});

test('an empty but successful read of the approval list still shows the empty state', async () => {
  const container = await mount('pages/ApprovalRequests.js');

  assert.match(text(container), /No pending approvals/);
});

test('a decision error keeps the loaded table on screen with the banner', async () => {
  approvalsPayload = [{
    _id: 'a1',
    contract: { _id: 'c1', title: 'Vendor MSA', contractNumber: 'CT-001' },
    requestedBy: { name: 'Mia Manager' },
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'Pending'
  }];
  const originalPut = API.put;
  API.put = async () => { throw httpError(409, 'Already decided'); };

  const container = await mount('pages/ApprovalRequests.js');

  const reject = container.querySelector('button[aria-label="Reject Vendor MSA"]');
  assert.ok(reject, 'the reject action exists for the pending row');
  await click(reject);
  await settled();

  assert.ok(container.querySelector('tbody'), 'the loaded rows stay visible');
  assert.match(text(container), /Already decided/, 'the decision failure is announced');
  assert.doesNotMatch(text(container), /No pending approvals/, 'an error must not revert the list to its empty state');

  API.put = originalPut;
});

/* ------------------------------------------------------------------ *
 * UserManagement: failed read must not read as "no users yet"
 * ------------------------------------------------------------------ */

test('a failed first read of the user list is reported, not shown as empty', async () => {
  failing = [{ pattern: /\/users/, error: httpError(500, 'Directory service down') }];

  const container = await mount('pages/UserManagement.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /Directory service down/);
  assert.match(text(container), /could not be loaded\. Use Retry above to try again/);
  assert.doesNotMatch(text(container), /No users yet/, 'a failed read must not be reported as an empty directory');
  assert.ok(
    [...container.querySelectorAll('button')].some((b) => /Retry/.test(b.textContent)),
    'the user page also needs a retry path'
  );
  assert.equal(container.querySelector('tbody'), null, 'no table in the failed state');
});

test('an empty but successful read of the user list still shows the empty state', async () => {
  const container = await mount('pages/UserManagement.js');

  assert.match(text(container), /No users yet/);
});

/* ------------------------------------------------------------------ *
 * RenewalManagement: one failed read must not read as three empty lists
 * ------------------------------------------------------------------ */

test('a failed first read hides all three renewal sections behind the failure', async () => {
  failing = [{ pattern: /\/renewals\//, error: httpError(500, 'Renewal service down') }];

  const container = await mount('pages/RenewalManagement.js');

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /Renewal service down/);
  assert.doesNotMatch(text(container), /Nothing expiring soon/, 'the expiring section must not claim to be empty');
  assert.doesNotMatch(text(container), /Nothing lapsed awaiting renewal/, 'the awaiting-renewal section must not claim to be empty');
  assert.doesNotMatch(text(container), /No renewals recorded yet/, 'the history section must not claim to be empty');
  assert.match(text(container), /The expiring contracts could not be loaded/);
  assert.match(text(container), /The renewable list could not be loaded/);
  assert.match(text(container), /The renewal history could not be loaded/);
  assert.equal(container.querySelector('tbody'), null, 'no tables in the failed state');
});

test('an empty but successful read still shows the three empty sections', async () => {
  const container = await mount('pages/RenewalManagement.js');

  assert.match(text(container), /Nothing expiring soon/);
  assert.match(text(container), /Nothing lapsed awaiting renewal/);
  assert.match(text(container), /No renewals recorded yet/);
});

/* ------------------------------------------------------------------ *
 * Settings: the preference toggles expose their row name
 * ------------------------------------------------------------------ */

test('every preference toggle is announced by its row label', async () => {
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({
      user: {
        _id: 'u1',
        name: 'Ada Admin',
        role: 'Admin',
        preferences: { emailNotifications: true, approvalReminders: true, expiryAlerts: false }
      },
      updateProfile: () => {}
    })
  });

  delete require.cache[require.resolve(path.join(SRC, 'pages/Settings.js'))];
  const Settings = require(path.join(SRC, 'pages/Settings.js')).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Settings, null)); });
  await settled();

  const toggles = [...container.querySelectorAll('button[aria-pressed]')];
  assert.equal(toggles.length, 3, 'three preference toggles are expected');

  const labels = ['Email notifications', 'Approval reminders', 'Contract expiry alerts'];
  for (const label of labels) {
    const toggle = toggles.find((b) => b.getAttribute('aria-label') === label);
    assert.ok(toggle, `toggle for "${label}" has no aria-label and is indistinguishable to a screen reader`);
    assert.equal(toggle.textContent.trim(), toggle.getAttribute('aria-pressed') === 'true' ? 'Enabled' : 'Disabled');
  }
});