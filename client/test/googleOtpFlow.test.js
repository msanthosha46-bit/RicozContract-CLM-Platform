'use strict';

// Behaviour tests for the Google sign-in email-code flow:
//
//   1. OtpVerification itself: six digit boxes, paste, focus movement, the
//      disabled state until all six digits exist, the server's error message
//      after a bad code, and the resend cooldown.
//
//   2. The Login and Register pages end to end: credential -> masked email +
//      challenge (no session yet) -> code -> session + navigation. The pages
//      drive the real AuthContext against a stubbed HTTP layer, so these tests
//      assert the security property directly: localStorage stays empty until
//      the code verifies.
//
//   3. Source-level checks for the wiring that jsdom cannot reach (the Google
//      Identity Services popup), following the passwordInput.test.js precedent:
//      this repository has no browser runner, so the real component runs in
//      jsdom with a require hook that transpiles src/*.js with the Babel
//      presets react-scripts already ships. Nothing is installed.

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

// ---- HTTP stub, installed before AuthContext is loaded so the real context ----
// ---- runs every Google call through this one place.                        ----

const calls = [];
let beginFailure = null;
let verifyFailure = null;

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

const API = {
  async post(url, body) {
    calls.push({ url, body });
    if (url === '/auth/google/begin') {
      if (beginFailure) throw beginFailure;
      return {
        data: { challengeId: 'ch-1', email: 'g***@ricoz.test', expiresIn: 300, resendAvailableIn: 60 }
      };
    }
    if (url === '/auth/google/verify-otp') {
      if (verifyFailure) throw verifyFailure;
      return {
        data: {
          _id: 'u1',
          name: 'Google New',
          email: 'google.new@ricoz.test',
          role: 'Employee',
          status: 'Active',
          token: 'jwt-token'
        }
      };
    }
    if (url === '/auth/google/resend-otp') {
      return { data: { message: 'New verification code sent.', resendAvailableIn: 60 } };
    }
    throw new Error(`unexpected POST ${url}`);
  },
  get() {
    throw new Error('unexpected GET');
  }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

stub('services/api.js', { __esModule: true, default: API });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route } = require('react-router-dom');
const { AuthContext, AuthProvider } = require('../src/context/AuthContext');
const OtpVerification = require('../src/components/OtpVerification').default;
const Login = require('../src/pages/Login').default;
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

