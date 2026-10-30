// Regression tests for the password-reset timing side channel.
//
// /forgot-password used to send the reset email inside the request, so a
// request for an existing account waited for the mail provider to answer while
// an unknown address answered at once. The time the answer took therefore told
// an unauthenticated caller whether the address had an account, which is enough
// to tell an address apart without ever seeing the mail.
//
// The email is queued now: the request records a job and answers at once, and
// the worker delivers the job afterwards. These tests drive the HTTP route
// with a deliberately slow transport and look at what the caller sees, what
// the transport sees and what the queue holds.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readFocusedTestConfig } = require('./helpers/testDatabase');
const { mongoUri: TEST_DB_URI, jwtSecret: TEST_JWT_SECRET } = readFocusedTestConfig(process.env, { suiteName: 'password-reset-timing' });
process.env.JWT_SECRET = TEST_JWT_SECRET;
const express = require('express');
const mongoose = require('mongoose');

// JWT signing uses the explicit test secret.


const User = require('../models/User');
const PasswordResetEmailJob = require('../models/PasswordResetEmailJob');
const { hashResetToken } = require('../utils/passwordReset');
const {
  startPasswordResetEmailWorker,
  stopPasswordResetEmailWorker
} = require('../services/passwordResetEmailQueue');
const { withEmailEnv } = require('./helpers/emailEnv');
const { stubHttps, stubSmtp } = require('./helpers/emailTransports');


const EMAIL = 'timing@ricoz.test';
const UNKNOWN_EMAIL = 'nobody-at-all@ricoz.test';
const PASSWORD = 'Secret123!';
const RESEND_KEY = 're_testonlykey0123456789abcdef';

const NEUTRAL_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

// How long the fake provider takes to answer. It is far longer than the route
// needs, so a route that waited for the provider could not finish in time.
const TRANSPORT_DELAY_MS = 1500;

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

// /forgot-password is limited to five requests per fifteen minutes and the
// limiter keeps its counters inside the router module, so every test mounts a
// freshly required router on its own server and gets its own allowance. The
// behaviour of the route is identical; only the counters are separate.
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

const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// Waits until the queue holds no job that is waiting or in flight.
const waitForQueueToSettle = async (timeoutMs = 8000) => {
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
  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });

  await User.create({ name: 'Timing Test', email: EMAIL, password: PASSWORD, role: 'Employee' });

  await startPasswordResetEmailWorker({ intervalMs: WORKER_INTERVAL_MS });
});

test.beforeEach(async () => {
  // Every test looks at the queue on its own, so the jobs of the previous test
  // and the token it left behind are cleared.
  await PasswordResetEmailJob.deleteMany({});
  await User.updateOne(
    { email: EMAIL },
    { $set: { passwordResetToken: null, passwordResetExpires: null } }
  );
});

test.after(async () => {
  await stopPasswordResetEmailWorker();
  if (mongoose.connection.readyState) {
    await mongoose.disconnect();
  }
});

test('an existing account and an unknown account get the same answer', async () => {
  const isolated = await createIsolatedAuthServer();
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"ok"}' }));
  try {
    await withResend({}, async () => {
      const known = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
      const unknown = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: UNKNOWN_EMAIL });

      assert.equal(known.status, 200);
      assert.equal(unknown.status, 200);
      assert.deepEqual(known.data, unknown.data, 'the answer must not depend on the account');
      assert.equal(known.data.message, NEUTRAL_MESSAGE);

      await waitForQueueToSettle();
    });
  } finally {
    httpsStub.restore();
    await isolated.close();
  }
});

test('the answer does not wait for the mail provider', async () => {
  const isolated = await createIsolatedAuthServer();
  let transportFinished = false;
  const httpsStub = stubHttps(({ respond }) => {
    setTimeout(() => {
      transportFinished = true;
      respond({ status: 200, body: '{"id":"slow"}' });
    }, TRANSPORT_DELAY_MS);
  });

  try {
    await withResend({}, async () => {
      const started = Date.now();
      const response = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
      const elapsed = Date.now() - started;

      assert.equal(response.status, 200);
      assert.equal(response.data.message, NEUTRAL_MESSAGE);
      assert.equal(
        transportFinished,
        false,
        'the provider was still working when the answer was given'
      );
      assert.ok(
        elapsed < TRANSPORT_DELAY_MS,
        `the answer took ${elapsed}ms, so it waited for the provider`
      );

      // The mail is still sent, only not waited for.
      await waitFor(() => transportFinished);
    });
  } finally {
    httpsStub.restore();
    await isolated.close();
  }
});

