'use strict';

// Issue: the production Obligations page showed the raw backend message
// "Not authorized, token failed" in a dead-end error banner, while the user
// still appeared logged in (localStorage['ricoz_user'] was never cleared and
// nothing sent them back to sign in). The message comes only from
// server/middleware/auth.js when jwt.verify rejects a present Bearer token
// (expired / revoked / malformed / wrong secret) - a legitimate "your session
// is over" answer. The response interceptor is the documented owner of the
// redirect (see issue34ContractForms.test.js: "the interceptor owns the
// redirect to login"), so these tests mount the REAL axios instance and drive
// it with a scripted adapter.
//
// The auth endpoints are deliberately exempt: they answer 401 for wrong
// credentials and bad verification codes, and those must not sign the user out
// or navigate away from the form they are using.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');

const navigations = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (/navigation/i.test(error.message)) navigations.push(error.message);
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.ricoz.test/obligations',
  virtualConsole
});

const expose = (name, value) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

for (const name of [
  'window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage',
  'FormData', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement'
]) expose(name, dom.window[name]);

const loadJavaScript = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(SRC + path.sep)) return loadJavaScript(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }]
    ]
  });
  return module._compile(code, filename);
};

const API = require(path.join(SRC, 'services', 'api.js')).default;
const { AxiosError } = require('axios');

const TOKEN = 'header.payload.signature';

let seenAuthorization;

// A custom axios adapter owns settle/validateStatus, so an error response must
// be rejected with a real AxiosError carrying `response` and `config`.
const respond = (status, data) => async (config) => {
  seenAuthorization = config.headers?.Authorization ?? config.headers?.authorization;
  const response = { status, statusText: String(status), headers: {}, data, config, request: {} };
  return Promise.reject(new AxiosError(data?.message || 'Request failed', AxiosError.ERR_BAD_REQUEST, config, {}, response));
};

const setSession = () => dom.window.localStorage.setItem(
  'ricoz_user',
  JSON.stringify({ _id: 'u1', name: 'Probe', role: 'Employee', token: TOKEN })
);
const hasSession = () => dom.window.localStorage.getItem('ricoz_user') !== null;

test.beforeEach(() => {
  dom.window.localStorage.removeItem('ricoz_user');
  navigations.length = 0;
  seenAuthorization = undefined;
});

test('a 401 from a protected endpoint clears the session and returns the user to /login', async () => {
  setSession();

  await assert.rejects(
    API.get('/obligations', { adapter: respond(401, { message: 'Not authorized, token failed' }) }),
    (error) => {
      assert.equal(error.response.status, 401);
      assert.equal(error.response.data.message, 'Not authorized, token failed');
      return true;
    }
  );

  assert.equal(hasSession(), false, 'the unusable session must be cleared');
  assert.ok(navigations.length >= 1, 'the user must be sent to /login');
});

test('the interceptor does not stop the request from carrying the stored Bearer token', async () => {
  setSession();

  await assert.rejects(
    API.get('/obligations', { adapter: respond(401, { message: 'Not authorized, token failed' }) })
  );

  assert.equal(seenAuthorization, `Bearer ${TOKEN}`, 'the 401 was caused by the token the client sent');
});

test('a 401 from an auth endpoint (wrong password) does not clear the session or navigate', async () => {
  setSession();

  await assert.rejects(
    API.post('/auth/login', { email: 'a@b.test', password: 'nope' },
      { adapter: respond(401, { message: 'Invalid email or password' }) })
  );

  assert.equal(hasSession(), true, 'a failed sign-in must not sign an existing session out');
  assert.equal(navigations.length, 0, 'a failed sign-in must not navigate away from the form');
});

test('a 401 from the other auth endpoints is likewise exempt', async () => {
  setSession();

  await assert.rejects(
    API.post('/auth/google/verify-otp', { challengeId: 'x', otp: '000000' },
      { adapter: respond(401, { message: 'Google Sign-In could not be verified' }) })
  );

  assert.equal(hasSession(), true);
  assert.equal(navigations.length, 0);
});

test('a non-401 failure leaves the session and the page alone', async () => {
  setSession();

  await assert.rejects(
    API.get('/obligations', { adapter: respond(500, { message: 'Internal server error' }) })
  );

  assert.equal(hasSession(), true, 'only an authentication failure ends the session');
  assert.equal(navigations.length, 0);
});

test('the bearer token is still stripped from the rejected error object', async () => {
  setSession();

  try {
    await API.get('/obligations', { adapter: respond(401, { message: 'Not authorized, token failed' }) });
    assert.fail('the request should have been rejected');
  } catch (error) {
    assert.equal(error.config.headers.Authorization, undefined, 'the token must not be serialized into error objects');
  }
});
