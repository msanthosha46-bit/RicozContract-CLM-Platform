'use strict';

// Behavioural regression test for the landing page mobile menu.
//
// The header renders a hamburger below `md` and a panel below it. The panel
// carried `aria-controls="landing-menu"` and the component created a
// `menuRef` for it, but the ref was never attached to any element. The
// outside-press handler therefore read `menuRef.current === null` on every
// press, short-circuited, and closed nothing: on a phone the panel could only
// be dismissed with the hamburger, Escape, or by following a link, so a tap on
// the page behind it left the panel open over the content.
//
// This file renders the real component through the same zero-install
// jsdom + Babel harness as controls.test.js and drives the dismissal paths.
// Source-shape assertions cannot catch this: the handler body was already
// correct, and so was every className on the panel.
//
// The pair that pins the attachment is "a press on the page behind the panel
// closes it" together with "a press inside the panel does not dismiss it".
// Drop `ref={menuRef}` and the outside press still closes the panel -- the
// guard skips a null ref and falls through to `setMenuOpen(false)` -- so only
// the second test notices, because an unattached ref cannot tell a press on a
// link from a press on the page.

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

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { ThemeProvider } = require('../src/context/ThemeContext');
const LandingPage = require('../src/pages/LandingPage').default;

const mounted = [];

// jsdom implements no scrolling, so following an in-page anchor in the panel
// reaches `scrollIntoView` on mount of the next render and throws. Stub it, the
// way controls.test.js stubs the missing layout box.
Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value() {}
});

const render = async () => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(ThemeProvider, null, React.createElement(MemoryRouter, null, React.createElement(LandingPage)))
    );
  });
  return container;
};

// The panel listens for `pointerdown`, which jsdom does not implement as a
// constructor. Dispatching a MouseEvent under that type reaches the listener
// exactly as a real press does; jsdom has no layout, so it cannot be told the
// difference and neither can the component.
const press = (node) => act(async () => {
  node.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
});

const tap = (node) => act(async () => {
  node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const pressKey = (key) => act(async () => {
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
});

const panel = (container) => container.querySelector('#landing-menu');
const trigger = (container) => container.querySelector('button[aria-controls="landing-menu"]');

const openMenu = async (container) => {
  await tap(trigger(container));
  assert.ok(panel(container), 'the hamburger did not open the menu');
};

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

test('the hamburger opens the panel and announces its state', async () => {
  const container = await render();

  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');
  assert.equal(panel(container), null);

  await tap(trigger(container));

  assert.equal(trigger(container).getAttribute('aria-expanded'), 'true');
  assert.ok(panel(container), 'expected #landing-menu after the first tap');
  assert.deepEqual(
    Array.from(panel(container).querySelectorAll('a')).map((a) => a.getAttribute('href')),
    ['#features', '#how-it-works', '#security', '/login', '/register']
  );
});

test('a press on the page behind the panel closes it', async () => {
  const container = await render();
  await openMenu(container);

  await press(container.querySelector('main h1'));

  assert.equal(panel(container), null, 'a press outside the panel left it open');
  assert.equal(trigger(container).getAttribute('aria-expanded'), 'false');
});

test('a press outside the panel on the header brand closes it too', async () => {
  const container = await render();
  await openMenu(container);

  await press(container.querySelector('header a[href="/"]'));

  assert.equal(panel(container), null);
});

test('the hamburger still closes the panel it opened', async () => {
  // The trigger sits outside the panel, so a naive outside-press check would
  // close on `pointerdown` and let the following `click` toggle it open again.
  const container = await render();
  await openMenu(container);

  await press(trigger(container));
  await tap(trigger(container));

  assert.equal(panel(container), null, 'the trigger press and tap must not cancel each other out');
});

test('a press inside the panel does not dismiss it', async () => {
  const container = await render();
  await openMenu(container);

  await press(panel(container));

  assert.ok(panel(container), 'a press within the panel must not count as outside');
});

test('following an in-page link closes the panel', async () => {
  const container = await render();
  await openMenu(container);

  await tap(panel(container).querySelector('a[href="#security"]'));

  assert.equal(panel(container), null);
});

test('Escape closes the panel and hands focus back to the hamburger', async () => {
  const container = await render();
  await openMenu(container);

  await pressKey('Escape');

  assert.equal(panel(container), null);
  assert.equal(dom.window.document.activeElement, trigger(container));
});

test('a key other than Escape leaves the panel open', async () => {
  const container = await render();
  await openMenu(container);

  await pressKey('Tab');

  assert.ok(panel(container));
});

test('the panel only listens while it is open', async () => {
  const container = await render();

  // With the panel closed a stray press must not leave a listener behind that
  // fires later, and opening must not stack a second copy of the handler.
  await press(container.querySelector('main h1'));
  await openMenu(container);
  await press(container.querySelector('main h1'));
  assert.equal(panel(container), null);

  await openMenu(container);
  await press(container.querySelector('main h1'));
  assert.equal(panel(container), null, 'one press must be enough to dismiss');
});
