'use strict';

// Issue 18 - the profile update endpoint (`PUT /users/me`).
//
// Two defects are pinned here.
//
// 1. A blank name was accepted and silently dropped. `PUT /users/me` guarded the
//    assignment with `if (req.body.name)`, so an empty string skipped the
//    assignment while the route still answered 200. `POST /auth/register`
//    refuses an empty name with 400 "Name is required", and the User schema
//    marks `name` required, so the profile route was the one path that reported
//    a successful save while persisting nothing. The Profile page then showed
//    the blank field it had just submitted next to a "Profile updated" toast,
//    while the account kept its old name - the displayed profile disagreeing
//    with the authenticated account.
//
// 2. A password change on an account that has no password (a Google-created
//    account) crashed. `user.matchPassword()` compares with bcrypt, which throws
//    "Illegal arguments: string, undefined" when the stored hash is undefined,
//    so the request fell through to the central handler as an opaque 500. The
//    account simply has no password to confirm, which is a 400, not a crash.
//
// Uses its own disposable database and never touches real data.
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
const { errorHandler } = require('../app');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_profile_update_test');

let server;
let baseURL;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async (overrides = {}) => User.create({
  name: 'Profile User',
  email: `profile.${Date.now()}.${Math.floor(Math.random() * 1e6)}@ricoz.test`,
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
  // The production error mapping, so a ValidationError surfaces as the same 400
  // a real client would see.
  app.use(errorHandler);

  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  server = app.listen(0, '127.0.0.1', () => {
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('a valid profile name update is persisted and returned', async () => {
  const user = await createUser({ name: 'Before' });
  const response = await api('PUT', '/api/users/me', { token: signToken(user), body: { name: 'After' } });

  assert.equal(response.status, 200);
  assert.equal(response.data.name, 'After', 'the response must carry the saved name');
  assert.equal((await User.findById(user._id)).name, 'After', 'and it must be persisted');
});

test('a blank name is rejected instead of silently reporting success', async () => {
  const user = await createUser({ name: 'Keep Me' });
  const response = await api('PUT', '/api/users/me', { token: signToken(user), body: { name: '' } });

  assert.equal(response.status, 400, 'an empty name must not be reported as a successful update');
  assert.match(response.data.message, /name/i);
  assert.equal((await User.findById(user._id)).name, 'Keep Me', 'the stored name must be unchanged');
});

test('a whitespace-only or non-string name is rejected with a client error', async () => {
  const user = await createUser({ name: 'Keep Me' });
  const token = signToken(user);

  for (const name of ['   ', { $ne: null }, 5, true, ['x']]) {
    const response = await api('PUT', '/api/users/me', { token, body: { name } });
    assert.ok(response.status >= 400 && response.status < 500,
      `name ${JSON.stringify(name)} must be a client error, got ${response.status}`);
  }
  assert.equal((await User.findById(user._id)).name, 'Keep Me');
});

test('a partial update that omits the name is still allowed', async () => {
  // Settings sends only `preferences` and the password form sends no name at
  // all when only a password changes - the name guard must not require it.
  const user = await createUser({ name: 'Partial' });
  const response = await api('PUT', '/api/users/me', {
    token: signToken(user),
    body: { preferences: { emailNotifications: false } }
  });

  assert.equal(response.status, 200, `a preferences-only update must succeed, got ${response.status}`);
  assert.equal((await User.findById(user._id)).name, 'Partial');
});

test('the profile endpoint cannot change protected fields', async () => {
  const user = await createUser({ name: 'Protected', role: 'Employee' });
  const token = signToken(user);

  await api('PUT', '/api/users/me', {
    token,
    body: { role: 'Admin', status: 'Inactive', email: 'attacker@evil.test' }
  });

  const stored = await User.findById(user._id);
  assert.equal(stored.role, 'Employee', 'role must not be settable through the profile endpoint');
  assert.equal(stored.status, 'Active', 'status must not be settable through the profile endpoint');
  assert.equal(stored.email, user.email, 'email must not be settable through the profile endpoint');
});

test('updating a profile cannot target another account', async () => {
  const victim = await createUser({ name: 'Victim' });
  const attacker = await createUser({ name: 'Attacker' });
  const token = signToken(attacker);

  // The profile route reads req.user; there is no id in the path. A crafted id
  // in the body must not reach the victim.
  const response = await api('PUT', '/api/users/me', { token, body: { name: 'Owned', _id: victim._id, id: victim._id } });

  assert.equal(response.status, 200);
  assert.equal((await User.findById(victim._id)).name, 'Victim', "another user's name must be untouched");
  assert.equal((await User.findById(attacker._id)).name, 'Owned', 'only the caller may be updated');
});

test('a password change on an account without a password is a client error, not a 500', async () => {
  // A Google-created account has a googleId and no password hash.
  const googleUser = await createUser({
    name: 'Google Only',
    password: undefined,
    googleId: `g-${Date.now()}`
  });
  const response = await api('PUT', '/api/users/me', {
    token: signToken(googleUser),
    body: { currentPassword: 'anything', newPassword: 'BrandNew123!' }
  });

  assert.ok(response.status >= 400 && response.status < 500,
    `expected a client error, got ${response.status}`);
  assert.notEqual(response.data && response.data.message, 'Internal server error');
});

test('a password change on a normal account still rotates the session', async () => {
  const user = await createUser({ name: 'Rotator', password: 'OldPassword123!' });
  const oldToken = signToken(user);

  const change = await api('PUT', '/api/users/me', {
    token: oldToken,
    body: { currentPassword: 'OldPassword123!', newPassword: 'NewPassword456!' }
  });
  assert.equal(change.status, 200);
  assert.ok(change.data.token, 'a fresh token must be returned');

  assert.equal((await api('GET', '/api/users/me', { token: oldToken })).status, 401,
    'the pre-change session must be revoked');
  assert.equal((await api('GET', '/api/users/me', { token: change.data.token })).status, 200,
    'the fresh session must work');
});