/** Drives a controlled input the way a user would: native setter plus input event. */
const typeInto = async (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

const click = (element) => {
  assert.ok(element, 'expected the element to be in the document');
  return act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const submitForm = async (form) => {
  assert.ok(form, 'expected a form in the document');
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
};

const pasteInto = async (element, text) => {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  await act(async () => {
    element.dispatchEvent(event);
  });
};

const digitInputs = (container) => [...container.querySelectorAll('input[aria-label^="Verification digit"]')];
const submitButton = (container) => container.querySelector('button[type="submit"]');
const alertBox = (container) => container.querySelector('[role="alert"]');
const statusBox = (container) => container.querySelector('[role="status"]');
const byText = (container, pattern) =>
  [...container.querySelectorAll('button')].find((button) => pattern.test(button.textContent));

test.beforeEach(() => {
  calls.length = 0;
  beginFailure = null;
  verifyFailure = null;
  dom.window.document.body.innerHTML = '';
  dom.window.localStorage.removeItem('ricoz_user');
});

test.afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  dom.window.document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Part 1: the OtpVerification component
// ---------------------------------------------------------------------------

const renderOtp = (props = {}) =>
  render(
    React.createElement(OtpVerification, {
      challengeId: 'ch-1',
      email: 'g***@ricoz.test',
      expiresIn: 300,
      resendAvailableIn: 60,
      onVerify: async () => {},
      onResend: async () => ({ message: 'A new verification code has been sent.' }),
      onBack: () => {},
      ...props
    })
  );

test('the code screen names the masked address and offers exactly six digit boxes', async () => {
  const container = await renderOtp();

  assert.equal(digitInputs(container).length, 6, 'six boxes, one per digit');
  assert.match(container.textContent, /g\*\*\*@ricoz\.test/, 'the masked address must be visible');
  assert.match(container.textContent, /expires in 5 minutes/);
  assert.match(container.textContent, /Resend code in 1:00/, 'the cooldown starts at the server value');
  assert.equal(byText(container, /Resend code/), undefined, 'no resend control during the cooldown');
  assert.ok(byText(container, /Use a different account/));
});

test('Verify stays disabled until all six digits are entered', async () => {
  const container = await renderOtp();
  const digits = digitInputs(container);

  assert.equal(submitButton(container).disabled, true, 'an incomplete code cannot be sent');

  for (let index = 0; index < 5; index += 1) {
    await typeInto(digits[index], String(index + 1));
  }
  assert.equal(submitButton(container).disabled, true, 'five digits is still not a code');

  await typeInto(digits[5], '6');
  assert.equal(submitButton(container).disabled, false, 'six digits enables Verify');
});

test('typing advances to the next box and Backspace steps back', async () => {
  const container = await renderOtp();
  const digits = digitInputs(container);

  await typeInto(digits[0], '4');
  assert.equal(dom.window.document.activeElement, digits[1], 'typing moves focus forward');

  // Box 2 is empty, so Backspace should retreat instead of deleting nothing.
  await act(async () => {
    digits[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  });
  assert.equal(dom.window.document.activeElement, digits[0], 'Backspace on an empty box steps back');
});

test('a paste of six digits fills every box and enables Verify', async () => {
  const container = await renderOtp();
  const digits = digitInputs(container);

  await pasteInto(digits[0], '654321');

  assert.deepEqual(digitInputs(container).map((input) => input.value).join(''), '654321');
  assert.equal(submitButton(container).disabled, false);
});

test('a successful Verify sends exactly the six digits and nothing else', async () => {
  const seen = [];
  const container = await renderOtp({
    onVerify: async (otp) => {
      seen.push(otp);
    }
  });
  const digits = digitInputs(container);

  for (let index = 0; index < 6; index += 1) {
    await typeInto(digits[index], String(index + 1));
  }
  await submitForm(container.querySelector('form'));

  assert.deepEqual(seen, ['123456']);
  assert.equal(alertBox(container), null, 'a successful verify raises no error');
});

test('a rejected code shows the server message and creates no session', async () => {
  const container = await renderOtp({
    onVerify: async () => {
      throw httpError(400, 'Invalid verification code. Please try again.');
    }
  });
  const digits = digitInputs(container);

  for (let index = 0; index < 6; index += 1) {
    await typeInto(digits[index], '0');
  }
  await submitForm(container.querySelector('form'));

  assert.match(alertBox(container).textContent, /Invalid verification code/);
  assert.equal(dom.window.localStorage.getItem('ricoz_user'), null, 'no session may exist after a failed code');
});

test('Resend appears only once the cooldown has elapsed, then announces itself', async () => {
  let resendCount = 0;
  const container = await renderOtp({
    resendAvailableIn: 0,
    onResend: async () => {
      resendCount += 1;
      return { message: 'New verification code sent.' };
    }
  });

  const resend = byText(container, /Resend code/);
  assert.ok(resend, 'the resend control exists once the cooldown is over');

  await click(resend);
  assert.equal(resendCount, 1);
  assert.match(statusBox(container).textContent, /New verification code sent/);
  assert.deepEqual(digitInputs(container).map((input) => input.value).join(''), '', 'a new code clears the boxes');
});

test('a throttled resend surfaces the server 429 message', async () => {
  const container = await renderOtp({
    resendAvailableIn: 0,
    onResend: async () => {
      throw httpError(429, 'Please wait before requesting another verification code.');
    }
  });

  await click(byText(container, /Resend code/));

  assert.match(alertBox(container).textContent, /Please wait/);
});

test('"Use a different account" hands control back to the page', async () => {
  let backedOut = 0;
  const container = await renderOtp({
    onBack: () => {
      backedOut += 1;
    }
  });

  await click(byText(container, /Use a different account/));
  assert.equal(backedOut, 1);
});

// ---------------------------------------------------------------------------
// Part 2: the Login and Register pages, credential through to session
// ---------------------------------------------------------------------------

// The Google Identity Services script never loads in jsdom, so the test
// pre-seeds both the script tag (so the component finds an "existing" script
// and renders immediately) and the `window.google` object it talks to. The
// captured callback is then fired exactly as the real popup would fire it.
let gsiCallback = null;

const installGoogleIdentity = () => {
  if (!dom.window.document.querySelector('script[data-google-identity]')) {
    const script = dom.window.document.createElement('script');
    script.dataset.googleIdentity = 'true';
    dom.window.document.head.appendChild(script);
  }
  dom.window.google = {
    accounts: {
      id: {
        initialize: (options) => {
          gsiCallback = options.callback;
        },
        renderButton: () => {}
      }
    }
  };
};

const mountAuthPage = async (Page) => {
  installGoogleIdentity();
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/entry'] },
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/entry', element: React.createElement(Page) }),
          React.createElement(Route, {
            path: '/dashboard',
            element: React.createElement('div', { 'data-testid': 'dashboard' })
          })
        )
      )
    )
  );
};

