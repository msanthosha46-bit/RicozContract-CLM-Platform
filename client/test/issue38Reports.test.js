'use strict';

// Issue-38 regression tests for the Reports page render (client).
//
// These promote the render assertions that previously lived only in the
// untracked probe client/test/probe38render.js into the committed suite. They
// pin genuine render behaviour that the source-string guards in
// dashboardReports.test.js cannot: a failed read is never rendered as an empty
// repository, a cold failure offers a retry that recovers, a failed refresh
// keeps the last good figures, an in-flight refresh does not blank the page,
// and a malformed payload fails closed.
//
// Same zero-install harness as reportsCopy.test.js: jsdom plus the Babel
// require hook, the real page mounted under a stubbed API and router.

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
]) expose(name, dom.window[name]);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loadJavaScript = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(SRC + path.sep)) return loadJavaScript(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }]
    ]
  });
  return module._compile(code, filename);
};

// Controllable API stub: every GET resolves from `nextOutcome`, or parks on
// `gate` when a request must be held in flight.
let nextOutcome = { ok: true, data: null };
let gate = null;

const makeError = (message) => {
  const error = new Error(message);
  error.response = { data: { message } };
  return error;
};

const apiModule = path.join(SRC, 'services', 'api.js');
require.cache[apiModule] = {
  id: apiModule, filename: apiModule, loaded: true,
  exports: {
    __esModule: true,
    default: {
      get: () => {
        if (gate) return gate.promise;
        const outcome = nextOutcome;
        if (!outcome.ok) return Promise.reject(makeError(outcome.message));
        return Promise.resolve({ data: JSON.parse(JSON.stringify(outcome.data)) });
      }
    }
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const routerPath = require.resolve('react-router-dom');
require.cache[routerPath] = {
  id: routerPath, filename: routerPath, loaded: true,
  exports: {
    Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children)
  }
};

const PAGE = path.join(SRC, 'pages', 'Reports.js');
const loadedPage = require(PAGE);
const Reports = loadedPage.default || loadedPage;

const GOOD = {
  metrics: {
    total: 12, draft: 1, pending: 2, active: 5, expiringSoon: 3,
    expired: 1, completed: 0, overdueObligations: 4, overdueMilestones: 2, renewals: 7
  },
  statusBreakdown: [
    { _id: 'Draft', count: 1 },
    { _id: 'Pending Approval', count: 2 },
    { _id: 'Active', count: 5 },
    { _id: 'Expired', count: 1 },
    { _id: 'Closed', count: 3 }
  ],
  typeBreakdown: [{ _id: 'Vendor', count: 12 }]
};

const EMPTY = {
  metrics: { total: 0, draft: 0, pending: 0, active: 0, expiringSoon: 0, expired: 0, completed: 0, overdueObligations: 0, overdueMilestones: 0, renewals: 0 },
  statusBreakdown: [], typeBreakdown: []
};

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
};

const render = async () => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Reports)); });
  return { container, root };
};

const click = async (element) => {
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
};

const button = (container, re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));

const teardown = async (root) => {
  await act(async () => { root.unmount(); });
  dom.window.document.body.innerHTML = '';
  gate = null;
};

test('a request in flight shows the loading skeleton, not zeroes', async () => {
  nextOutcome = { ok: true, data: GOOD };
  gate = deferred();
  const { container, root } = await render();
  try {
    assert.ok(container.querySelector('[role="status"]'), 'no loading status region');
    assert.ok(!/Total Contracts/.test(container.textContent), 'cards rendered before the request settled');
    gate.resolve({ data: JSON.parse(JSON.stringify(GOOD)) });
    gate = null;
    await flush();
    assert.match(container.textContent, /Total Contracts/, 'the page never left the skeleton');
  } finally {
    await teardown(root);
  }
});

test('loaded page renders the metric cards and their subtotals', async () => {
  nextOutcome = { ok: true, data: GOOD };
  const { container, root } = await render();
  try {
    await flush();
    const text = container.textContent;
    assert.match(text, /Reports & analytics/);
    for (const label of ['Total Contracts', 'Active Contracts', 'Pending Approvals', 'Expiring Soon', 'Overdue Items', 'Renewals']) {
      assert.ok(text.includes(label), `missing card: ${label}`);
    }
    assert.ok(text.includes('12'), 'total missing');
    assert.ok(text.includes('6'), 'overdue total (4+2) missing');
    assert.ok(text.includes('12 contracts'), 'breakdown subtotal missing');
    assert.ok(text.includes('4 obligations · 2 milestones'), 'overdue detail missing');
  } finally {
    await teardown(root);
  }
});

