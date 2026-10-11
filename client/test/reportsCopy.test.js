'use strict';

// Focused guard for the Reports header wording.
//
// The page used to promise "Counts are drawn from every non-archived contract",
// which is not true of the lifetime "Renewals" metric: renewals are an audit
// surface that retains records belonging to contracts that were later archived
// (see server/routes/reportRoutes.js - `Renewal.countDocuments()` has no archive
// filter - and GET /renewals/history, which returns those records). The copy now
// distinguishes contract metrics from renewal history without changing the
// lifetime renewal count itself. This test renders the real page against a
// stubbed API and asserts the wording plus the unchanged Renewals card.
//
// Same zero-install harness as probe38render.js: jsdom plus the Babel require
// hook, the real page mounted under a stubbed API and router.

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

const SUMMARY = {
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

const apiModule = path.join(SRC, 'services', 'api.js');
require.cache[apiModule] = {
  id: apiModule, filename: apiModule, loaded: true,
  exports: {
    __esModule: true,
    default: {
      get: async () => ({ data: JSON.parse(JSON.stringify(SUMMARY)) })
    }
  }
};

const routerPath = require.resolve('react-router-dom');
require.cache[routerPath] = {
  id: routerPath, filename: routerPath, loaded: true,
  exports: {
    Link: ({ to, children, ...rest }) => require('react').createElement('a', { href: to, ...rest }, children)
  }
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const PAGE = path.join(SRC, 'pages', 'Reports.js');
const loadedPage = require(PAGE);
const Reports = loadedPage.default || loadedPage;

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
};

const render = async () => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Reports)); });
  await flush();
  return { container, root };
};

test('Reports header distinguishes contract metrics from lifetime renewal history', async () => {
  const { container, root } = await render();
  try {
    const text = container.textContent;
    assert.ok(
      text.includes('Contract metrics reflect non-archived contracts. Renewal history includes records retained from archived contracts.'),
      'the header must scope the non-archived promise to contract metrics and call out archived renewal history'
    );
    assert.ok(
      !text.includes('Counts are drawn from every non-archived contract.'),
      'the old blanket non-archived claim must be gone'
    );
    assert.ok(text.includes('Renewal records to date'),
      'the Renewals card must keep its lifetime-history detail');
    assert.ok(text.includes('7'),
      'the lifetime renewal count must still render (the fix is wording only)');
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.document.body.innerHTML = '';
  }
});
