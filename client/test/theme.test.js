'use strict';

// Behaviour tests for the dark theme: the OS preference decides on a first
// visit, an explicit choice is persisted and wins afterwards, and the toggle
// moves the `dark` class that every dark override in index.css keys off.
//
// Same zero-install harness as notificationPopup.test.js: jsdom plus a require
// hook that transpiles src/*.js with the Babel presets react-scripts already
// ships, so the real component runs here as the production build compiles it.

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

// A controllable prefers-color-scheme query. jsdom has no matchMedia, and the
// provider reads it on mount, so the tests install their own and then drive it.
const installMatchMedia = (prefersDark) => {
  const listeners = new Set();
  const query = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener(type, handler) {
      if (type === 'change') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'change') listeners.delete(handler);
    },
    dispatch() {
      query.matches = prefersDark;
      for (const handler of listeners) handler({ matches: prefersDark });
    }
  };
  dom.window.matchMedia = () => query;
  expose('matchMedia', dom.window.matchMedia);
  return query;
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ThemeContext, ThemeProvider, useTheme, THEME_STORAGE_KEY } = require('../src/context/ThemeContext');
const ThemeToggle = require('../src/components/Layout/ThemeToggle').default;

const mounted = [];

const root = () => dom.window.document.documentElement;

const unmountAll = async () => {
  for (const reactRoot of mounted.splice(0)) {
    await act(async () => {
      reactRoot.unmount();
    });
  }
};

// A probe that publishes the current context value onto the DOM, so a test can
// read `theme` / `isDark` without reaching into React internals.
const Probe = () => {
  const { theme, isDark } = useTheme();
  return React.createElement('span', { 'data-testid': 'probe' }, `${theme}:${isDark}`);
};

const readProbe = (container) => container.querySelector('[data-testid="probe"]').textContent;

const render = async (children) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  mounted.push(reactRoot);
  await act(async () => {
    reactRoot.render(children);
  });
  return container;
};

const renderThemed = (children) =>
  render(React.createElement(ThemeProvider, null, children, React.createElement(Probe)));

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

test.beforeEach(() => {
  dom.window.localStorage.clear();
  root().classList.remove('dark');
  root().style.colorScheme = '';
  dom.window.document.body.innerHTML = '';
  installMatchMedia(false);
});

test.afterEach(async () => {
  await unmountAll();
  dom.window.document.body.innerHTML = '';
});

test('a first visit follows the light system preference', async () => {
  installMatchMedia(false);
  const container = await renderThemed();

  assert.equal(readProbe(container), 'light:false');
  assert.equal(root().classList.contains('dark'), false);
  assert.equal(root().style.colorScheme, 'light');
});

test('a first visit follows the dark system preference', async () => {
  installMatchMedia(true);
  const container = await renderThemed();

  assert.equal(readProbe(container), 'dark:true');
  assert.equal(root().classList.contains('dark'), true);
  assert.equal(root().style.colorScheme, 'dark');
});

test('a stored choice wins over the system preference', async () => {
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
  installMatchMedia(true);
  const container = await renderThemed();

  assert.equal(readProbe(container), 'light:false');
  assert.equal(root().classList.contains('dark'), false);
});

test('an unrecognised stored value falls back to the system preference', async () => {
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
  installMatchMedia(true);
  const container = await renderThemed();

  assert.equal(readProbe(container), 'dark:true');
});

test('toggling flips the html class, the color scheme and the stored value', async () => {
  installMatchMedia(false);
  const container = await renderThemed(React.createElement(ThemeToggle));

  assert.equal(root().classList.contains('dark'), false);

  await click(container.querySelector('button'));

  assert.equal(readProbe(container), 'dark:true');
  assert.equal(root().classList.contains('dark'), true, 'the dark class drives every override in index.css');
  assert.equal(root().style.colorScheme, 'dark');
  assert.equal(dom.window.localStorage.getItem(THEME_STORAGE_KEY), 'dark');

  await click(container.querySelector('button'));

  assert.equal(readProbe(container), 'light:false');
  assert.equal(root().classList.contains('dark'), false);
  assert.equal(root().style.colorScheme, 'light');
  assert.equal(dom.window.localStorage.getItem(THEME_STORAGE_KEY), 'light');
});

test('the toggle reports the mode it switches to, not just "button"', async () => {
  installMatchMedia(false);
  const container = await renderThemed(React.createElement(ThemeToggle));
  const button = container.querySelector('button');

  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'Switch to dark theme');

  await click(button);

  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Switch to light theme');
});

test('the stored choice is what a later visit reads back', async () => {
  installMatchMedia(false);
  const first = await renderThemed(React.createElement(ThemeToggle));
  await click(first.querySelector('button'));
  assert.equal(dom.window.localStorage.getItem(THEME_STORAGE_KEY), 'dark');

  // A new mount, as if the tab were reloaded. The system still says light, so
  // only the persisted dark choice can explain the result.
  await unmountAll();
  dom.window.document.body.innerHTML = '';

  const second = await renderThemed();
  assert.equal(readProbe(second), 'dark:true');
  assert.equal(root().classList.contains('dark'), true);
});

test('useTheme falls back instead of throwing when no provider is mounted', () => {
  let value;
  const Orphan = () => {
    value = useTheme();
    return null;
  };
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  mounted.push(reactRoot);

  assert.doesNotThrow(() => {
    act(() => {
      reactRoot.render(React.createElement(Orphan));
    });
  });

  assert.equal(value.theme, 'light');
  assert.equal(value.isDark, false);
  assert.equal(typeof value.toggleTheme, 'function');
});
