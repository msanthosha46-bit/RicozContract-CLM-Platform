'use strict';

// Behaviour tests for the two shared controls that stop a request firing twice
// and stop a widget forcing the page sideways:
//
//  - SubmitButton, which every form routes its submit through, owns the busy
//    state: it disables itself, announces aria-busy, and swaps the label while
//    the request is in flight.
//  - GoogleSignInButton, which used to render Google's iframe at a hard-coded
//    360px. On a 320px phone that iframe was wider than its column and forced a
//    horizontal scrollbar; it now clamps to the container and follows the
//    theme.
//
// Same zero-install harness as notificationPopup.test.js.

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
const SubmitButton = require('../src/components/Layout/Common/SubmitButton').default;
const GoogleSignInButton = require('../src/components/GoogleSignInButton').default;

const mounted = [];

const render = async (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
};

const click = (element) => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
});

const text = (element) => element.textContent;

test.beforeEach(() => {
  dom.window.document.body.innerHTML = '';
  dom.window.document.querySelectorAll('script[data-google-identity]').forEach((node) => node.remove());
  delete dom.window.google;
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
  dom.window.document.querySelectorAll('script[data-google-identity]').forEach((node) => node.remove());
  delete dom.window.google;
});

/* ------------------------------------------------------------------ *
 * SubmitButton
 * ------------------------------------------------------------------ */

test('a resting submit button is enabled and unlabelled as busy', async () => {
  const container = await render(React.createElement(SubmitButton, null, 'Save draft'));
  const button = container.querySelector('button');

  assert.equal(button.getAttribute('type'), 'submit');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(text(button), 'Save draft');
});

test('a busy submit button disables itself, announces itself and swaps the label', async () => {
  const container = await render(
    React.createElement(SubmitButton, { loading: true, loadingLabel: 'Saving…' }, 'Save draft')
  );
  const button = container.querySelector('button');

  assert.equal(button.disabled, true, 'a second tap must not reach the handler');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(text(button), 'Saving…');
});

test('a busy submit button without a loading label keeps its own label', async () => {
  // Keeping the text mounted stops the button collapsing and shifting the
  // layout while the request is in flight.
  const container = await render(React.createElement(SubmitButton, { loading: true }, 'Save draft'));

  assert.equal(text(container.querySelector('button')), 'Save draft');
});

test('an explicit disabled prop blocks submit even when not loading', async () => {
  const container = await render(React.createElement(SubmitButton, { disabled: true }, 'Save draft'));
  const button = container.querySelector('button');

  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), null);
});

test('the button is a no-op for clicks while busy', async () => {
  let submits = 0;
  const container = await render(
    React.createElement(
      'form',
      {
        onSubmit: (event) => {
          event.preventDefault();
          submits += 1;
        }
      },
      React.createElement(SubmitButton, { loading: true }, 'Save draft')
    )
  );

  await click(container.querySelector('button'));
  assert.equal(submits, 0);
});

/* ------------------------------------------------------------------ *
 * GoogleSignInButton
 *
 * Two jsdom gaps to bridge. jsdom has no layout, so `clientWidth` is stubbed on
 * the prototype to return whatever viewport width the test is simulating. And
 * jsdom never fetches https://accounts.google.com/gsi/client, so the component
 * would wait forever for that script's `load` event: a `data-google-identity`
 * script tag is planted first, which puts the component on the "script already
 * present" branch where it renders immediately.
 * ------------------------------------------------------------------ */

let layoutWidth = 0;

Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return layoutWidth;
  }
});

const googleCalls = [];

const stubGoogleIdentity = () => {
  googleCalls.length = 0;
  dom.window.google = {
    accounts: {
      id: {
        initialize: (config) => googleCalls.push(['initialize', config]),
        renderButton: (node, options) => googleCalls.push(['renderButton', options])
      }
    }
  };
  const script = dom.window.document.createElement('script');
  script.dataset.googleIdentity = 'true';
  dom.window.document.head.appendChild(script);
};

const lastRenderOptions = () => {
  const render = googleCalls.filter(([name]) => name === 'renderButton').pop();
  assert.ok(render, 'expected the Google button to be rendered');
  return render[1];
};

const mountGoogleButton = async (width) => {
  layoutWidth = width;
  stubGoogleIdentity();
  return render(React.createElement(GoogleSignInButton, { onCredential() {}, onError() {} }));
};

test('the Google button never renders wider than its column', async () => {
  // 288px is the usable width inside the auth card on a 320px phone.
  await mountGoogleButton(288);

  assert.ok(lastRenderOptions().width <= 288, 'a 360px iframe would force a horizontal scrollbar');
});

test('the Google button still uses the full 360px when there is room', async () => {
  await mountGoogleButton(480);

  assert.equal(lastRenderOptions().width, 360);
});

test('a very narrow column clamps up to the 180px minimum', async () => {
  await mountGoogleButton(120);

  assert.equal(lastRenderOptions().width, 180);
});

test('the Google button picks a palette that reads on the current theme', async () => {
  dom.window.document.documentElement.classList.remove('dark');
  await mountGoogleButton(400);
  assert.equal(lastRenderOptions().theme, 'outline');

  // The component watches the class the theme provider toggles on <html>, so a
  // theme switch re-renders the button without a reload.
  await act(async () => {
    dom.window.document.documentElement.classList.add('dark');
  });

  assert.equal(lastRenderOptions().theme, 'filled_black');

  dom.window.document.documentElement.classList.remove('dark');
});
