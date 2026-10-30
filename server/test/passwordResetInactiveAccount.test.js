// Regression tests for a password reset on a deactivated account.
//
// The policy of this project is that an account an administrator has switched
// off cannot be used: the login path answers the generic "Invalid email or
// password" (never a distinct one, so the state cannot be probed) and the
// protected routes refuse its token. The reset path ignored that state and
// answered "Your password has been reset. You can now sign in." for an inactive
// account, which promised a sign-in the policy refuses to give.
//
// The chosen behaviour, tested here:
//
//   * A deactivated account is refused the reset outright (401, "This account
//     is inactive. Contact an administrator.").
//   * Its stored password is left alone, because no reset happened.
//   * The account is NOT reactivated.
//   * The link is not spent, by the same rule that governs a rejected
//     password: the same link still works once an administrator reactivates
//     the account.
//   * The message may name the state, because the caller holds a live reset
//     link and has therefore proved control of the mailbox. The endpoints that
//     cannot prove control (login, forgot-password) keep their generic
//     wording, and a bad or expired token is still answered with the generic
//     invalid-link message for an inactive account as well, so this endpoint
//     cannot be used to learn which addresses are registered or switched off.
//
// The suite needs its own database, and every test mounts a freshly required
// router on its own server because the reset endpoints are rate limited and
// the limiter keeps its counters inside the router module.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readFocusedTestConfig } = require('./helpers/testDatabase');
const { mongoUri: TEST_DB_URI, jwtSecret: TEST_JWT_SECRET } = readFocusedTestConfig(process.env, { suiteName: 'password-reset-inactive' });
process.env.JWT_SECRET = TEST_JWT_SECRET;
const express = require('express');
const mongoose = require('mongoose');

// JWT signing uses the explicit test secret and a local test client ID.

if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const User = require('../models/User');
const { generateResetToken, hashResetToken } = require('../utils/passwordReset');


const ACTIVE_EMAIL = 'active.reset@ricoz.test';
const INACTIVE_EMAIL = 'inactive.reset@ricoz.test';
const PASSWORD = 'Secret123!';
const NEW_PASSWORD = 'BrandNew123!';

const INVALID_LINK = /invalid or has expired/i;

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

// The reset endpoints are limited to ten requests per fifteen minutes and the
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

// Puts a usable reset token on the account, the way a delivered link does.
const giveResetToken = async (email) => {
  const { token, tokenHash, expiresAt } = generateResetToken();
  await User.updateOne(
    { email },
    { $set: { passwordResetToken: tokenHash, passwordResetExpires: expiresAt } }
  );
  return token;
};

// The stored token as /reset-password looks it up, which is the definition of
// "this reset link still works".
const storedTokenOf = async (email) => {
  const user = await User.findOne({ email }).select('+passwordResetToken');
  return user.passwordResetToken;
};

// Switches an account off in the moment between the route's lookup and its
// write, which is the only way an account that has just been deactivated could
// still be reset.
//
// The switch is done by the raw driver inside a replacement for User.updateOne:
// Mongoose freezes its query middleware when the model is compiled, so a hook
// registered by a test would never run, and the raw driver cannot trigger the
// replacement again.
let deactivateBeforeNextUpdate = null;
const originalUpdateOne = User.updateOne.bind(User);
User.updateOne = async (filter, update, options) => {
  if (deactivateBeforeNextUpdate) {
    const id = deactivateBeforeNextUpdate;
    deactivateBeforeNextUpdate = null;
    await User.collection.updateOne({ _id: id }, { $set: { status: 'Inactive' } });
  }
  return originalUpdateOne(filter, update, options);
};

test.before(async () => {
  assert.ok(process.env.JWT_SECRET, 'TEST_JWT_SECRET must be explicitly configured');

  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });

  await User.create({ name: 'Active Reset', email: ACTIVE_EMAIL, password: PASSWORD, role: 'Employee' });
  await User.create({
    name: 'Inactive Reset',
    email: INACTIVE_EMAIL,
    password: PASSWORD,
    role: 'Employee',
    status: 'Inactive'
  });
});

test.after(async () => {
  User.updateOne = originalUpdateOne;
  if (mongoose.connection.readyState) {
    await mongoose.disconnect();
  }
});

test('an active account can reset its password and sign in with the new one', async () => {
  const server = await createIsolatedAuthServer();
  try {
    const token = await giveResetToken(ACTIVE_EMAIL);

    const reset = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD
    });
    assert.equal(reset.status, 200);
    assert.match(reset.data.message, /password has been reset/i);

    const login = await apiOn(server.baseURL, 'POST', '/api/auth/login', {
      email: ACTIVE_EMAIL, password: NEW_PASSWORD
    });
    assert.equal(login.status, 200, 'an active account must be able to sign in after a reset');
    assert.ok(login.data.token, 'a successful reset must be able to sign in');

    const old = await apiOn(server.baseURL, 'POST', '/api/auth/login', {
      email: ACTIVE_EMAIL, password: PASSWORD
    });
    assert.equal(old.status, 401, 'the old password must stop working');
  } finally {
    await server.close();
  }
});

