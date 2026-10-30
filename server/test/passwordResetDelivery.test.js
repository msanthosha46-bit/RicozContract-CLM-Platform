// End-to-end regression tests for password-reset delivery through the HTTP API.
//
// These cover the failure that was reported from Render: "Password reset email
// could not be sent: Connection timeout". The route is driven over HTTP against
// a real database while the two transports are faked at the socket and
// Nodemailer boundary, so the whole path is exercised: request, queueing,
// token storage, transport selection, delivery, and the failure logging.
//
// The email is not sent inside the request any more: the request records a
// job and answers at once, and the worker delivers the job afterwards. Every
// test therefore has to wait for the queue to settle before it may look at the
// delivered token, restore the transport stubs or leave the email environment.
//
// The suite needs its own app instance and its own database because
// /forgot-password is rate limited to five requests per fifteen minutes and the
// auth suite already spends that budget.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readFocusedTestConfig } = require('./helpers/testDatabase');
const { mongoUri: TEST_DB_URI, jwtSecret: TEST_JWT_SECRET } = readFocusedTestConfig(process.env, { suiteName: 'password-reset-delivery' });
process.env.JWT_SECRET = TEST_JWT_SECRET;
const express = require('express');
const mongoose = require('mongoose');

// JWT signing uses the explicit test secret and a local test client ID.

if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const User = require('../models/User');
const PasswordResetEmailJob = require('../models/PasswordResetEmailJob');
const authRoutes = require('../routes/authRoutes');
const { hashResetToken } = require('../utils/passwordReset');
const {
  startPasswordResetEmailWorker,
  stopPasswordResetEmailWorker,
  runPasswordResetEmailWorkerPass
} = require('../services/passwordResetEmailQueue');
const { withEmailEnv } = require('./helpers/emailEnv');
const { stubHttps, stubSmtp } = require('./helpers/emailTransports');


const EMAIL = 'delivered@ricoz.test';
const PASSWORD = 'Secret123!';
const RESEND_KEY = 're_testonlykey0123456789abcdef';
const RESET_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const NEUTRAL_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

// The worker polls the queue. In the tests it runs with a short interval so a
// delivery does not slow the suite down.
const WORKER_INTERVAL_MS = 25;

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