const fireCredential = async (credential) => {
  assert.ok(gsiCallback, 'the Google button must have registered its callback');
  await act(async () => {
    await gsiCallback({ credential });
  });
  await settle();
};

const typeCode = async (container, code) => {
  const digits = digitInputs(container);
  assert.equal(digits.length, 6, 'the code screen must be showing');
  for (let index = 0; index < 6; index += 1) {
    await typeInto(digits[index], code[index]);
  }
};

test('Login: credential -> masked code screen with no session, code -> session and dashboard', async () => {
  const container = await mountAuthPage(Login);

  assert.ok(container.querySelector('#login-email'), 'the password form shows first');
  assert.equal(digitInputs(container).length, 0);

  await fireCredential('id-token-1');

  assert.deepEqual(
    calls.map((call) => call.url),
    ['/auth/google/begin'],
    'the credential goes to the begin endpoint only'
  );
  assert.equal(calls[0].body.credential, 'id-token-1');
  assert.match(container.textContent, /g\*\*\*@ricoz\.test/);
  assert.equal(
    dom.window.localStorage.getItem('ricoz_user'),
    null,
    'the credential alone must not create a session'
  );

  await typeCode(container, '123456');
  await submitForm(container.querySelector('form'));

  const verify = calls.find((call) => call.url === '/auth/google/verify-otp');
  assert.ok(verify, 'the code goes to the verify endpoint');
  assert.equal(verify.body.challengeId, 'ch-1');
  assert.equal(verify.body.otp, '123456');

  assert.equal(
    JSON.parse(dom.window.localStorage.getItem('ricoz_user')).token,
    'jwt-token',
    'the session is written only after the code verifies'
  );
  assert.ok(container.querySelector('[data-testid="dashboard"]'), 'a verified code lands on the dashboard');
});

test('Login: a rejected credential stays on the form with the server message', async () => {
  beginFailure = httpError(401, 'Google Sign-In could not be verified');
  const container = await mountAuthPage(Login);

  await fireCredential('bad-token');

  assert.match(alertBox(container).textContent, /Google Sign-In could not be verified/);
  assert.equal(digitInputs(container).length, 0, 'no code screen without a verified identity');
  assert.equal(dom.window.localStorage.getItem('ricoz_user'), null);
});

test('Register: the same two-step flow, and backing out returns to the form', async () => {
  const container = await mountAuthPage(Register);

  assert.ok(container.querySelector('#register-name'), 'the registration form shows first');

  await fireCredential('id-token-2');
  assert.deepEqual(calls.map((call) => call.url), ['/auth/google/begin']);
  assert.equal(digitInputs(container).length, 6, 'the code screen replaces the form');
  assert.equal(dom.window.localStorage.getItem('ricoz_user'), null);

  await click(byText(container, /Use a different account/));
  assert.ok(container.querySelector('#register-name'), 'back returns to the form');
  assert.equal(calls.length, 1, 'backing out fires no further requests');

  // And the code still completes the flow when entered.
  await fireCredential('id-token-2');
  await typeCode(container, '987654');
  await submitForm(container.querySelector('form'));

  const verify = calls.find((call) => call.url === '/auth/google/verify-otp');
  assert.equal(verify.body.otp, '987654');
  assert.equal(JSON.parse(dom.window.localStorage.getItem('ricoz_user')).token, 'jwt-token');
  assert.ok(container.querySelector('[data-testid="dashboard"]'));
});

