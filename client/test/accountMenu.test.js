'use strict';

// Behaviour tests for the topbar account (profile) menu: it opens from the
// trigger, offers Profile (and Settings for admins), carries the phone-only
// theme control, and closes again from an action, a press outside, or Escape.
//
// The mobile layout fix (see mobileOverflow.test.js) reshaped this menu — a
// viewport-anchored overlay with a height cap and a compact labelled theme
// row — so these tests pin that the interaction the redesign could have
// broken still works: every action is present, reachable, and dismisses.
//
// Same zero-install jsdom + Babel harness as notificationPopup.test.js; the
// theme control additionally needs the real ThemeProvider and a matchMedia
// stub, exactly as theme.test.js does.

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

// The theme provider reads the OS preference on mount; jsdom has no matchMedia.
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
const Topbar = require('../src/components/Layout/Topbar').default;

const mounted = [];

const renderTopbar = async ({ role = 'Admin', logout = () => {} } = {}) => {
  api.get = async () => ({ data: { count: 0, items: [] } });
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
            { value: { user: { _id: 'u1', name: 'Ada Admin', email: 'ada@ricoz.test', role }, logout } },
            React.createElement(Topbar, { onMenuClick() {} })
          )
        )
      )
    );
  });
  return container;
};

const trigger = (container) => container.querySelector('button[aria-controls="topbar-account-menu"]');
const menu = (container) => container.querySelector('[data-overlay="account-menu"]');
const menuItem = (container, label) =>
  [...(menu(container)?.querySelectorAll('a[role="menuitem"], button[role="menuitem"]') || [])]
    .find((node) => node.textContent.includes(label));

const press = (target, type, init = {}) => act(async () => {
  target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true, ...init }));
});

const tap = (element) => {
  assert.ok(element, 'expected the element to be in the document');
  return act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const pressKey = (key) => act(async () => {
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
});

const openMenu = async (container) => {
  await tap(trigger(container));
  assert.ok(menu(container), 'the account trigger did not open the menu');
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

test('the menu stays closed until the trigger is pressed', async () => {
  const container = await renderTopbar();

  assert.equal(menu(container), null);
  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');

  await openMenu(container);

  assert.equal(trigger(container).getAttribute('aria-expanded'), 'true');
  assert.equal(menu(container).getAttribute('role'), 'menu');
});

test('the menu shows the profile identity and offers Profile', async () => {
  const container = await renderTopbar();
  await openMenu(container);

  assert.match(menu(container).textContent, /Ada Admin/);
  assert.match(menu(container).textContent, /ada@ricoz\.test/);

  const profile = menuItem(container, 'Profile');
  assert.ok(profile, 'expected a Profile action');
  assert.equal(profile.getAttribute('href'), '/profile');
});

test('an admin also gets Settings; a non-admin does not', async () => {
  const admin = await renderTopbar({ role: 'Admin' });
  await openMenu(admin);
  assert.ok(menuItem(admin, 'Settings'), 'an admin should see Settings');

  await act(async () => {
    mounted.pop().unmount();
  });
  dom.window.document.body.innerHTML = '';

  const employee = await renderTopbar({ role: 'Employee' });
  await openMenu(employee);
  assert.ok(!menuItem(employee, 'Settings'), 'an employee must not see Settings');
});

test('choosing Profile closes the menu', async () => {
  const container = await renderTopbar();
  await openMenu(container);

  await tap(menuItem(container, 'Profile'));

  assert.equal(menu(container), null);
  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');
});

test('the phone theme row is labelled, compact, and switches the theme', async () => {
  const container = await renderTopbar();
  await openMenu(container);

  const toggle = menu(container).querySelector('button[aria-label="Switch to dark theme"]');
  assert.ok(toggle, 'expected the theme control inside the menu');
  assert.equal(toggle.textContent.trim(), 'Dark mode', 'an icon alone is ambiguous on a phone');
  assert.match(toggle.className, /h-9/, 'the theme row is the compact height');
  assert.match(toggle.className, /w-full/, 'the theme row fills the menu width');

  await tap(toggle);

  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to light theme');
  assert.equal(toggle.textContent.trim(), 'Light mode');
  assert.equal(dom.window.document.documentElement.classList.contains('dark'), true);
});

test('Logout in the menu signs the user out and closes the menu', async () => {
  let signedOut = false;
  const container = await renderTopbar({ logout: () => { signedOut = true; } });
  await openMenu(container);

  await tap(menuItem(container, 'Logout'));

  assert.equal(signedOut, true, 'logout was not called');
  assert.equal(menu(container), null, 'the menu stayed open after logging out');
});

test('a press outside the menu closes it', async () => {
  const container = await renderTopbar();
  await openMenu(container);

  await press(dom.window.document.body, 'pointerdown');

  assert.equal(menu(container), null);
});

test('Escape closes the menu and returns focus to the trigger', async () => {
  const container = await renderTopbar();
  await openMenu(container);

  await pressKey('Escape');

  assert.equal(menu(container), null);
  assert.equal(dom.window.document.activeElement, trigger(container));
});