const apiOn = async (base, method, url, body) => {
  const response = await fetch(base + url, {
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

const api = async (method, url, body) => apiOn(baseURL, method, url, body);

// /forgot-password is limited to five requests per fifteen minutes and the
// limiter keeps its counters inside the router module, so every test that
// needs its own allowance mounts a freshly required router on its own server.
// The delivered behaviour of the route is identical; only the counters are
// separate.
const createIsolatedAuthServer = async () => {
  const routerPath = require.resolve('../routes/authRoutes');
  delete require.cache[routerPath];
  const isolatedApp = express();
  isolatedApp.use(express.json({ limit: '1mb' }));
  isolatedApp.use('/api/auth', require(routerPath));
  const isolated = isolatedApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => isolated.once('listening', resolve));
  return {
    baseURL: `http://127.0.0.1:${isolated.address().port}`,
    close: () => new Promise((resolve) => isolated.close(resolve))
  };
};

// Waits for a condition that another request makes true, without a fixed sleep.
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// Waits until the queue holds no job that is waiting or in flight. The delivery
// happens after the response, so a test has to wait for the worker before it
// may look at the delivered token or take the transport stubs away.
const waitForQueueToSettle = async (timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await PasswordResetEmailJob.countDocuments({
      status: { $in: ['pending', 'sending'] }
    });
    if (open === 0) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the reset queue to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// The stored token as /reset-password looks it up, which is the definition of
// "this reset link still works".
const findResettableUser = (rawToken) =>
  User.findOne({
    email: EMAIL,
    passwordResetToken: hashResetToken(rawToken),
    passwordResetExpires: { $gt: new Date() }
  }).select('+passwordResetToken +passwordResetExpires');

// Captures what the route and the worker write to console.error while fn runs.
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
  assert.ok(process.env.JWT_SECRET, 'TEST_JWT_SECRET must be explicitly configured');
  assert.ok(process.env.GOOGLE_CLIENT_ID, 'a test GOOGLE_CLIENT_ID must be configured');

  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  await User.create({ name: 'Delivery Test', email: EMAIL, password: PASSWORD, role: 'Employee' });

  await startPasswordResetEmailWorker({ intervalMs: WORKER_INTERVAL_MS });
});

test.after(async () => {
  await stopPasswordResetEmailWorker();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
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
      response = await withResend({}, async () => {
        const result = await api('POST', '/api/auth/forgot-password', { email: EMAIL });
        await waitForQueueToSettle();
        return result;
      });
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
      response = await withResend({ SMTP_HOST: 'smtp.example.com' }, async () => {
        const result = await api('POST', '/api/auth/forgot-password', { email: EMAIL });
        await waitForQueueToSettle();
        return result;
      });
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

test('a failed second request leaves the link the user already received usable', async () => {
  // The regression: a second request replaced the stored token before its email
  // was sent, so a delivery that failed left the user with no working link at
  // all - the first link was gone and the second one was never delivered.
  const isolated = await createIsolatedAuthServer();
  try {
    // First request: the email goes out, so the user holds a working link.
    const deliveredStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"message-first"}' }));
    let firstResponse;
    try {
      firstResponse = await withResend({}, async () => {
        const result = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
        await waitForQueueToSettle();
        return result;
      });
    } finally {
      deliveredStub.restore();
    }

    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.data.message, NEUTRAL_MESSAGE);
    const deliveredToken = new URL(
      deliveredStub.calls[0].payload.text.match(/https:\/\/\S+/)[0]
    ).searchParams.get('token');
    assert.ok(deliveredToken && deliveredToken.length === 64, 'the first email must carry a real token');
    assert.ok(await findResettableUser(deliveredToken), 'the first link must be usable before the second request');

    // Second request: the transport fails, so no second link is ever delivered.
    const failingStub = stubHttps(({ respond }) => respond({ status: 500, body: '{"message":"internal error"}' }));
    let secondResponse;
    const logged = await captureConsoleError(async () => {
      try {
        secondResponse = await withResend({}, async () => {
          const result = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
          await waitForQueueToSettle();
          return result;
        });
      } finally {
        failingStub.restore();
      }
    });

    assert.equal(secondResponse.status, 200);
    assert.equal(secondResponse.data.message, NEUTRAL_MESSAGE, 'a delivery failure must not be visible to the caller');
    assert.equal(logged.length, 1, `the failure must be reported once, got: ${logged.join(' ')}`);

    // The link that was delivered must still be the one the account can use.
    const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken +passwordResetExpires');
    assert.equal(user.passwordResetToken, hashResetToken(deliveredToken),
      'a failed request must not replace the token of a link that was delivered');
    assert.ok(await findResettableUser(deliveredToken), 'the delivered link must still be usable');

    const reset = await apiOn(isolated.baseURL, 'POST', '/api/auth/reset-password', {
      token: deliveredToken,
      password: 'RecoveredPass1!'
    });
    assert.equal(reset.status, 200, 'the delivered link must still reset the password');
    assert.match(reset.data.message, /reset/i);
  } finally {
    await isolated.close();
  }
});

test('a failed first request leaves no undelivered token stored', async () => {
  // A token whose email was never delivered is a link nobody holds, so storing
  // it is useless: it can only take a real link away.
  const isolated = await createIsolatedAuthServer();
  const email = 'first-request-failure@ricoz.test';
  try {
    await User.create({ name: 'First Failure', email, password: PASSWORD, role: 'Employee' });

    const failingStub = stubHttps(({ respond }) => respond({ status: 500, body: '{"message":"internal error"}' }));
    let response;
    try {
      response = await withResend({}, async () => {
        const result = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email });
        await waitForQueueToSettle();
        return result;
      });
    } finally {
      failingStub.restore();
    }

    assert.equal(response.status, 200);
    assert.equal(response.data.message, NEUTRAL_MESSAGE);

    const attemptedToken = new URL(
      failingStub.calls[0].payload.text.match(/https:\/\/\S+/)[0]
    ).searchParams.get('token');
    assert.ok(attemptedToken && attemptedToken.length === 64, 'the failed attempt still used a real token');

    const user = await User.findOne({ email }).select('+passwordResetToken +passwordResetExpires');
    assert.equal(user.passwordResetToken || null, null, 'a token nobody received must not be left stored');
    assert.equal(user.passwordResetExpires || null, null, 'no expiry may be left behind either');
    assert.notEqual(user.passwordResetToken, hashResetToken(attemptedToken),
      'the token whose email failed must not be left stored');

    const reset = await apiOn(isolated.baseURL, 'POST', '/api/auth/reset-password', {
      token: attemptedToken,
      password: 'UndeliveredPass1!'
    });
    assert.equal(reset.status, 400, 'an undelivered token must not reset anything');
  } finally {
    await isolated.close();
  }
});

