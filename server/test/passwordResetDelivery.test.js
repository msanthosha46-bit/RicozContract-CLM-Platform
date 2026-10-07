// End-to-end regression tests for password-reset delivery through the HTTP API.
//
// These cover the failure that was reported from Render: "Password reset email
// could not be sent: Connection timeout". The route is driven over HTTP against
// a real database while the two transports are faked at the socket and
// Nodemailer boundary, so the whole path is exercised: request, token storage,
// transport selection, delivery, and the failure logging.
//
// The suite needs its own app instance and its own database because
// /forgot-password is rate limited to five requests per fifteen minutes and the
// auth suite already spends that budget.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const mongoose = require('mongoose');

// Load server/.env so JWT_SECRET and GOOGLE_CLIENT_ID are available in tests.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
}
if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const User = require('../models/User');
const authRoutes = require('../routes/authRoutes');
const { hashResetToken } = require('../utils/passwordReset');
const { withEmailEnv } = require('./helpers/emailEnv');
const { stubHttps, stubSmtp } = require('./helpers/emailTransports');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_email_delivery_test';

const EMAIL = 'delivered@ricoz.test';
const PASSWORD = 'Secret123!';
const RESEND_KEY = 're_testonlykey0123456789abcdef';
const RESET_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const NEUTRAL_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

const withResend = (extra, fn) =>
  withEmailEnv(
    {
      RESEND_API_KEY: RESEND_KEY,
      EMAIL_FROM: 'RicozContract <no-reply@ricozcontract.local>',
      CLIENT_URL: 'https://app.ricoz.test',
      ...extra
    },
    fn
  );

let server;
let baseURL;

const api = async (method, url, body) => {
  const response = await fetch(baseURL + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  return { status: response.status, data };
};

// The stored token as /reset-password looks it up, which is the definition of
// "this reset link still works".
const findResettableUser = (rawToken) =>
  User.findOne({
    email: EMAIL,
    passwordResetToken: hashResetToken(rawToken),
    passwordResetExpires: { $gt: new Date() }
  }).select('+passwordResetToken +passwordResetExpires');

// Captures what the route writes to console.error while fn runs.
const captureConsoleError = async (fn) => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
};

test.before(async () => {
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET must be set in server/.env to run these tests');
  assert.ok(process.env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID must be set in server/.env to run these tests');

  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  await User.create({ name: 'Delivery Test', email: EMAIL, password: PASSWORD, role: 'Employee' });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('a password reset is delivered through the Resend API when its key is set', async () => {
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"resend-message-id"}' }));
  const smtpStub = stubSmtp(() => {
    assert.fail('SMTP must not be used while the Resend key is configured');
  });

  let response;
  const logged = await captureConsoleError(async () => {
    try {
      response = await withResend({}, () => api('POST', '/api/auth/forgot-password', { email: EMAIL }));
    } finally {
      httpsStub.restore();
      smtpStub.restore();
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.message, NEUTRAL_MESSAGE);
  assert.deepEqual(logged, [], `a delivered reset must log nothing: ${logged.join(' ')}`);

  assert.equal(httpsStub.calls.length, 1, 'exactly one Resend call per reset request');
  const { payload } = httpsStub.calls[0];
  const rawToken = new URL(payload.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
  assert.ok(rawToken && rawToken.length === 64, 'the emailed link must carry a real token');
  assert.equal(payload.from, 'RicozContract <no-reply@ricozcontract.local>');
  assert.deepEqual(payload.to, [EMAIL]);

  const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken +passwordResetExpires');
  assert.equal(user.passwordResetToken, hashResetToken(rawToken));
  assert.ok(await findResettableUser(rawToken), 'the emailed link must be usable');
});

test('SMTP carries the reset when the Resend send fails', async () => {
  const httpsStub = stubHttps(({ respond }) => respond({ status: 500, body: '{"message":"internal error"}' }));
  const smtpStub = stubSmtp();

  let response;
  const logged = await captureConsoleError(async () => {
    try {
      response = await withResend({ SMTP_HOST: 'smtp.example.com' }, () =>
        api('POST', '/api/auth/forgot-password', { email: EMAIL })
      );
    } finally {
      httpsStub.restore();
      smtpStub.restore();
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(logged, [], 'a delivered fallback must log nothing');
  assert.equal(httpsStub.calls.length, 1, 'the Resend attempt still happens first');
  assert.equal(smtpStub.delivered.length, 1, 'the fallback must send exactly once');

  const rawToken = new URL(
    smtpStub.delivered[0].text.match(/https:\/\/\S+/)[0]
  ).searchParams.get('token');
  assert.ok(await findResettableUser(rawToken), 'the fallback link must be usable');
});

test('a failed send leaves the reset token valid and logs nothing sensitive', async () => {
  // The reported incident: the transport could not be reached. The response must
  // not reveal it, the token must stay usable, and the single log line must
  // carry neither the token, the reset link, the API key nor the address.
  const httpsStub = stubHttps(({ respond }) => respond({ status: 500, body: '{"message":"internal error"}' }));
  // The fallback is reached with the real message, so the link of the token that
  // could not be delivered is known here even though the send then fails.
  let attemptedLink = null;
  const smtpStub = stubSmtp(async (message) => {
    attemptedLink = message.text.match(/https:\/\/\S+/)[0];
    const error = new Error(`550 5.1.1 ${EMAIL}: mailbox unavailable`);
    error.code = 'EENVELOPE';
    throw error;
  });

  let response;
  let logged;
  try {
    logged = await captureConsoleError(async () => {
      response = await withResend(
        {
          SMTP_HOST: 'smtp.example.com',
          SMTP_USER: 'mailer@ricoz.test',
          SMTP_PASSWORD: 'smtp-secret'
        },
        () => api('POST', '/api/auth/forgot-password', { email: EMAIL })
      );
    });
  } finally {
    httpsStub.restore();
    smtpStub.restore();
  }

  assert.equal(response.status, 200);
  assert.equal(response.data.message, NEUTRAL_MESSAGE, 'delivery failure must not be visible to the caller');

  assert.equal(logged.length, 1, `the failure must be reported once, got: ${logged.join(' ')}`);
  const line = logged[0];
  assert.match(line, /Password reset email could not be sent/);
  assert.match(line, /EMAIL_SEND_FAILED/);
  assert.match(line, /resend\(RESEND_HTTP_ERROR HTTP 500\)/);
  assert.match(line, /smtp\(EENVELOPE\)/);
  for (const secret of [RESET_TOKEN, EMAIL, RESEND_KEY, 'smtp-secret']) {
    assert.ok(!line.includes(secret), `"${secret}" leaked into the log line: ${line}`);
  }

  // The token that could not be delivered must still be stored and unexpired, so
  // a later retry or a working transport can still use it.
  const rawToken = new URL(attemptedLink).searchParams.get('token');
  assert.ok(rawToken && rawToken.length === 64, 'the failed attempt still used a real token');
  const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken +passwordResetExpires');
  assert.equal(user.passwordResetToken, hashResetToken(rawToken), 'a failed send must not clear or change the token');
  assert.ok(user.passwordResetExpires.getTime() > Date.now(), 'a failed send must not shorten the expiry');
  assert.ok(await findResettableUser(rawToken), 'a reset link whose email failed to send must still be accepted');
});
