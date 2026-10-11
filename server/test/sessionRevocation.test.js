// Session revocation on the Profile password change.
//
// The defect this exists for: the server's reset-password flow bumps
// `tokenVersion` so sessions issued under the old credential are revoked (the
// middleware answers their tokens with "Session expired. Please sign in
// again.", and the reset screens advertise that other sessions are revoked),
// but the Profile password change - `PUT /users/me` with `newPassword` - did
// the same password rotation without bumping `tokenVersion`. Every session
// minted before the change, including a session established with a compromised
// password, stayed valid until its 7-day expiry.
//
// The expected policy, inferred from the reset flow the UI already promises
// and the middleware that already enforces it: changing the password is a
// session-revoking event. The change must (a) revoke tokens issued before it,
// (b) still be usable by the caller who performed it by returning a fresh
// token, and (c) leave unrelated users' sessions alone. A name-only profile
// update must not revoke anything.
//
// Uses its own database and never touches real data.
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const authRoutes = require('../routes/authRoutes');
const userRoutes = require('../routes/userRoutes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_session_test';

let server;
let baseURL;

// Mirrors the middleware's expectation: a real token minted for the user's
// current tokenVersion, exactly as authRoutes.generateToken would.
const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async (overrides = {}) => User.create({
  name: 'Session User',
  email: `session.${Date.now()}.${Math.floor(Math.random() * 1e6)}@ricoz.test`,
  password: 'Password123!',
  role: 'Employee',
  ...overrides
});

const api = async (method, url, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseURL + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { status: response.status, data };
};

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('profile password change revokes pre-change sessions and issues a fresh session token', async () => {
  const email = `profile.rotate.${Date.now()}@ricoz.test`;
  const user = await createUser({ name: 'Rotate Me', email, password: 'OldPassword123!' });
  const oldToken = signToken(user);

  // The change itself must succeed using the pre-change session.
  const change = await api('PUT', '/api/users/me', {
    token: oldToken,
    body: { name: 'Rotate Me', currentPassword: 'OldPassword123!', newPassword: 'NewPassword456!' }
  });
  assert.equal(change.status, 200, `expected the password change to succeed, got ${change.status}`);

  // The pre-change token must no longer authenticate.
  const stale = await api('GET', '/api/users/me', { token: oldToken });
  assert.equal(stale.status, 401, 'a session issued before the password change must be revoked');
  assert.match(stale.data.message, /session|sign in|unauthorized/i);

  // The caller who changed the password must not be logged out: the response
  // carries a fresh token that works.
  assert.ok(change.data.token, 'the password-change response must return a fresh session token');
  const fresh = await api('GET', '/api/users/me', { token: change.data.token });
  assert.equal(fresh.status, 200, 'the fresh token from the password change must authenticate');
  assert.equal(fresh.data.email, email);

  // The old password no longer works; the new one does and needs no reset flow.
  const oldLogin = await api('POST', '/api/auth/login', { body: { email, password: 'OldPassword123!' } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api('POST', '/api/auth/login', { body: { email, password: 'NewPassword456!' } });
  assert.equal(newLogin.status, 200);
  assert.equal((await api('GET', '/api/users/me', { token: newLogin.data.token })).status, 200);
});

test('a name-only profile update must not revoke the caller session', async () => {
  const user = await createUser({ name: 'Rename Me' });
  const token = signToken(user);

  const update = await api('PUT', '/api/users/me', { token, body: { name: 'Renamed' } });
  assert.equal(update.status, 200);
  assert.equal(update.data.token, undefined, 'no password change means no token rotation');

  const stillActive = await api('GET', '/api/users/me', { token });
  assert.equal(stillActive.status, 200, 'a name-only update must leave existing sessions valid');
  assert.equal(stillActive.data.name, 'Renamed');
});

test('one user changing their password does not revoke another user sessions', async () => {
  const alice = await createUser({ name: 'Alice', email: `alice.${Date.now()}@ricoz.test`, password: 'AlicePass123!' });
  const bob = await createUser({ name: 'Bob', email: `bob.${Date.now()}@ricoz.test`, password: 'BobPass123!' });
  const bobToken = signToken(bob);

  const change = await api('PUT', '/api/users/me', {
    token: signToken(alice),
    body: { currentPassword: 'AlicePass123!', newPassword: 'AlicePass456!' }
  });
  assert.equal(change.status, 200);

  const bobFine = await api('GET', '/api/users/me', { token: bobToken });
  assert.equal(bobFine.status, 200, `Bob's session must survive Alice's password change, got ${bobFine.status}`);
  assert.equal(bobFine.data.name, 'Bob');
});