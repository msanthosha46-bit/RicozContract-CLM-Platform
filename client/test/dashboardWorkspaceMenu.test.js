'use strict';

// Behaviour tests for the Dashboard "Current workspace" dropdown.
//
// That control used to be a decorative <span> styled like the Reports button
// beside it, so pressing it did nothing. It now opens a menu of the existing
// workspace routes (the same role-filtered set the Sidebar draws), and must
// behave like the topbar account menu: open from the trigger, list the real
// destinations, dismiss on an action, a press outside, or Escape.
//
// Same zero-install jsdom + Babel harness as accountMenu.test.js; the theme
// context needs the real ThemeProvider and a matchMedia stub.

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
  'MutationObserver',
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

dom.window.matchMedia = () => ({
  matches: false,
  media: '(prefers-color-scheme: dark)',
  addEventListener() {},
  removeEventListener() {}
});
expose('matchMedia', dom.window.matchMedia);

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const api = require('../src/services/api').default;
const { AuthContext } = require('../src/context/AuthContext');
const { ThemeProvider } = require('../src/context/ThemeContext');
const Dashboard = require('../src/pages/Dashboard').default;

const mounted = [];

const renderDashboard = async ({ role = 'Admin' } = {}) => {
  api.get = async () => ({
    data: {
      metrics: { total: 0, active: 0, pending: 0, expiringSoon: 0 },
      statusBreakdown: [],
      valueByCurrency: [],
      recentContracts: []
    }
  });
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            AuthContext.Provider,
            { value: { user: { _id: 'u1', name: 'Ada Admin', email: 'ada@ricoz.test', role }, logout() {} } },
            React.createElement(Dashboard, null)
          )
        )
      )
    );
  });
  return container;
};

const trigger = (container) => container.querySelector('button[aria-controls="dashboard-workspace-menu"]');
const menu = (container) => container.querySelector('[data-overlay="workspace-menu"]');
const item = (container, label) =>
  [...(menu(container)?.querySelectorAll('a[role="menuitem"]') || [])]
    .find((node) => node.textContent.trim() === label);

const tap = (element) => {
  assert.ok(element, 'expected the element to be in the document');
  return act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const press = (target, type) => act(async () => {
  target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
});

const pressKey = (key) => act(async () => {
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
});

const openMenu = async (container) => {
  await tap(trigger(container));
  assert.ok(menu(container), 'the workspace trigger did not open the menu');
};

test.beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.document.documentElement.classList.remove('dark');
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
});

test('the workspace menu stays closed until the trigger is pressed', async () => {
  const container = await renderDashboard();

  assert.ok(trigger(container), 'expected the "Current workspace" trigger');
  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');
  assert.equal(menu(container), null);

  await openMenu(container);

  assert.equal(trigger(container).getAttribute('aria-expanded'), 'true');
  assert.equal(menu(container).getAttribute('role'), 'menu');
});

test('the menu lists the existing workspace routes', async () => {
  const container = await renderDashboard({ role: 'Admin' });
  await openMenu(container);

  assert.equal(item(container, 'Overview').getAttribute('href'), '/dashboard');
  assert.equal(item(container, 'Contracts').getAttribute('href'), '/contracts');
  assert.equal(item(container, 'Reports').getAttribute('href'), '/reports');
  assert.equal(item(container, 'Profile').getAttribute('href'), '/profile');
});

test('Reports is role-gated in the menu; other links are not', async () => {
  const admin = await renderDashboard({ role: 'Admin' });
  await openMenu(admin);
  assert.ok(item(admin, 'Reports'), 'an admin should see Reports');

  await act(async () => {
    mounted.pop().unmount();
  });
  dom.window.document.body.innerHTML = '';

  const employee = await renderDashboard({ role: 'Employee' });
  await openMenu(employee);
  assert.ok(!item(employee, 'Reports'), 'an employee must not see Reports');
  assert.ok(item(employee, 'Contracts'), 'the workspace routes other than Reports stay visible');
});

test('choosing a workspace route closes the menu', async () => {
  const container = await renderDashboard();
  await openMenu(container);

  await tap(item(container, 'Contracts'));

  assert.equal(menu(container), null);
  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');
});

test('a press outside the menu closes it', async () => {
  const container = await renderDashboard();
  await openMenu(container);

  await press(dom.window.document.body, 'pointerdown');

  assert.equal(menu(container), null);
});

test('Escape closes the menu and returns focus to the trigger', async () => {
  const container = await renderDashboard();
  await openMenu(container);

  await pressKey('Escape');

  assert.equal(menu(container), null);
  assert.equal(dom.window.document.activeElement, trigger(container));
});

// There is no browser runner here, so -- as in mobileOverflow.test.js -- the
// geometry is read from the real className. The menu is fluid: a 14rem column
// capped to the viewport with a 1rem margin, anchored to the trigger so it
// cannot run off either edge on a 320px phone.
test('the workspace menu cannot overflow a narrow viewport', () => {
  const src = fs.readFileSync(path.join(SRC, 'pages', 'Dashboard.js'), 'utf8');
  const match = src.match(/data-overlay="workspace-menu"[\s\S]*?className="([^"]+)"/);
  assert.ok(match, 'the workspace menu overlay was not found');
  const className = match[1];

  assert.match(className, /(?:^|\s)w-56(?:\s|$)/, 'expected the 14rem column');
  assert.match(className, /max-w-\[calc\(100vw_-_2rem\)\]/, 'the menu is not capped to the viewport');
  assert.match(className, /(?:^|\s)left-0(?:\s|$)/, 'the menu should sit inside the left edge on a phone');
  assert.match(className, /md:right-0/, 'the menu should align to the trigger at md and up');
  assert.match(className, /(?:^|\s)z-40(?:\s|$)/, 'the menu must layer above the page content');

  const width = 14 * 16;
  assert.ok(width <= 320 - 2 * 16, `the menu (${width}px) exceeds a 320px viewport with margins`);
});