test('a failed send leaves the previously delivered token valid and logs nothing sensitive', async () => {
  // The reported incident: the transport could not be reached. The response must
  // not reveal it, the link the user already holds must stay usable, and the
  // single log line must carry neither the token, the reset link, the API key
  // nor the address.
  const isolated = await createIsolatedAuthServer();
  const deliveredToken = 'b'.repeat(64);
  try {
    // A link that was delivered earlier is already waiting for this account.
    await User.updateOne(
      { email: EMAIL },
      {
        $set: {
          passwordResetToken: hashResetToken(deliveredToken),
          passwordResetExpires: new Date(Date.now() + 15 * 60 * 1000)
        }
      }
    );

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
          async () => {
            const result = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
            await waitForQueueToSettle();
            return result;
          }
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

    // The token that could not be delivered must NOT be stored: nobody holds
    // that link, so keeping it can only take the delivered link away. The token
    // of the link the user already received must survive untouched.
    const attemptedToken = new URL(attemptedLink).searchParams.get('token');
    assert.ok(attemptedToken && attemptedToken.length === 64, 'the failed attempt still used a real token');
    const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken +passwordResetExpires');
    assert.notEqual(user.passwordResetToken, hashResetToken(attemptedToken),
      'the token whose email failed must not be left stored');
    assert.equal(user.passwordResetToken, hashResetToken(deliveredToken),
      'the link the user already received must survive the failed send');
    assert.ok(user.passwordResetExpires.getTime() > Date.now(), 'a failed send must not shorten the expiry');
    assert.ok(await findResettableUser(deliveredToken), 'the delivered link must still be accepted');

    const reset = await apiOn(isolated.baseURL, 'POST', '/api/auth/reset-password', {
      token: deliveredToken,
      password: 'KeptLink123!'
    });
    assert.equal(reset.status, 200, 'the delivered link must still reset the password');
  } finally {
    await isolated.close();
  }
});

test('a failed request does not put an older token back over a newer delivered one', async () => {
  // Two deliveries overlap: the first one is still waiting for its transport when
  // the second one stores and delivers its own token. The first one must not be
  // able to restore the token it replaced.
  //
  // The worker delivers one job at a time, so the overlap is produced the way
  // two application instances would produce it: the polling worker is stopped
  // and two passes are driven by hand, one of them holding its transport open.
  const isolated = await createIsolatedAuthServer();
  const olderToken = 'c'.repeat(64);

  await stopPasswordResetEmailWorker();
  try {
    await User.updateOne(
      { email: EMAIL },
      {
        $set: {
          passwordResetToken: hashResetToken(olderToken),
          passwordResetExpires: new Date(Date.now() + 15 * 60 * 1000)
        }
      }
    );

    let heldRespond = null;
    let callCount = 0;
    const httpsStub = stubHttps(({ respond }) => {
      callCount += 1;
      // The first delivery is held open until the second one has been sent.
      if (callCount === 1) {
        heldRespond = respond;
        return;
      }
      respond({ status: 200, body: '{"id":"message-newer"}' });
    });

    const logged = await captureConsoleError(async () => {
      try {
        await withResend({}, async () => {
          // Both requests are queued before anything is delivered, so the two
          // deliveries overlap exactly like two requests did before the queue
          // existed.
          await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
          await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
          assert.equal(
            await PasswordResetEmailJob.countDocuments({ status: 'pending' }),
            2,
            'both requests must be waiting in the queue'
          );

          // The first pass takes the older job and holds its transport open.
          const firstPass = runPasswordResetEmailWorkerPass();
          await waitFor(() => heldRespond !== null);

          // The second pass takes the newer job and delivers it while the first
          // one is still waiting for its transport.
          await runPasswordResetEmailWorkerPass();

          // Only now does the first delivery fail.
          heldRespond({ status: 500, body: '{"message":"internal error"}' });
          await firstPass;
        });
      } finally {
        httpsStub.restore();
      }
    });

    assert.equal(logged.length, 1, `only the failed delivery is reported, got: ${logged.join(' ')}`);

    const newerToken = new URL(
      httpsStub.calls[1].payload.text.match(/https:\/\/\S+/)[0]
    ).searchParams.get('token');
    assert.ok(newerToken && newerToken.length === 64, 'the second delivery must carry a real token');

    const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken +passwordResetExpires');
    assert.equal(user.passwordResetToken, hashResetToken(newerToken),
      'the token of the delivery that succeeded must survive the older failed delivery');
    assert.notEqual(user.passwordResetToken, hashResetToken(olderToken),
      'the failed delivery must not restore the older token');
    assert.ok(await findResettableUser(newerToken), 'the newer link must be usable');
  } finally {
    await startPasswordResetEmailWorker({ intervalMs: WORKER_INTERVAL_MS });
    await isolated.close();
  }
});
