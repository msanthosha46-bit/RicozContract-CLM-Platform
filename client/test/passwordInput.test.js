'use strict';

// Behaviour tests for PasswordInput, the control that guards every password on
// the authentication pages (Login, Register, ResetPassword).
//
// Two things are covered:
//
//   1. The show/hide toggle. It has to mask by default, flip the input type
//      both ways, describe its own state to assistive technology, and leave the
//      typed value alone.
//
//   2. The focus indicator on the toggle button. This is a real regression guard
//      for an invisible focus ring, measured in headless Chrome against the
//      production build before the fix:
//
//        /login        button:focus-visible  outline 2px solid rgba(0,0,0,0)
//        /register     button:focus-visible  outline 2px solid rgba(0,0,0,0)
//        /reset-password?token=...  button:focus-visible  outline 2px solid rgba(0,0,0,0)
//        (all three after the fix)      outline 2px solid rgb(213, 29, 41)
//
//      The cause was the `outline-none` utility on the button. index.css paints
//      the keyboard focus ring with a bare `:focus-visible` rule, and Tailwind's
//      `outline-none` is emitted later at the same specificity, so it replaced
//      the brand-red outline with `2px solid transparent` -- a ring with no
//      colour. The button had no `focus:ring-*` fallback to fall back on, which
//      is why removing the utility was enough and why that is asserted below
//      rather than assumed.
//
//      Same approach as landingContrast.test.js and statusBadge.test.js: read the
//      real classNames out of the source and reason about the cascade, because
//      this repository has no browser test runner.

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
  'HTMLInputElement',
  'HTMLButtonElement',
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
const PasswordInput = require('../src/components/PasswordInput').default;

const mounted = [];

const render = async (props = {}) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  mounted.push(reactRoot);
  await act(async () => {
    reactRoot.render(React.createElement(PasswordInput, { id: 'pw', name: 'password', ...props }));
  });
  return container;
};

const unmountAll = async () => {
  for (const reactRoot of mounted.splice(0)) {
    await act(async () => {
      reactRoot.unmount();
    });
  }
};

const click = (element) =>
  act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });

/** Drives a controlled input the way a user would: native setter plus input event. */
const typeInto = async (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

/** A harness that mirrors what each page passes, so state survives the toggle. */
const Stateful = ({ initial = '', onValue }) => {
  const [value, setValue] = React.useState(initial);
  return React.createElement(PasswordInput, {
    id: 'pw',
    name: 'password',
    value,
    onChange: (event) => {
      setValue(event.target.value);
      if (onValue) onValue(event.target.value);
    }
  });
};

const renderStateful = async (props = {}) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  mounted.push(reactRoot);
  await act(async () => {
    reactRoot.render(React.createElement(Stateful, props));
  });
  return container;
};

test.beforeEach(() => {
  dom.window.document.body.innerHTML = '';
});

test.afterEach(async () => {
  await unmountAll();
  dom.window.document.body.innerHTML = '';
});

test('the password is masked until the toggle is used', async () => {
  const container = await render();
  const input = container.querySelector('input');

  assert.equal(input.type, 'password');
  assert.equal(
    container.querySelector('button').getAttribute('aria-pressed'),
    'false',
    'a first render must not leave the password revealed'
  );
});

test('the toggle is a real button, so it cannot submit the form', async () => {
  const container = await render();
  const button = container.querySelector('button');

  // Without type="button" a button inside a <form> submits on activation, which
  // would post the login or reset form just to reveal the password.
  assert.equal(button.getAttribute('type'), 'button');
});

test('the toggle flips the input type in both directions', async () => {
  const container = await render();
  const input = container.querySelector('input');
  const button = container.querySelector('button');

  await click(button);
  assert.equal(input.type, 'text');

  await click(button);
  assert.equal(input.type, 'password');
});

test('the toggle reports the action it will perform, not just "button"', async () => {
  const container = await render();
  const button = container.querySelector('button');

  assert.equal(button.getAttribute('aria-label'), 'Show password');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.title, 'Show password');

  await click(button);

  assert.equal(button.getAttribute('aria-label'), 'Hide password');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.title, 'Hide password');
});

test('revealing the password keeps what was typed', async () => {
  const seen = [];
  const container = await renderStateful({ onValue: (v) => seen.push(v) });
  const input = container.querySelector('input');
  const button = container.querySelector('button');

  await typeInto(input, 'Secret123');
  assert.equal(seen.at(-1), 'Secret123');

  await click(button);
  assert.equal(input.value, 'Secret123', 'the value must survive the type change');
  assert.equal(input.type, 'text');

  await click(button);
  assert.equal(input.value, 'Secret123');
  assert.equal(input.type, 'password');
});

test('each page keeps its own id and autocomplete on the field', async () => {
  // Login, Register and ResetPassword all delegate to this component, so the
  // props they rely on have to survive the wrapper rather than be hardcoded here.
  const container = await render({ id: 'reset-password', autoComplete: 'new-password', minLength: '6', required: true });
  const input = container.querySelector('input');

  assert.equal(input.id, 'reset-password');
  assert.equal(input.getAttribute('autocomplete'), 'new-password');
  assert.equal(input.getAttribute('minlength'), '6');
  assert.equal(input.required, true);
});

test('the toggle button does not suppress the global focus ring', async () => {
  const container = await render();
  const className = container.querySelector('button').className;

  // The defect. `outline-none` compiles to `outline: 2px solid transparent` and
  // is emitted after index.css's `:focus-visible` rule at equal specificity, so
  // it wins and the ring renders invisible. `focus:outline-none` is included
  // because that variant would cause the same thing on keyboard focus.
  assert.doesNotMatch(
    className,
    /(?:^|\s)(?:focus:)?outline-none(?:\s|$)/,
    `the toggle must not paint a transparent outline: "${className}"`
  );
});

test('the focus ring the toggle relies on is still defined and still visible', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  const rule = css.match(/:focus-visible\s*\{([^}]*)\}/);

  assert.ok(rule, 'index.css must keep painting a keyboard focus ring');
  assert.match(rule[1], /outline\s*:/, 'the :focus-visible rule must set an outline');
  assert.doesNotMatch(
    rule[1],
    /transparent|currentColor/i,
    'a transparent or currentColor outline is not a visible focus indicator'
  );
});

test('the toggle has no focus fallback of its own, so the global ring is load-bearing', () => {
  const source = fs.readFileSync(path.join(SRC, 'components', 'PasswordInput.js'), 'utf8');
  const buttonClass = source.match(/className="([^"]*)"/g).pop().match(/className="([^"]*)"/)[1];

  // Every other focusable field in the app pairs `outline-none` with a
  // `focus:ring-*` or `focus:border-*` affordance. The toggle has neither, so
  // the global `:focus-visible` outline is its only focus indicator. If a future
  // change adds a fallback, this assertion should be revisited rather than left
  // to fail for the wrong reason.
  assert.doesNotMatch(buttonClass, /(?:^|\s)focus:(?:ring|border)-/, buttonClass);
  assert.doesNotMatch(buttonClass, /(?:^|\s)(?:focus:)?outline-none(?:\s|$)/, buttonClass);
});
