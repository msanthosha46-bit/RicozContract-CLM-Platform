'use strict';

// Issue 17 - ApprovalRequests conflict handling.
//
// Issue 16 made the server decide a pending approval exactly once, returning
// HTTP 409 to the losing reviewer. This suite pins the client's side of that
// contract.
//
// The defect this proves (and the fix pins):
//
//   A 409 from the decision endpoint means the request is no longer pending -
//   another reviewer decided it, or the contract left 'Pending Approval'. The
//   losing reviewer's queue was left showing that request as 'Pending' with its
//   Approve/Reject controls still live, beside a banner saying it had already
//   been decided. The server was the authority; the queue did not re-read it.
//
// Same zero-install jsdom + Babel harness as issue39ActivityHistory.test.js,
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

const PAGE = path.join(SRC, 'pages', 'ApprovalRequests.js');

const request = (over = {}) => ({
  _id: 'ap1',
  status: 'Pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  requestedBy: { _id: 'u1', name: 'Rita Requester' },
  contract: { _id: 'c1', contractNumber: 'CT-001', title: 'Vendor MSA' },
  ...over
});

let rows = [];
let putBehavior = 'ok';
let putGate = null;
const calls = { get: 0, put: 0 };

const CONFLICT = { response: { status: 409, data: { message: 'This approval request has already been decided' } } };

const API = {
  async get(url) {
    calls.get += 1;
    if (url === '/approvals/pending') return { data: rows };
    return { data: [] };
  },
  async put(url, body) {
    calls.put += 1;
    if (putGate) await putGate;
    if (putBehavior === 'conflict') throw CONFLICT;
    if (putBehavior === 'error') throw { response: { status: 500, data: { message: 'Server exploded' } } };
    return { data: { ...body } };
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const settled = () => act(async () => {});

const render = async ({ initialRows = [] } = {}) => {
  calls.get = 0;
  calls.put = 0;
  rows = initialRows;
  putBehavior = 'ok';
  putGate = null;

  stub('services/api.js', { __esModule: true, default: API });

  delete require.cache[require.resolve(PAGE)];
  const ApprovalRequests = require(PAGE).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ApprovalRequests, null));
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
 * A successful decision is reflected in the queue
 * ------------------------------------------------------------------ */

test('an approval that succeeds leaves the queue reflecting the persisted state', async () => {
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  assert.match(body().textContent, /Vendor MSA/, 'the request is listed while pending');

  // The server no longer returns it once decided.
  rows = [];
  await click(buttonsMatching(container, /Approve/)[0]);
  await settled();

  assert.doesNotMatch(body().textContent, /Vendor MSA/, 'the decided request must leave the queue');
  assert.match(body().textContent, /No pending approvals/);
  assert.ok(calls.get >= 2, 'the queue is re-read after a decision');
});

test('a rejection that succeeds is reflected in the queue', async () => {
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  rows = [];
  await click(buttonsMatching(container, /Reject/)[0]);
  await settled();

  assert.doesNotMatch(body().textContent, /Vendor MSA/);
  assert.match(body().textContent, /No pending approvals/);
});

/* ------------------------------------------------------------------ *
 * Defect: a losing 409 must re-read the queue, not keep a stale row
 * ------------------------------------------------------------------ */

test('a 409 conflict re-reads the queue and does not keep showing the request as pending', async () => {
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  // Another reviewer wins the race: the decision is refused with 409 and the
  // server now returns an empty pending list.
  putBehavior = 'conflict';
  rows = [];
  const getBefore = calls.get;

  await click(buttonsMatching(container, /Approve/)[0]);
  await settled();

  assert.ok(calls.get > getBefore, 'a conflict must re-read the queue');
  assert.doesNotMatch(
    body().textContent,
    /Vendor MSA/,
    'the already-decided request must not linger in the queue as pending'
  );
  assert.match(
    body().textContent,
    /already been decided/i,
    'the reviewer must be told why the decision did not apply'
  );
  assert.equal(
    buttonsMatching(body(), /Approve/).length,
    0,
    'no live Approve control may remain on a request that is already decided'
  );
  assert.doesNotMatch(
    body().textContent,
    /could not be loaded/i,
    'a conflict is not a load failure; the queue did re-read successfully'
  );
});

test('a 409 conflict does not claim the queue was empty when it was never read', async () => {
  // The counter-case: the reload after a conflict can itself be empty and that
  // must read as "no pending approvals", never as "the list could not be
  // loaded" - the two are different facts.
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  putBehavior = 'conflict';
  rows = [];
  await click(buttonsMatching(container, /Approve/)[0]);
  await settled();

  assert.match(body().textContent, /No pending approvals/);
  assert.doesNotMatch(body().textContent, /could not be loaded/i);
  assert.doesNotMatch(body().textContent, /Vendor MSA/);
});

/* ------------------------------------------------------------------ *
 * Ordinary failures and duplicate clicks
 * ------------------------------------------------------------------ */

test('an ordinary failure reports the error and keeps the request visible', async () => {
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  putBehavior = 'error';
  await click(buttonsMatching(container, /Approve/)[0]);
  await settled();

  assert.match(body().textContent, /Server exploded/);
  assert.match(body().textContent, /Vendor MSA/, 'a failed decision leaves the request in the queue');
  assert.ok(buttonsMatching(body(), /Retry/).length >= 1, 'and offers a way back');
});

test('a duplicate click while a decision is in flight issues only one request', async () => {
  const { container, root } = await render({ initialRows: [request()] });
  mounted.push(root);

  let release;
  putGate = new Promise((resolve) => { release = resolve; });

  const approve = buttonsMatching(container, /Approve/)[0];
  await click(approve);
  // A second click lands before the first request settles.
  await click(buttonsMatching(container, /Approve/)[0]);
  await settled();

  assert.equal(calls.put, 1, 'the in-flight guard must swallow the second click');

  release();
  await settled();
  assert.ok(calls.get >= 2, 'the queue re-reads once the decision settles');
});
