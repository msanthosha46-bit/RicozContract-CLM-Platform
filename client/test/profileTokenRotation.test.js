'use strict';

// Regression guard for the client half of session rotation on a password change.
//
// The defect this exists for: when the Profile page changes a password, the
// server now answers `PUT /users/me` with a fresh session token (the password
// change revokes the sessions issued under the old credential, exactly like the
// reset flow). But `AuthContext.updateProfile` was written as
// `persistUser({ ...user, ...data, token: user.token })` - it clobbered any
// token the server returned with the current one, so even a correctly rotated
// token was discarded on the client and the caller was left holding a revoked
// session. It must keep whatever token the server returns and only fall back to
// the current one when the response has none (e.g. a name-only update).
//
// Same zero-install harness as settingsSave.test.js: jsdom plus the Babel
// require hook, the real AuthProvider mounted and driven through the real
// context.

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
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage'
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
const { AuthProvider, AuthContext } = require('../src/context/AuthContext');

const OLD_TOKEN = 'old-session-token';
const ROTATED_TOKEN = 'fresh-session-token';

const mounted = [];

const STORED = {
  _id: 'u-1',
  name: 'Ada Lovelace',
  email: 'ada@ricoz.test',
  role: 'Admin',
  token: OLD_TOKEN
};

const renderProbe = async (payload) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);

  // A probe that re-renders the context token into the DOM and offers a button
  // that performs the exact call the Profile page makes after a save.
  const Probe = () => {
    const { user, updateProfile } = React.useContext(AuthContext);
    return React.createElement(
      'button',
      { onClick: () => updateProfile(payload) },
      user ? user.token : 'no-user'
    );
  };

  await act(async () => {
    root.render(React.createElement(AuthProvider, null, React.createElement(Probe)));
  });
  return container;
};

const clickButton = (container) => act(async () => {
  container.querySelector('button').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  );
});

test.beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('ricoz_user', JSON.stringify(STORED));
  dom.window.document.body.innerHTML = '';
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  dom.window.document.body.innerHTML = '';
  dom.window.localStorage.clear();
});

test('updateProfile keeps a fresh token returned by the server', async () => {
  const container = await renderProbe({
    name: 'Ada Lovelace',
    email: 'ada@ricoz.test',
    role: 'Admin',
    token: ROTATED_TOKEN
  });
  const button = container.querySelector('button');
  assert.ok(button, 'the probe must mount');
  assert.equal(button.textContent, OLD_TOKEN, 'the stored session must be the token set before the save');

  await clickButton(container);

  assert.equal(button.textContent, ROTATED_TOKEN,
    'the rotated token returned by the password change must replace the stored session');
  const stored = JSON.parse(dom.window.localStorage.getItem('ricoz_user'));
  assert.equal(stored.token, ROTATED_TOKEN,
    'localStorage must hold the rotated token so the next request does not carry a revoked session');
});

test('updateProfile keeps the current token when the response returns none', async () => {
  const container = await renderProbe({
    name: 'Renamed',
    email: 'ada@ricoz.test',
    role: 'Admin'
  });
  const button = container.querySelector('button');
  assert.ok(button, 'the probe must mount');
  assert.equal(button.textContent, OLD_TOKEN);

  await clickButton(container);

  assert.equal(button.textContent, OLD_TOKEN,
    'a response without a token (name-only update) must not rotate or clear the session');
  const stored = JSON.parse(dom.window.localStorage.getItem('ricoz_user'));
  assert.equal(stored.token, OLD_TOKEN, 'the unchanged session must stay unchanged');
  assert.equal(stored.name, 'Renamed', 'the profile fields still update');
});