test('an unknown account never gets an email and never queues a job', async () => {
  const isolated = await createIsolatedAuthServer();
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"ok"}' }));
  const smtpStub = stubSmtp(() => {
    assert.fail('no mail may be sent for an unknown account');
  });

  try {
    await withResend({}, async () => {
      const response = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: UNKNOWN_EMAIL });
      assert.equal(response.status, 200);
      assert.equal(response.data.message, NEUTRAL_MESSAGE);
      await waitForQueueToSettle();
    });
  } finally {
    httpsStub.restore();
    smtpStub.restore();
    await isolated.close();
  }

  assert.equal(httpsStub.calls.length, 0, 'an unknown account must not trigger an email');
  assert.equal(smtpStub.delivered.length, 0, 'an unknown account must not trigger an email');
  assert.equal(
    await PasswordResetEmailJob.countDocuments({}),
    0,
    'an unknown account must not leave a job behind'
  );
});

test('a delivery failure is not visible in the answer and is reported once', async () => {
  const isolated = await createIsolatedAuthServer();
  const httpsStub = stubHttps(({ respond }) => respond({ status: 500, body: '{"message":"internal error"}' }));

  let logged;
  try {
    logged = await captureConsoleError(async () => {
      await withResend({}, async () => {
        const known = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
        const unknown = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: UNKNOWN_EMAIL });

        assert.equal(known.status, unknown.status);
        assert.deepEqual(known.data, unknown.data, 'a failed delivery must not change the answer');

        await waitForQueueToSettle();
      });
    });
  } finally {
    httpsStub.restore();
    await isolated.close();
  }

  assert.equal(logged.length, 1, `the failure must be reported once, got: ${logged.join(' ')}`);
  assert.match(logged[0], /Password reset email could not be sent/);
  for (const secret of [EMAIL, UNKNOWN_EMAIL, RESEND_KEY]) {
    assert.ok(!logged[0].includes(secret), `"${secret}" leaked into the log line: ${logged[0]}`);
  }

  const job = await PasswordResetEmailJob.findOne({});
  assert.ok(job, 'the failed delivery must leave a job behind');
  assert.equal(job.status, 'failed');
  assert.ok(job.lastError, 'the reason of the failure must be kept on the job');
  for (const secret of [EMAIL, RESEND_KEY]) {
    assert.ok(!job.lastError.includes(secret), `"${secret}" leaked into the job: ${job.lastError}`);
  }
});

test('the queued email is delivered after the answer and the link works', async () => {
  const isolated = await createIsolatedAuthServer();
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"ok"}' }));

  try {
    await withResend({}, async () => {
      const response = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
      assert.equal(response.status, 200);
      await waitForQueueToSettle();
    });
  } finally {
    httpsStub.restore();
    await isolated.close();
  }

  assert.equal(httpsStub.calls.length, 1, 'the queued email must still be sent');
  const rawToken = new URL(
    httpsStub.calls[0].payload.text.match(/https:\/\/\S+/)[0]
  ).searchParams.get('token');
  assert.ok(rawToken && rawToken.length === 64, 'the emailed link must carry a real token');

  const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken');
  assert.equal(
    user.passwordResetToken,
    hashResetToken(rawToken),
    'the emailed link must be the one the account can use'
  );

  const job = await PasswordResetEmailJob.findOne({});
  assert.equal(job.status, 'sent');
});

test('a job that was recorded waits in the database and is delivered when the worker runs', async () => {
  const isolated = await createIsolatedAuthServer();
  const httpsStub = stubHttps(({ respond }) => respond({ status: 200, body: '{"id":"ok"}' }));

  // The worker is stopped, so the job can be seen in the queue before it is
  // delivered: a request that was answered must not be lost.
  await stopPasswordResetEmailWorker();
  try {
    await withResend({}, async () => {
      const response = await apiOn(isolated.baseURL, 'POST', '/api/auth/forgot-password', { email: EMAIL });
      assert.equal(response.status, 200);

      const job = await PasswordResetEmailJob.findOne({});
      assert.ok(job, 'the request must leave a job behind');
      assert.equal(job.status, 'pending');

      const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken');
      assert.equal(
        user.passwordResetToken || null,
        null,
        'no token exists before the job is delivered'
      );

      await startPasswordResetEmailWorker({ intervalMs: WORKER_INTERVAL_MS });
      await waitForQueueToSettle();
    });
  } finally {
    httpsStub.restore();
    await startPasswordResetEmailWorker({ intervalMs: WORKER_INTERVAL_MS });
    await isolated.close();
  }

  assert.equal(httpsStub.calls.length, 1, 'the recorded job must be delivered');
  const rawToken = new URL(
    httpsStub.calls[0].payload.text.match(/https:\/\/\S+/)[0]
  ).searchParams.get('token');
  const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken');
  assert.equal(
    user.passwordResetToken,
    hashResetToken(rawToken),
    'the delivered link must be the one the account can use'
  );
});
