'use strict';

// Issue 39 - Activity History / ActivityLog regressions.
//
// One genuine defect found by the audit:
//
//  1. A failed GET /activities was reported twice at once: the alert banner said
//     the load failed *and* the list area said "No activity recorded yet",
//     because both a failed read and a genuinely empty list leave `activities`
//     empty and the render only looked at its length. This is the exact defect
//     Issues 35/36/37 fixed on Documents, Obligations and Milestones and left
//     unfixed here - the same branch, the same lie. It tells an Admin or
//     Manager that the governance history is empty when it may be full on the
//     server, and it offered no way to try again.
//
// The rest of this file pins the activity log read so a later refactor cannot
// quietly bring the contradiction back.
//
// Same zero-install jsdom + Babel harness as issue37MilestoneWorkflow.test.js,
// with the axios instance stubbed.

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

const PAGE = path.join(SRC, 'pages', 'ActivityLog.js');

const activity = (over = {}) => ({
  _id: 'a1',
  action: 'Contract Created',
  details: 'Created contract CT-001',
  user: { _id: 'u1', name: 'Ada Admin' },
  contract: { _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' },
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over
});

const calls = [];

let rows = [];
let listFailsWith = null;

const API = {
  async get(url) {
    calls.push({ method: 'get', url });
    if (url === '/activities') {
      if (listFailsWith) throw listFailsWith;
      return { data: rows };
    }
    return { data: [] };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    return { data: body };
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

const render = async ({ initialRows = [], listError = null } = {}) => {
  calls.length = 0;
  rows = initialRows;
  listFailsWith = listError;

  stub('services/api.js', { __esModule: true, default: API });

  delete require.cache[require.resolve(PAGE)];
  const ActivityLog = require(PAGE).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ActivityLog, null));
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
 * Defect 1: a failed load must not also claim the log is empty
 * ------------------------------------------------------------------ */

test('a failed first load reports the failure and never says nothing was ever recorded', async () => {
  const { container, root } = await render({
    initialRows: [],
    listError: { response: { data: { message: 'Unable to reach the activity service' } } }
  });
  mounted.push(root);

  assert.match(body().textContent, /Unable to reach the activity service/, 'the reason should be shown');
  assert.doesNotMatch(
    body().textContent,
    /No activity recorded yet/,
    'a failed read must not be reported as an empty log'
  );
  assert.doesNotMatch(
    body().textContent,
    /Contract and lifecycle actions across the workspace are logged here as they happen/,
    'the empty state would tell the user nothing has happened when the read never succeeded'
  );
  assert.equal(
    container.querySelector('[role="status"]'),
    null,
    'the loader is finished; the failure is not a loading state'
  );
});

test('a failed first load offers a way back', async () => {
  const { root } = await render({
    initialRows: [],
    listError: { response: { data: { message: 'boom' } } }
  });
  mounted.push(root);

  assert.ok(buttonsMatching(body(), /Retry/i).length >= 1, 'the user needs a recovery path');
});

test('a failed load with no server message still does not become an empty state', async () => {
  const { root } = await render({ initialRows: [], listError: new Error('Network Error') });
  mounted.push(root);

  assert.match(body().textContent, /Unable to load activity history/);
  assert.doesNotMatch(body().textContent, /No activity recorded yet/);
});

test('a genuinely empty successful read still shows the empty state', async () => {
  const { root } = await render({ initialRows: [] });
  mounted.push(root);

  assert.match(
    body().textContent,
    /No activity recorded yet/,
    'the empty state is correct once the list really did load empty'
  );
  assert.doesNotMatch(body().textContent, /could not be loaded/, 'a successful read is not a failure');
});

test('a successful read renders the entries and their actor', async () => {
  const { root } = await render({
    initialRows: [
      activity(),
      activity({ _id: 'a2', action: 'Contract Archived', details: 'Archived contract CT-002', contract: null }),
      activity({ _id: 'a3', action: 'Contract Expired', details: 'Contract CT-003 expired', user: null })
    ]
  });
  mounted.push(root);

  assert.match(body().textContent, /Contract Created/);
  assert.match(body().textContent, /Contract Archived/);
  assert.match(body().textContent, /Ada Admin/, 'the actor must be named');
  assert.match(body().textContent, /CT-001/, 'the contract reference must be shown');
  assert.match(body().textContent, /System/, 'a system-authored entry names itself');
  assert.doesNotMatch(body().textContent, /undefined/);
  assert.doesNotMatch(body().textContent, /No activity recorded yet/);
});

test('a retry that fails again still never reports an empty log', async () => {
  const { container, root } = await render({
    initialRows: [],
    listError: { response: { data: { message: 'Temporary failure' } } }
  });
  mounted.push(root);

  assert.match(body().textContent, /Temporary failure/);

  await click(buttonsMatching(container, /Retry/i)[0]);
  await settled();

  assert.match(body().textContent, /Temporary failure/, 'the failure is still reported');
  assert.ok(buttonsMatching(body(), /Retry/i).length >= 1, 'and a way back is still offered');
  assert.doesNotMatch(
    body().textContent,
    /No activity recorded yet/,
    'a second failure must not turn the log into an empty state either'
  );
});

test('a retry that succeeds clears the previous failure', async () => {
  const { container, root } = await render({
    initialRows: [],
    listError: { response: { data: { message: 'Temporary failure' } } }
  });
  mounted.push(root);

  assert.match(body().textContent, /Temporary failure/);

  listFailsWith = null;
  rows = [activity({ details: 'Recovered row' })];
  await click(buttonsMatching(container, /Retry/i)[0]);
  await settled();

  assert.doesNotMatch(body().textContent, /Temporary failure/, 'a stale error must not linger');
  assert.match(body().textContent, /Recovered row/);
  assert.doesNotMatch(body().textContent, /No activity recorded yet/);
});
