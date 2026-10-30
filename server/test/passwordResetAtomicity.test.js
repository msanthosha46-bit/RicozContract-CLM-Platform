// Regression tests for the single-use guarantee of a password-reset token.
//
// Two requests that present the same token at the same time used to both
// succeed: both read the token, both wrote a password and both answered "Your
// password has been reset. You can now sign in." The last writer won, so the
// user could be left with a password they never chose. The token is now spent
// and the password written in one atomic update, so exactly one request can
// use a token.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readFocusedTestConfig } = require('./helpers/testDatabase');
const { mongoUri: TEST_DB_URI, jwtSecret: TEST_JWT_SECRET } = readFocusedTestConfig(process.env, { suiteName: 'password-reset-atomicity' });
process.env.JWT_SECRET = TEST_JWT_SECRET;
const express = require('express');
const mongoose = require('mongoose');

// JWT signing uses the explicit test secret and a local test client ID.

if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const User = require('../models/User');
const authRoutes = require('../routes/authRoutes');
const { generateResetToken, hashResetToken } = require('../utils/passwordReset');


const EMAIL = 'atomic@ricoz.test';
const PASSWORD = 'Secret123!';
const FIRST_PASSWORD = 'FirstWriter123!';
const SECOND_PASSWORD = 'SecondWriter123!';

let server;
let baseURL;

const api = async (method, url, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseURL + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  return { status: response.status, data, headers: response.headers };
};

// Puts a usable reset token on the account, the way a delivered link does.
const giveResetToken = async (email = EMAIL) => {
  const { token, tokenHash, expiresAt } = generateResetToken();
  await User.updateOne(
    { email },
    { $set: { passwordResetToken: tokenHash, passwordResetExpires: expiresAt } }
  );
  return token;
};

test.before(async () => {
  assert.ok(process.env.JWT_SECRET, 'TEST_JWT_SECRET must be explicitly configured');

  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  await User.create({ name: 'Atomic Test', email: EMAIL, password: PASSWORD, role: 'Employee' });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.disconnect();
  }
});

test('two concurrent reset requests with the same token let exactly one succeed', async () => {
  const token = await giveResetToken();

  const [first, second] = await Promise.all([
    api('POST', '/api/auth/reset-password', { body: { token, password: FIRST_PASSWORD } }),
    api('POST', '/api/auth/reset-password', { body: { token, password: SECOND_PASSWORD } })
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 400], 'exactly one request may reset the password');

  const failure = first.status === 400 ? first : second;
  assert.match(failure.data.message, /invalid or has expired/);

  // The token is spent, so it cannot be used again either.
  const reused = await api('POST', '/api/auth/reset-password', { body: { token, password: 'ThirdWriter123!' } });
  assert.equal(reused.status, 400);
  assert.match(reused.data.message, /invalid or has expired/);
});

test('the losing request cannot change the password the winner set', async () => {
  const before = await User.findOne({ email: EMAIL });
  const token = await giveResetToken();

  // Which of the two requests wins the race is not fixed: the token is spent
  // by one atomic write, and either request may reach it first. Each request
  // is therefore paired with the password it tried to set, so the winner is
  // read back from the answers instead of being assumed to be the first one.
  const attempts = [
    { password: FIRST_PASSWORD, response: null },
    { password: SECOND_PASSWORD, response: null }
  ];

  const responses = await Promise.all(attempts.map((attempt) =>
    api('POST', '/api/auth/reset-password', { body: { token, password: attempt.password } })
  ));
  attempts.forEach((attempt, index) => { attempt.response = responses[index]; });

  const winners = attempts.filter((attempt) => attempt.response.status === 200);
  const losers = attempts.filter((attempt) => attempt.response.status !== 200);
  assert.equal(winners.length, 1, 'exactly one request may reset the password');
  assert.equal(losers.length, 1, 'the other request must be refused');

  const [winner] = winners;
  const [loser] = losers;
  assert.equal(loser.response.status, 400);
  assert.match(winner.response.data.message, /password has been reset/i);
  assert.match(loser.response.data.message, /invalid or has expired/);

  // The stored password is the winner's, whichever request won.
  const after = await User.findOne({ email: EMAIL });
  assert.equal(await after.matchPassword(loser.password), false,
    'the losing request must not have set its password');
  assert.equal(await after.matchPassword(winner.password), true,
    'the winning request must have set its password');

  // The winner can sign in, the loser's password does not work.
  const winnerLogin = await api('POST', '/api/auth/login', {
    body: { email: EMAIL, password: winner.password }
  });
  assert.equal(winnerLogin.status, 200);
  const loserLogin = await api('POST', '/api/auth/login', {
    body: { email: EMAIL, password: loser.password }
  });
  assert.equal(loserLogin.status, 401);

  // One reset happened, so the session version moved exactly once.
  assert.equal(after.tokenVersion, (before.tokenVersion || 0) + 1,
    'one reset must invalidate the sessions issued before it once');
});

test('an expired or invalid token is rejected and leaves the password alone', async () => {
  const before = await User.findOne({ email: EMAIL });

  const { token: expiredToken, tokenHash: expiredHash } = generateResetToken();
  await User.updateOne(
    { email: EMAIL },
    { $set: { passwordResetToken: expiredHash, passwordResetExpires: new Date(Date.now() - 1000) } }
  );

  const expired = await api('POST', '/api/auth/reset-password', {
    body: { token: expiredToken, password: 'ExpiredPass123!' }
  });
  assert.equal(expired.status, 400);
  assert.match(expired.data.message, /invalid or has expired/);

  const malformed = await api('POST', '/api/auth/reset-password', {
    body: { token: 'not-a-real-token', password: 'MalformedPass123!' }
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.data.message, /invalid or has expired/);

  const after = await User.findOne({ email: EMAIL });
  assert.equal(after.password, before.password, 'a rejected reset must not change the stored password');
});

test('a rejected password does not spend the token', async () => {
  const token = await giveResetToken();

  const weak = await api('POST', '/api/auth/reset-password', { body: { token, password: 'abc' } });
  assert.equal(weak.status, 400);
  assert.match(weak.data.message, /at least 6/);

  const user = await User.findOne({ email: EMAIL }).select('+passwordResetToken');
  assert.equal(user.passwordResetToken, hashResetToken(token),
    'a request that is rejected must not consume the token');

  const reset = await api('POST', '/api/auth/reset-password', {
    body: { token, password: 'StillUsable123!' }
  });
  assert.equal(reset.status, 200, 'the token must still work after a rejected request');
});
