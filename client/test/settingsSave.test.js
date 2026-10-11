'use strict';

// Regression guard for the Settings page's Save control.
//
// The defect this exists for: `Settings.js` defined a `save()` handler but
// rendered its Save control through `SubmitButton`, which defaults to
// `type="submit"`, in a page that had no `<form>`. A submit button outside a
// form submits nothing and calls no handler, so `save()` was dead code and
// every preference toggle was silently discarded - the "Settings saved" toast
// could never appear.
//
// Same zero-install harness as controls.test.js: jsdom plus the Babel require
// hook, mounting the real page and clicking the real button.

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
const API = require('../src/services/api').default;
const { AuthContext } = require('../src/context/AuthContext');
const Settings = require('../src/pages/Settings').default;

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

const buttonByText = (container, pattern) =>
  [...container.querySelectorAll('button')].find((button) => pattern.test(button.textContent));

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

test('the Settings Save control persists the edited preferences', async () => {
  const calls = [];
  const originalPut = API.put;
  API.put = async (...args) => {
    calls.push(args);
    return { data: { preferences: args[1].preferences } };
  };

  try {
    const user = {
      name: 'Ada Lovelace',
      role: 'Admin',
      email: 'ada@ricoz.test',
      preferences: { emailNotifications: true, approvalReminders: true, expiryAlerts: true }
    };
    const value = { user, updateProfile: () => {} };

    const container = await render(
      React.createElement(AuthContext.Provider, { value }, React.createElement(Settings))
    );

    const saveButton = buttonByText(container, /save settings/i);
    assert.ok(saveButton, 'the Save settings button is missing');

    // Flip one preference so there is a real change to persist.
    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Email notifications'
    );
    assert.ok(toggle, 'the email notifications toggle is missing');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'the toggle did not change');

    await click(saveButton);

    assert.equal(calls.length, 1, 'clicking Save settings must send the preferences to the server');
    assert.equal(calls[0][0], '/users/me', 'the Save control must PUT the profile endpoint');
    assert.equal(calls[0][1].preferences.emailNotifications, false, 'the edited preference was not sent');
  } finally {
    API.put = originalPut;
  }
});
