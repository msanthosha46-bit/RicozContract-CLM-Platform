'use strict';

// Issue 43 regression: what a user actually sees on the register form.
//
// The server deliberately answers one generic message when the submitted email
// already has an account (anti-enumeration at authRoutes.js:124), which looks
// exactly like a broken registration. A brand-new email registers fine. The
// fix must keep the server response opaque but turn the dead end into a
// usable path — a sign-in hint that never reveals whether the email exists.
//
// These tests drive the real Register page and AuthContext against the stubbed
// HTTP layer, following the googleOtpFlow.test.js harness (jsdom + Babel hook,
// nothing installed).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');
const PAGE = path.join(SRC, 'pages', 'Register.js');

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
  'HTMLFormElement',
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

// ---- HTTP stub, installed before AuthContext loads so the real context ----
// ---- routes the register call through this one place.                  ----

const calls = [];
let registerReply = null; // set to { data } or an httpError

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

const API = {
  async post(url, body) {
    calls.push({ url, body });
    if (registerReply instanceof Error) throw registerReply;
    return { data: registerReply };
  },
  get() {
    throw new Error('unexpected GET');
  },
  put() {
    throw new Error('unexpected PUT');
  },
  delete() {
    throw new Error('unexpected DELETE');
  }
};

// api.js is the only import AuthContext uses, so stubbing it keeps the
// register call inside the one stub above.
const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};
stub('services/api.js', { __esModule: true, default: API });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route } = require('react-router-dom');
const { AuthProvider } = require('../src/context/AuthContext');
const Register = require('../src/pages/Register').default;

const mounted = [];

const settle = () => act(async () => {});

const render = async (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return container;
};

const mountRegister = () =>
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/entry'] },
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/entry', element: React.createElement(Register) }),
          React.createElement(Route, {
            path: '/dashboard',
            element: React.createElement('div', { 'data-testid': 'dashboard' })
          })
        )
      )
    )
  );

// The Register page renders GoogleSignInButton, which sketches the identity
// widget only once window.google exists; install a no-op stand-in.
window.google = {
  accounts: {
    id: { initialize: () => {}, renderButton: () => {} }
  }
};

const typeInto = async (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

const fill = async (container, values) => {
  for (const [selector, value] of Object.entries(values)) {
    const input = container.querySelector(selector);
    assert.ok(input, `expected ${selector} in the document`);
    await typeInto(input, value);
  }
};

const submitForm = async (form) => {
  assert.ok(form, 'expected a form in the document');
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
};

const alertBox = (container) => container.querySelector('[role="alert"]');

test.beforeEach(() => {
  calls.length = 0;
  registerReply = null;
  dom.window.document.body.innerHTML = '';
  dom.window.localStorage.removeItem('ricoz_user');
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  dom.window.document.body.innerHTML = '';
});

const formValues = {
  '#register-name': 'Existing User',
  '#register-email': 'employee@ricoz.test',
  '#register-department': 'Legal',
  '#register-password': 'Secret123!',
  '#register-confirm': 'Secret123!'
};

test('a refused registration shows the generic message with a sign-in hint', async () => {
  registerReply = httpError(400, 'Unable to create an account with those details.');
  const container = await mountRegister();

  await fill(container, formValues);
  await submitForm(container.querySelector('form'));

  const alert = alertBox(container);
  assert.ok(alert, 'the failure must be surfaced in the alert box');
  assert.match(
    alert.textContent,
    /Unable to create an account with those details\.\s+If you already have an account, sign in instead\./
  );

  assert.ok(container.querySelector('#register-name'), 'the form stays put after a refusal');
  assert.equal(dom.window.localStorage.getItem('ricoz_user'), null, 'no session may exist after a refusal');
});

// The hint only ever belongs with the anti-enumeration duplicate-email message.
// Every other rejection is shown verbatim so a rate limit, a validation error,
// a server outage or a lost connection can never be mistaken for an existing
// account.
const expectNoHint = async (reply) => {
  registerReply = reply;
  const container = await mountRegister();

  await fill(container, formValues);
  await submitForm(container.querySelector('form'));

  const alert = alertBox(container);
  assert.ok(alert, 'the failure must be surfaced in the alert box');
  assert.ok(
    !/If you already have an account/.test(alert.textContent),
    'the sign-in hint must not appear for a non-duplicate cause'
  );
  return alert.textContent;
};

test('429 rate limit is shown verbatim without the sign-in hint', async () => {
  const text = await expectNoHint(httpError(429, 'Too many account requests. Please try again in 15 minutes.'));
  assert.equal(text, 'Too many account requests. Please try again in 15 minutes.');
});

test('a registration validation error is shown verbatim without the sign-in hint', async () => {
  const text = await expectNoHint(httpError(400, 'Name is required'));
  assert.equal(text, 'Name is required');
});

test('a server error shows the generic message without the sign-in hint', async () => {
  const text = await expectNoHint(httpError(500, 'Internal server error'));
  assert.equal(text, 'Internal server error');
});

test('a network failure shows the fallback without the sign-in hint', async () => {
  const offline = new Error('Network Error');
  const text = await expectNoHint(offline);
  assert.equal(text, 'Unable to create your account.');
});

test('HTTP 409 preserves its message without the sign-in hint', async () => {
  const text = await expectNoHint(httpError(409, 'A record with the same unique value already exists'));
  assert.equal(text, 'A record with the same unique value already exists');
});

test('the register payload carries only the fields the server defines', async () => {
  registerReply = httpError(400, 'Unable to create an account with those details.');
  const container = await mountRegister();

  await fill(container, formValues);
  await submitForm(container.querySelector('form'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/auth/register');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['department', 'email', 'name', 'password']);
  assert.ok(!('confirmPassword' in calls[0].body), 'the confirm field must never leave the browser');
  assert.ok(!('role' in calls[0].body), 'a role may never be sent by the client');
});

test('a successful registration stores the session and opens the dashboard', async () => {
  registerReply = {
    _id: 'u1',
    name: 'New User',
    email: 'new.user@ricoz.test',
    role: 'Employee',
    status: 'Active',
    token: 'jwt-token'
  };
  const container = await mountRegister();

  await fill(container, formValues);
  await submitForm(container.querySelector('form'));

  assert.equal(alertBox(container), null, 'a success raises no error');
  assert.equal(JSON.parse(dom.window.localStorage.getItem('ricoz_user')).token, 'jwt-token');
  assert.ok(container.querySelector('[data-testid="dashboard"]'), 'the new account lands on the dashboard');
});

test('Register.js surfaces server messages, keeps its own fallback, and sends no role', () => {
  const source = fs.readFileSync(PAGE, 'utf8');

  assert.match(source, /requestError\.response\?\.data\?\.message/, 'the server message is surfaced verbatim');
  assert.match(source, /Unable to create your account\./, 'the client fallback stays distinct from the server wording');
  assert.match(source, /If you already have an account, sign in instead/, 'the actionable hint must be present');
  assert.match(source, /const \{ confirmPassword, \.\.\.payload \} = form/, 'the confirm field is stripped before register()');
  assert.match(source, /await register\(payload\)/, 'only the sanitized payload is sent');
  assert.doesNotMatch(source, /\brole\s*:/, 'Register.js must not construct or send a role');
});