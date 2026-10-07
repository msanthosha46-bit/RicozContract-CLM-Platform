'use strict';

// Active-state tests for the sidebar navigation.
//
// `NavLink` decides both its highlight and `aria-current="page"` from a single
// prefix test, and in react-router 6 the attribute is derived rather than
// overridable. That broke on `/contracts/create`, where "Create Contract" is a
// peer entry living *under* the "Contracts" prefix: the parent matched too, so
// two items were marked as the current page and two were highlighted at once.
// The footer shortcut had the same problem on the page it points at.
//
// These tests assert the rule rather than the styling: at most one link in the
// sidebar may claim the current page, and the claim must land on the most
// specific entry that covers the path — while a detail page with no entry of
// its own still falls back to its section.
//
// As elsewhere in this folder there is no browser runner, so jsdom plus a
// Babel require hook runs the real component exactly as the build compiles it.
// jsdom has no layout engine, so widths are not asserted here; see
// mobileOverflow.test.js for that.

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
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage'
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
const { MemoryRouter } = require('react-router-dom');
const { AuthContext } = require('../src/context/AuthContext');
const Sidebar = require('../src/components/Layout/Sidebar').default;

const mounted = [];

const renderSidebar = async (route, role = 'Admin') => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [route] },
        React.createElement(
          AuthContext.Provider,
          { value: { user: { _id: 'u1', name: 'Dana Scott', email: 'dana@ricoz.test', role }, logout() {} } },
          React.createElement(Sidebar, { isOpen: true, onClose() {} })
        )
      )
    );
  });
  return container.querySelector('aside#ricoz-sidebar');
};

// Every link the sidebar owns, so the shortcut in the footer is counted too.
const currentLabels = (aside) =>
  [...aside.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent.trim());

const navLabels = (aside) => [...aside.querySelectorAll('nav a')].map((a) => a.textContent.trim());

// The highlight branch is the only place a nav entry picks up a solid
// background, which is how a sighted user tells the active row apart.
const highlightedLabels = (aside) =>
  [...aside.querySelectorAll('nav a')]
    .filter((a) => /\bbg-white\b/.test(a.className) && !/hover:bg-white/.test(a.className))
    .map((a) => a.textContent.trim());

test.after(async () => {
  for (const root of mounted) await act(async () => root.unmount());
  dom.window.document.body.innerHTML = '';
});

test('a nested entry wins over its parent prefix', async () => {
  // The regression: both "Contracts" and "Create Contract" were marked current.
  const aside = await renderSidebar('/contracts/create');
  assert.deepEqual(currentLabels(aside), ['Create Contract']);
  assert.deepEqual(highlightedLabels(aside), ['Create Contract']);
});

test('a detail page with no entry of its own falls back to its section', async () => {
  // Adding `end` to every link would have left these two rows with no active
  // item at all, so the fix has to keep the parent match.
  for (const route of ['/contracts/c1', '/contracts/c1/edit']) {
    const aside = await renderSidebar(route);
    assert.deepEqual(currentLabels(aside), ['Contracts'], route);
    assert.deepEqual(highlightedLabels(aside), ['Contracts'], route);
  }
});

test('exactly one entry is current on every navigable route', async () => {
  const routes = [
    '/dashboard',
    '/contracts',
    '/contracts/create',
    '/contracts/c1',
    '/contracts/c1/edit',
    '/obligations',
    '/milestones',
    '/approvals',
    '/amendments',
    '/renewals',
    '/reports',
    '/activity',
    '/users',
    '/settings',
    '/profile'
  ];
  for (const route of routes) {
    const aside = await renderSidebar(route);
    assert.equal(currentLabels(aside).length, 1, `${route} marked more than one entry current`);
    assert.deepEqual(highlightedLabels(aside), currentLabels(aside), `${route} highlight disagrees with aria-current`);
  }
});

test('the footer shortcut never claims to be the current page', async () => {
  // It points at the same page the nav entry already owns.
  for (const [role, route, shortcut] of [
    ['Admin', '/renewals', 'Open renewals'],
    ['Employee', '/obligations', 'Open obligations']
  ]) {
    const aside = await renderSidebar(route, role);
    assert.equal(currentLabels(aside).length, 1, `${role} on ${route} marked more than one link current`);
    assert.ok(
      [...aside.querySelectorAll('a')].some((a) => a.textContent.trim().startsWith(shortcut)),
      `expected the ${shortcut} shortcut to still be present`
    );
  }
});

test('links the signed-in role cannot use are absent, not merely inactive', async () => {
  // An employee has no entry for these, so there is nothing to mark current;
  // the routes themselves are gated by RoleProtectedRoute in App.js.
  const aside = await renderSidebar('/dashboard', 'Employee');
  const labels = navLabels(aside);
  for (const hidden of ['Approval Requests', 'Amendment Requests', 'Renewals', 'Reports', 'Activity Log', 'User Management', 'Settings']) {
    assert.ok(!labels.includes(hidden), `Employee should not see ${hidden}`);
  }
  assert.deepEqual(currentLabels(aside), ['Dashboard']);
});

test('an unmatched path leaves the navigation without an active entry', async () => {
  // A route with no sidebar entry at all must not light up a neighbouring one.
  const aside = await renderSidebar('/profile');
  assert.deepEqual(currentLabels(aside), ['Profile']);
});