test('an inactive account is refused a reset and is not told it can sign in', async () => {
  const server = await createIsolatedAuthServer();
  try {
    const before = await User.findOne({ email: INACTIVE_EMAIL });
    const token = await giveResetToken(INACTIVE_EMAIL);

    const reset = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD
    });
    assert.equal(reset.status, 401);
    assert.match(reset.data.message, /inactive/i);
    // The whole point of the fix: no promise of a sign-in that cannot happen.
    assert.doesNotMatch(reset.data.message, /you can now sign in/i);
    assert.doesNotMatch(reset.data.message, /password has been reset/i);

    const after = await User.findOne({ email: INACTIVE_EMAIL }).select('+passwordResetToken');
    assert.equal(after.password, before.password, 'a refused reset must not change the stored password');
    assert.equal(await after.matchPassword(NEW_PASSWORD), false, 'the new password must not be in use');
    assert.equal(after.status, 'Inactive', 'a refused reset must not reactivate the account');
    assert.equal(
      after.passwordResetToken,
      hashResetToken(token),
      'a refused reset must not spend the token, because no reset happened'
    );

    // The account still cannot sign in, which is the reason the reset was
    // refused. The login answer stays the generic one, as the policy demands.
    const login = await apiOn(server.baseURL, 'POST', '/api/auth/login', {
      email: INACTIVE_EMAIL, password: NEW_PASSWORD
    });
    assert.equal(login.status, 401);
    assert.equal(login.data.message, 'Invalid email or password');
    assert.equal(login.data.token, undefined, 'an inactive account must never be handed a JWT');
  } finally {
    await server.close();
  }
});

test('the same link works once an administrator reactivates the account', async () => {
  const server = await createIsolatedAuthServer();
  try {
    const token = await giveResetToken(INACTIVE_EMAIL);

    const refused = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD
    });
    assert.equal(refused.status, 401, 'the account starts out deactivated');

    // An administrator reactivates the account, the way the role endpoint does.
    await User.updateOne({ email: INACTIVE_EMAIL }, { $set: { status: 'Active' } });

    const reset = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD
    });
    assert.equal(reset.status, 200, 'the link must still work after a reactivation');
    assert.match(reset.data.message, /password has been reset/i);

    const login = await apiOn(server.baseURL, 'POST', '/api/auth/login', {
      email: INACTIVE_EMAIL, password: NEW_PASSWORD
    });
    assert.equal(login.status, 200, 'the reactivated account must be able to sign in');

    // Put the account back the way the test found it.
    await User.updateOne({ email: INACTIVE_EMAIL }, { $set: { status: 'Inactive' } });
  } finally {
    await server.close();
  }
});

test('an invalid or expired token is still rejected with the generic message', async () => {
  const server = await createIsolatedAuthServer();
  try {
    const unknown = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token: 'f'.repeat(64),
      password: NEW_PASSWORD
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.data.message, INVALID_LINK);

    // An expired link on a deactivated account is answered with the generic
    // message too: the token is checked first, so the response cannot be used
    // to learn that the account exists or that it is switched off.
    const { token: expiredToken, tokenHash: expiredHash } = generateResetToken();
    await User.updateOne(
      { email: INACTIVE_EMAIL },
      { $set: { passwordResetToken: expiredHash, passwordResetExpires: new Date(Date.now() - 1000) } }
    );
    const expired = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token: expiredToken,
      password: NEW_PASSWORD
    });
    assert.equal(expired.status, 400);
    assert.match(expired.data.message, INVALID_LINK);
    assert.doesNotMatch(expired.data.message, /inactive/i);

    // A malformed token is refused before anything is looked up.
    const malformed = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token: 'not-a-real-token',
      password: NEW_PASSWORD
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.data.message, INVALID_LINK);
    assert.doesNotMatch(malformed.data.message, /inactive/i);
  } finally {
    await server.close();
  }
});

test('an account deactivated while the reset is in flight is refused, not reset', async () => {
  const server = await createIsolatedAuthServer();
  try {
    const before = await User.findOne({ email: ACTIVE_EMAIL });
    const token = await giveResetToken(ACTIVE_EMAIL);
    const user = await User.findOne({ email: ACTIVE_EMAIL });

    // The account is switched off in the moment between the route's lookup
    // and its write, which is the only way an account that has just been
    // deactivated could still be reset.
    deactivateBeforeNextUpdate = user._id;

    const reset = await apiOn(server.baseURL, 'POST', '/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD
    });
    assert.equal(reset.status, 401);
    assert.match(reset.data.message, /inactive/i);
    assert.doesNotMatch(reset.data.message, /you can now sign in/i);

    const after = await User.findOne({ email: ACTIVE_EMAIL }).select('+passwordResetToken');
    assert.equal(after.password, before.password, 'the password must not change');
    assert.equal(after.status, 'Inactive');
    assert.equal(after.passwordResetToken, hashResetToken(token), 'the token must not be spent');

    // Put the account back the way the test found it.
    await User.updateOne({ email: ACTIVE_EMAIL }, { $set: { status: 'Active' } });
  } finally {
    await server.close();
  }
});
