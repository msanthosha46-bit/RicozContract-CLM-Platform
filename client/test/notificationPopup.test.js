'use strict';

// Behaviour tests for the topbar notification popup: it opens from the bell,
// renders what the notifications endpoint returned, and closes again from its
// own close button, from a press outside, and from the Escape key.
//
// The repository has no browser runner, so this file builds the smallest
// possible one: jsdom for the DOM and a require hook that transpiles src/*.js
// with the Babel presets react-scripts already ships, so the real component
// runs here exactly as the production build compiles it. Nothing is installed.
//
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

// Transpile the app's own modules on the way in; node_modules and everything
// else keep Node's loader.
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
const api = require('../src/services/api').default;
const { AuthContext } = require('../src/context/AuthContext');
const Topbar = require('../src/components/Layout/Topbar').default;

const NOTIFICATIONS = {
  count: 2,
  items: [
    { id: 'n1', title: 'Contract approved', detail: 'Vendor MSA is ready to sign.', href: '/contracts' },
    { id: 'n2', title: 'Obligation due', detail: 'Insurance certificate expires soon.', href: '/obligations' }
  ]
};

const bell = (container) => container.querySelector('button[aria-label="Notifications"]');
const panel = (container) => container.querySelector('[data-overlay="notifications"]');
const closeButton = (container) => container.querySelector('button[aria-label="Close notifications"]');

const mounted = [];

const renderTopbar = async (notifications = NOTIFICATIONS) => {
  api.get = async () => ({ data: notifications });
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          AuthContext.Provider,
          { value: { user: { email: 'tester@ricoz.test', role: 'admin' }, logout() {} } },
          React.createElement(Topbar, { onMenuClick() {} })
        )
      )
    );
  });
  return container;
};

const press = (target, type, init = {}) => act(async () => {
  target.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true, ...init }));
});

// A plain Event carries no `key`, so a keydown built with `press` above would
// reach the handler with `event.key === undefined` and the Escape test would
// pass or fail for the wrong reason. KeyboardEvent is what the component
// actually listens for.
const pressKey = (key) => act(async () => {
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
});

const click = (element) => {
  assert.ok(element, 'expected the element to be in the document');
  return press(element, 'click');
};

test.afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount();
  dom.window.document.body.innerHTML = '';
});

test('the popup stays closed until the bell is pressed', async () => {
  const container = await renderTopbar();

  assert.equal(panel(container), null);
  assert.equal(bell(container).getAttribute('aria-expanded'), 'false');

  await click(bell(container));

  assert.ok(panel(container), 'expected the popup to open');
  assert.equal(bell(container).getAttribute('aria-expanded'), 'true');
});

test('the popup renders the notifications the endpoint returned', async () => {
  const container = await renderTopbar();
  await click(bell(container));

  const items = panel(container).querySelectorAll('a[href]');
  assert.equal(items.length, 2);
  assert.match(panel(container).textContent, /Contract approved/);
  assert.match(panel(container).textContent, /Insurance certificate expires soon\./);
});

test('the heading and the close button are inside the panel', async () => {
  const container = await renderTopbar();
  await click(bell(container));

  const heading = [...panel(container).querySelectorAll('p')].find((node) => node.textContent === 'Notifications');
  assert.ok(heading, 'expected the Notifications heading');
  assert.ok(closeButton(container), 'expected a close button in the panel');
});

test('the close button closes the popup', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await click(closeButton(container));

  assert.equal(panel(container), null);
  assert.equal(bell(container).getAttribute('aria-expanded'), 'false');
});

test('pressing the bell again closes the popup', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await click(bell(container));

  assert.equal(panel(container), null);
});

test('a press outside the popup closes it', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await press(dom.window.document.body, 'pointerdown');

  assert.equal(panel(container), null);
});

test('a press inside the popup leaves it open', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await press(panel(container).querySelector('a[href]'), 'pointerdown');

  assert.ok(panel(container), 'expected the popup to stay open');
});

test('Escape closes the popup', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await pressKey('Escape');

  assert.equal(panel(container), null);
});

test('keys other than Escape leave the popup open', async () => {
  const container = await renderTopbar();
  await click(bell(container));
  await pressKey('Enter');

  assert.ok(panel(container), 'expected the popup to stay open');
});

test('the popup carries the clamped mobile width and the top stacking layer', async () => {
  const container = await renderTopbar();
  await click(bell(container));

  const { className } = panel(container);
  assert.match(className, /w-\[min\(20rem,calc\(100vw_-_2rem\)\)\]/);
  assert.match(className, /z-50/);
  assert.match(className, /absolute/);
  assert.equal(panel(container).getAttribute('role'), 'dialog');
});