test('a cold failure shows the error banner and "Reports unavailable", not "No analytics yet"', async () => {
  nextOutcome = { ok: false, message: 'Server melted' };
  const { container, root } = await render();
  try {
    await flush();
    const text = container.textContent;
    assert.match(text, /Server melted/);
    assert.match(text, /Reports unavailable/);
    assert.ok(!/No analytics yet/.test(text), 'a failed read was reported as an empty repository');
    assert.ok(!/Total Contracts/.test(text), 'figures were rendered from a failed request');
    assert.ok(container.querySelector('[role="alert"]'), 'the error is not announced');
    assert.ok(/Retry/.test(text), 'no retry control');
  } finally {
    await teardown(root);
  }
});

test('retry after a cold failure recovers to the data view', async () => {
  nextOutcome = { ok: false, message: 'Server melted' };
  const { container, root } = await render();
  try {
    await flush();
    nextOutcome = { ok: true, data: GOOD };
    const retry = button(container, /Retry/);
    assert.ok(retry, 'no retry button');
    await click(retry);
    await flush();
    const text = container.textContent;
    assert.match(text, /Total Contracts/);
    assert.ok(!/Reports unavailable/.test(text), 'the failure state was not cleared');
    assert.ok(!/Server melted/.test(text), 'the error banner was not cleared');
  } finally {
    await teardown(root);
  }
});

test('a genuinely empty repository shows "No analytics yet" with no error', async () => {
  nextOutcome = { ok: true, data: EMPTY };
  const { container, root } = await render();
  try {
    await flush();
    const text = container.textContent;
    assert.match(text, /No analytics yet/);
    assert.ok(!/Reports unavailable/.test(text));
    assert.ok(!container.querySelector('[role="alert"]'), 'an empty repository must not raise an error');
  } finally {
    await teardown(root);
  }
});

test('a failed refresh keeps the last good figures on screen', async () => {
  nextOutcome = { ok: true, data: GOOD };
  const { container, root } = await render();
  try {
    await flush();
    assert.match(container.textContent, /Total Contracts/);
    nextOutcome = { ok: false, message: 'temporary outage' };
    await click(button(container, /Refresh/));
    await flush();
    const text = container.textContent;
    assert.match(text, /temporary outage/);
    assert.match(text, /Total Contracts/, 'the figures disappeared on a failed refresh');
    assert.ok(!/No analytics yet/.test(text), 'a failed refresh rendered an empty state');
    assert.ok(!/Reports unavailable/.test(text), 'a failed refresh replaced good data with the failure panel');
  } finally {
    await teardown(root);
  }
});

test('a refresh in flight does not replace the page with a skeleton', async () => {
  nextOutcome = { ok: true, data: GOOD };
  const { container, root } = await render();
  try {
    await flush();
    gate = deferred();
    await click(button(container, /Refresh/));
    assert.ok(!container.querySelector('[role="status"]'), 'the skeleton flashed during a background refresh');
    assert.match(container.textContent, /Total Contracts/);
    assert.match(container.textContent, /Refreshing/);
    gate.resolve({ data: JSON.parse(JSON.stringify(GOOD)) });
    gate = null;
    await flush();
  } finally {
    await teardown(root);
  }
});

test('breakdown rows are links into the matching Contracts filter', async () => {
  nextOutcome = { ok: true, data: GOOD };
  const { container, root } = await render();
  try {
    await flush();
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    assert.ok(links.includes('/contracts?status=Active'), `status link missing: ${JSON.stringify(links)}`);
    assert.ok(links.includes('/contracts?type=Vendor'), `type link missing: ${JSON.stringify(links)}`);
  } finally {
    await teardown(root);
  }
});

test('zero or missing metric keys render as 0 rather than NaN, Infinity or undefined', async () => {
  nextOutcome = { ok: true, data: EMPTY };
  const empty = await render();
  try {
    await flush();
    assert.ok(!/NaN|Infinity|undefined/.test(empty.container.textContent), `a non-finite figure reached the page: ${empty.container.textContent}`);
  } finally {
    await teardown(empty.root);
  }

  nextOutcome = { ok: true, data: { metrics: { total: 3 }, statusBreakdown: [{ _id: 'Active', count: 3 }], typeBreakdown: [] } };
  const partial = await render();
  try {
    await flush();
    const text = partial.container.textContent;
    assert.ok(!/undefined|NaN/.test(text), `undefined leaked: ${text}`);
    assert.match(text, /0 obligations · 0 milestones/);
  } finally {
    await teardown(partial.root);
  }
});

test('a body that is not an object still fails closed to the failure panel', async () => {
  nextOutcome = { ok: true, data: null };
  const { container, root } = await render();
  try {
    await flush();
    const text = container.textContent;
    assert.match(text, /Reports unavailable/);
    assert.ok(!/No analytics yet/.test(text), 'a malformed payload read as an empty repository');
  } finally {
    await teardown(root);
  }
});
