'use strict';

// Issue 8 - Contracts list pagination navigation.
//
// The search-debounce effect in ContractsList.js called resetToFirstPage()
// unconditionally, so it also fired once on mount. A shared or bookmarked
// `?page=` link (and a browser refresh on page 3) was therefore bounced back to
// page 1, contradicting the pagination file's own "pagination state is
// shareable" contract. The same accidental reset was the only thing hiding an
// out-of-range `?page=` (which returned no rows while a correct total was
// shown).
//
// The fix resets the page only when the debounced search term actually changes,
// and realigns a genuinely out-of-range page to the last valid page. These
// tests mount the real page behind a real MemoryRouter so useSearchParams is
// exercised, and pin both behaviours plus their controls.
//
// Same zero-install jsdom + Babel harness as issue33/issue42.

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
  'HTMLInputElement'
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
const { MemoryRouter, useSearchParams } = require('react-router-dom');

const calls = [];
let handler = async () => ({ data: { contracts: [], total: 0, page: 1, totalPages: 1 } });

const API = {
  async get(url) {
    calls.push(url);
    return handler(new URL(url, 'https://x'));
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

stub('services/api.js', { __esModule: true, default: API });
stub('context/AuthContext.js', {
  __esModule: true,
  AuthContext: React.createContext({ user: { _id: 'u1', name: 'Probe', role: 'Manager' } })
});

const ContractsList = require(path.join(SRC, 'pages', 'ContractsList.js')).default;

let currentSearch = '';
const LocationProbe = () => {
  const [sp] = useSearchParams();
  currentSearch = sp.toString();
  return null;
};

const body = () => dom.window.document.body;
const text = (scope) => scope.textContent.replace(/\s+/g, ' ');
const settle = () => act(async () => {});
const flushDebounce = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 500); }); });

const pageOf = (url) => new URLSearchParams(url.slice(url.indexOf('?'))).get('page');
const searchOf = (url) => new URLSearchParams(url.slice(url.indexOf('?'))).get('search');

const row = (i) => ({
  _id: 'c' + i, contractNumber: 'CT-000' + i, title: 'Contract ' + i, type: 'Vendor',
  partyName: 'Party ' + i, endDate: '2026-01-01', amount: 1000, currency: 'USD', status: 'Active'
});
const rows = (n, offset = 0) => Array.from({ length: n }, (_, i) => row(offset + i));

const mounted = [];
const mount = async (entry, getImpl) => {
  calls.length = 0;
  currentSearch = entry;
  handler = getImpl;
  const container = dom.window.document.createElement('div');
  body().appendChild(container);
  const root = createRoot(container);
  mounted.push({ root });
  await act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: [entry] },
      React.createElement(React.Fragment, null,
        React.createElement(LocationProbe, null),
        React.createElement(ContractsList, null))));
  });
  await settle();
  await flushDebounce();
  await settle();
  return container;
};

// 137 contracts => 7 pages of 20. A status filter narrows to 25 (2 pages); a
// search narrows to 1 (1 page).
const pagedServer = async (url) => {
  const params = url.searchParams;
  const page = Number(params.get('page')) || 1;
  let total = 137;
  if (params.get('status')) total = 25;
  if (params.get('search')) total = 1;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const count = page > totalPages ? 0 : Math.min(20, total - (page - 1) * 20);
  return { data: { contracts: count > 0 ? rows(count, (page - 1) * 20) : [], total, page, totalPages } };
};

const emptyServer = async () => ({ data: { contracts: [], total: 0, page: 1, totalPages: 0 } });

const click = (el) => act(async () => {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const typeSearch = (input, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});

test.afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  body().innerHTML = '';
});

test('a shared/bookmarked ?page= is preserved on mount instead of bouncing to page 1', async () => {
  const container = await mount('/contracts?page=3', pagedServer);

  assert.match(currentSearch, /(?:^|&)page=3(?:&|$)/, 'the deep-linked page was discarded');
  assert.ok(container.querySelector('tbody'), 'page 3 must render its rows');
  assert.deepEqual(calls.map(pageOf), ['3'], 'mount must not refetch a different page');
  assert.match(text(container), /page 3 of 7/);
  assert.ok(container.querySelector('[aria-label="Next page"]'), 'paging controls should be available');
});

test('a valid deep link that also carries a filter keeps its page', async () => {
  const container = await mount('/contracts?page=2&status=Active', pagedServer);

  assert.match(currentSearch, /(?:^|&)page=2(?:&|$)/);
  assert.match(currentSearch, /(?:^|&)status=Active(?:&|$)/);
  assert.ok(container.querySelector('tbody'));
  assert.deepEqual(calls.map(pageOf), ['2']);
});

test('an out-of-range ?page= realigns to the last valid page instead of showing an empty repository', async () => {
  const fourServer = async (url) => {
    const page = Number(url.searchParams.get('page')) || 1;
    return page <= 1
      ? { data: { contracts: rows(4), total: 4, page: 1, totalPages: 1 } }
      : { data: { contracts: [], total: 4, page, totalPages: 1 } };
  };
  const container = await mount('/contracts?page=5', fourServer);

  assert.doesNotMatch(currentSearch, /page=/, 'page 1 stays out of the URL');
  assert.ok(container.querySelector('tbody'), 'the realigned page must show the matching contracts');
  assert.doesNotMatch(text(container), /No contracts found/, 'a stale page is not an empty repository');
  assert.match(text(container), /4 contracts in your repository/);
  assert.deepEqual(calls.map(pageOf), ['5', '1'], 'the out-of-range page is corrected once');
});

test('changing the search still resets to the first page', async () => {
  const container = await mount('/contracts?page=3', pagedServer);
  assert.match(currentSearch, /page=3/);

  await typeSearch(container.querySelector('input[type="search"]'), 'Contract 5');
  await flushDebounce();
  await settle();

  assert.doesNotMatch(currentSearch, /page=/, 'a new search must return to page 1');
  const lastUrl = calls[calls.length - 1];
  assert.equal(pageOf(lastUrl), '1');
  assert.equal(searchOf(lastUrl), 'Contract 5');
});

test('a genuinely empty repository still shows the empty state', async () => {
  const container = await mount('/contracts', emptyServer);

  assert.match(text(container), /No contracts found/);
  assert.match(text(container), /Create your first contract/);
  assert.equal(container.querySelector('tbody'), null);
  assert.equal(container.querySelector('[role="alert"]'), null);
});