// ---------------------------------------------------------------------------
// Part 3: source-level checks for the wiring jsdom cannot reach
// ---------------------------------------------------------------------------

const read = (...segments) => fs.readFileSync(path.join(SRC, ...segments), 'utf8');

test('AuthContext persists a session only on the verify step, never on begin or resend', () => {
  const source = read('context', 'AuthContext.js');

  assert.match(source, /API\.post\('\/auth\/google\/begin'/);
  assert.match(source, /API\.post\('\/auth\/google\/verify-otp'/);
  assert.match(source, /API\.post\('\/auth\/google\/resend-otp'/);
  assert.doesNotMatch(
    source,
    /API\.post\('\/auth\/google'/,
    'the pre-OTP endpoint must not survive: it would issue a JWT without a code'
  );

  const beginBody = source.slice(source.indexOf('const beginGoogleOtp'), source.indexOf('// Step 2'));
  const verifyBody = source.slice(source.indexOf('const verifyGoogleOtp'), source.indexOf('// Step 3'));
  const resendBody = source.slice(source.indexOf('const resendGoogleOtp'), source.indexOf('const updateProfile'));

  assert.doesNotMatch(beginBody, /persistUser/, 'begin must not write a session');
  assert.doesNotMatch(resendBody, /persistUser/, 'resend must not write a session');
  assert.match(verifyBody, /persistUser/, 'verify is the only Google step that writes a session');

  const writtenKeys = [...source.matchAll(/localStorage\.setItem\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(writtenKeys, ['ricoz_user'], 'nothing but the user object is ever written');

  const touchedKeys = [...source.matchAll(/localStorage\.\w+\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(
    touchedKeys.every((key) => key === 'ricoz_user'),
    `only the user object may be read, written or removed: ${touchedKeys.join(', ')}`
  );
});

test('Login and Register replace the form with the code screen and navigate only after verify', () => {
  for (const page of ['Login.js', 'Register.js']) {
    const source = read('pages', page);

    assert.match(source, /<OtpVerification/, `${page} must render the code screen`);
    assert.match(source, /setGoogleStep\(step\)/, `${page} must store the begin response`);
    assert.match(source, /beginGoogleOtp\(credential\)/, `${page} must start with begin`);
    assert.doesNotMatch(source, /loginWithGoogle/, `${page} must not use the removed direct login`);

    const handlerBody = source.slice(
      source.indexOf('const handleOtpVerify'),
      source.indexOf('const handleOtpResend')
    );
    assert.match(handlerBody, /await verifyGoogleOtp\(/, `${page} must call verifyGoogleOtp`);
    assert.match(handlerBody, /navigate\('\/dashboard'/, `${page} must navigate after verifying`);
    assert.ok(
      handlerBody.indexOf('await verifyGoogleOtp') < handlerBody.indexOf("navigate('/dashboard'"),
      `${page} must navigate only after the code verified, never before`
    );

    for (const prop of ['challengeId', 'email', 'expiresIn', 'resendAvailableIn']) {
      assert.match(source, new RegExp(`${prop}=\\{googleStep\\.${prop}\\}`), `${page} must pass ${prop} through`);
    }
  }
});

test('the code screen keeps the code out of web storage and never invents it randomly', () => {
  const source = read('components', 'OtpVerification.js');

  assert.doesNotMatch(source, /localStorage|sessionStorage/, 'the code screen must not touch web storage');
  assert.match(source, /role="alert"/, 'errors must be announced to assistive technology');
  assert.match(source, /aria-live/, 'the resend notice must be announced');

  const authSource = read('context', 'AuthContext.js');
  assert.doesNotMatch(authSource, /Math\.random/, 'the client never generates the code itself');
});
