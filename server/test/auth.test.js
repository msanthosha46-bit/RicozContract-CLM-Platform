const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

// Load server/.env so JWT_SECRET and GOOGLE_CLIENT_ID are available in tests.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// CI-safe fallbacks: provide non-production test values when the env file is
// absent (e.g. GitHub Actions). Real local/production values are never touched.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
}
if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const authRoutes = require('../routes/authRoutes');
const userRoutes = require('../routes/userRoutes');
const mailer = require('../utils/mailer');
const googleAuth = require('../utils/googleAuth');
const {
  RESET_TOKEN_TTL_MINUTES,
  generateResetToken,
  hashResetToken,
  buildResetLink,
  validatePassword
} = require('../utils/passwordReset');
const { buildVerifyOptions } = googleAuth;

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_auth_test';

const EMPLOYEE_EMAIL = 'employee@ricoz.test';
const EMPLOYEE_PASSWORD = 'Secret123!';
const EMPLOYEE_NEW_PASSWORD = 'NewSecret456!';

let server;
let baseURL;
let capturedResetLink;
let employeeToken; // token issued before the password reset
const originalSendPasswordResetEmail = mailer.sendPasswordResetEmail;
const originalVerifyGoogleIdToken = googleAuth.verifyGoogleIdToken;

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

const startTestApp = () =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    // Mirrors the central handler behaviour used by server.js.
    app.use((error, req, res, next) => {
      if (error.code === 11000) {
        return res.status(409).json({ message: 'A record with the same unique value already exists' });
      }
      console.error(error);
      return res.status(500).json({ message: 'Internal server error' });
    });
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

test.before(async () => {
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET must be set in server/.env to run these tests');
  assert.ok(process.env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID must be set in server/.env to run these tests');

  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  await startTestApp();
  baseURL = `http://127.0.0.1:${server.address().port}`;

  // Capture the reset link instead of sending real email during tests.
  mailer.sendPasswordResetEmail = async ({ resetLink }) => {
    capturedResetLink = resetLink;
  };
});

test.after(async () => {
  mailer.sendPasswordResetEmail = originalSendPasswordResetEmail;
  googleAuth.verifyGoogleIdToken = originalVerifyGoogleIdToken;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('password reset utilities generate hashed, short-lived tokens', () => {
  const { token, tokenHash, expiresAt } = generateResetToken();
  assert.equal(token.length, 64);
  assert.equal(tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(tokenHash, token);
  const ttlMinutes = (expiresAt.getTime() - Date.now()) / 60000;
  assert.ok(ttlMinutes > RESET_TOKEN_TTL_MINUTES - 1 && ttlMinutes <= RESET_TOKEN_TTL_MINUTES);

  const link = buildResetLink(token);
  assert.ok(link.includes('/reset-password?token='));
  assert.ok(link.includes(encodeURIComponent(token)));

  assert.match(String(validatePassword('abc')), /at least 6/);
  assert.equal(validatePassword(EMPLOYEE_NEW_PASSWORD), null);
  assert.match(String(validatePassword(123456)), /required/);
});

test('Google verification options use the configured client ID as audience', () => {
  const options = buildVerifyOptions('some-id-token');
  assert.deepEqual(options, {
    idToken: 'some-id-token',
    audience: process.env.GOOGLE_CLIENT_ID
  });
});

test('existing email/password registration, login and JWT access still work', async () => {
  // Even if a role is smuggled in the body, registration must stay Employee.
  const register = await api('POST', '/api/auth/register', {
    body: { name: 'Employee One', email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD, department: 'Sales', role: 'Admin' }
  });
  assert.equal(register.status, 201);
  assert.equal(register.data.role, 'Employee');
  assert.ok(register.data.token);
  employeeToken = register.data.token;

  const login = await api('POST', '/api/auth/login', {
    body: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD }
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  const me = await api('GET', '/api/users/me', { token: login.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, EMPLOYEE_EMAIL);

  const wrongPassword = await api('POST', '/api/auth/login', {
    body: { email: EMPLOYEE_EMAIL, password: 'wrong-password' }
  });
  assert.equal(wrongPassword.status, 401);
});

test('Google sign-in rejects missing and invalid credentials', async () => {
  const missing = await api('POST', '/api/auth/google', { body: {} });
  assert.equal(missing.status, 400);

  const invalid = await api('POST', '/api/auth/google', { body: { credential: 'garbage.token.value' } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.data.message, 'Google Sign-In could not be verified');
});

test('Google sign-in enforces verified email, role rules and inactive accounts', async () => {
  const seenCredentials = [];
  googleAuth.verifyGoogleIdToken = async (credential) => {
    seenCredentials.push(credential);
    const payload = googleAuth.verifyGoogleIdToken.payload;
    if (!payload) throw new Error('no stub payload configured');
    return payload;
  };

  try {
    // 1) Unverified Google email is rejected.
    googleAuth.verifyGoogleIdToken.payload = {
      sub: 'g-unverified',
      email: 'unverified@ricoz.test',
      email_verified: false
    };
    const unverified = await api('POST', '/api/auth/google', { body: { credential: 'token-unverified' } });
    assert.equal(unverified.status, 401);
    assert.match(unverified.data.message, /email could not be verified/);

    // 2) New Google user is created as Employee only.
    googleAuth.verifyGoogleIdToken.payload = {
      sub: 'g-new-user',
      email: 'google.new@ricoz.test',
      email_verified: true,
      name: 'Google New'
    };
    const created = await api('POST', '/api/auth/google', { body: { credential: 'token-new-user' } });
    assert.equal(created.status, 200);
    assert.equal(created.data.role, 'Employee');
    assert.equal(created.data.email, 'google.new@ricoz.test');
    assert.ok(created.data.token);

    const createdUser = await User.findOne({ email: 'google.new@ricoz.test' });
    assert.equal(createdUser.googleId, 'g-new-user');
    assert.equal(createdUser.role, 'Employee');
    assert.ok(!createdUser.password, 'Google users should not get an unnecessary stored password');

    const createdMe = await api('GET', '/api/users/me', { token: created.data.token });
    assert.equal(createdMe.status, 200);

    // 3) Existing email account is linked, existing (admin-assigned) role kept.
    const existingUser = await User.create({
      name: 'Link Target',
      email: 'link.me@ricoz.test',
      password: 'Password123',
      role: 'Manager'
    });
    googleAuth.verifyGoogleIdToken.payload = {
      sub: 'g-link-existing',
      email: 'LINK.ME@ricoz.test',
      email_verified: true,
      name: 'Link Target'
    };
    const linked = await api('POST', '/api/auth/google', { body: { credential: 'token-link' } });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.role, 'Manager');
    const reloaded = await User.findById(existingUser._id);
    assert.equal(reloaded.googleId, 'g-link-existing');
    assert.ok(await reloaded.matchPassword('Password123'), 'linking must not change the existing password');

    // 4) Inactive account is rejected.
    await User.create({
      name: 'Inactive User',
      email: 'inactive@ricoz.test',
      password: 'Password123',
      status: 'Inactive'
    });
    googleAuth.verifyGoogleIdToken.payload = {
      sub: 'g-inactive',
      email: 'inactive@ricoz.test',
      email_verified: true,
      name: 'Inactive User'
    };
    const inactive = await api('POST', '/api/auth/google', { body: { credential: 'token-inactive' } });
    assert.equal(inactive.status, 401);
    assert.match(inactive.data.message, /inactive/i);

    assert.deepEqual(seenCredentials, [
      'token-unverified',
      'token-new-user',
      'token-link',
      'token-inactive'
    ]);
  } finally {
    googleAuth.verifyGoogleIdToken = originalVerifyGoogleIdToken;
  }
});

test('forgot-password returns the same safe response for known and unknown emails', async () => {
  const unknown = await api('POST', '/api/auth/forgot-password', {
    body: { email: 'definitely-not-registered@ricoz.test' }
  });
  const known = await api('POST', '/api/auth/forgot-password', {
    body: { email: EMPLOYEE_EMAIL }
  });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.equal(unknown.data.message, known.data.message);

  // Input validation keeps its own (non-enumerating) response.
  const missing = await api('POST', '/api/auth/forgot-password', { body: {} });
  assert.equal(missing.status, 400);

  // Unknown email must not generate any reset token.
  const unknownUser = await User.findOne({ email: 'definitely-not-registered@ricoz.test' });
  assert.equal(unknownUser, null);
});

test('forgot-password stores only a hash of the token and emails a reset link', async () => {
  capturedResetLink = null;
  const response = await api('POST', '/api/auth/forgot-password', { body: { email: EMPLOYEE_EMAIL } });
  assert.equal(response.status, 200);
  assert.ok(capturedResetLink, 'reset email should have been "sent"');

  const rawToken = new URL(capturedResetLink).searchParams.get('token');
  assert.ok(rawToken && rawToken.length === 64);

  const user = await User.findOne({ email: EMPLOYEE_EMAIL })
    .select('+passwordResetToken +passwordResetExpires');
  assert.ok(user.passwordResetToken, 'hashed token must be stored');
  assert.notEqual(user.passwordResetToken, rawToken);
  assert.equal(user.passwordResetToken, hashResetToken(rawToken));
  const ttlMinutes = (user.passwordResetExpires.getTime() - Date.now()) / 60000;
  assert.ok(ttlMinutes > RESET_TOKEN_TTL_MINUTES - 1 && ttlMinutes <= RESET_TOKEN_TTL_MINUTES);
});

test('valid reset token changes the password, blocks reuse and revokes old sessions', async () => {
  const rawToken = new URL(capturedResetLink).searchParams.get('token');

  const reset = await api('POST', '/api/auth/reset-password', {
    body: { token: rawToken, password: EMPLOYEE_NEW_PASSWORD }
  });
  assert.equal(reset.status, 200);

  // Token is single-use.
  const reuse = await api('POST', '/api/auth/reset-password', {
    body: { token: rawToken, password: 'AnotherPass123' }
  });
  assert.equal(reuse.status, 400);
  assert.match(reuse.data.message, /invalid or has expired/);

  // Old password no longer works, new password does.
  const oldLogin = await api('POST', '/api/auth/login', {
    body: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD }
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api('POST', '/api/auth/login', {
    body: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_NEW_PASSWORD }
  });
  assert.equal(newLogin.status, 200);

  // Session issued before the reset is revoked; the new one works.
  const revoked = await api('GET', '/api/users/me', { token: employeeToken });
  assert.equal(revoked.status, 401);

  const active = await api('GET', '/api/users/me', { token: newLogin.data.token });
  assert.equal(active.status, 200);
  employeeToken = newLogin.data.token;
});

test('expired and malformed reset tokens are rejected with a friendly message', async () => {
  const { token } = generateResetToken();
  const user = await User.findOne({ email: EMPLOYEE_EMAIL });
  user.passwordResetToken = hashResetToken(token);
  user.passwordResetExpires = new Date(Date.now() - 1000);
  await user.save();

  const expired = await api('POST', '/api/auth/reset-password', {
    body: { token, password: 'BrandNewPass123' }
  });
  assert.equal(expired.status, 400);
  assert.match(expired.data.message, /invalid or has expired/);

  const malformed = await api('POST', '/api/auth/reset-password', {
    body: { token: 'not-a-real-token', password: 'BrandNewPass123' }
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.data.message, /invalid or has expired/);

  // Password must still meet server-side requirements.
  capturedResetLink = null;
  await api('POST', '/api/auth/forgot-password', { body: { email: EMPLOYEE_EMAIL } });
  const validToken = new URL(capturedResetLink).searchParams.get('token');
  const weak = await api('POST', '/api/auth/reset-password', {
    body: { token: validToken, password: 'abc' }
  });
  assert.equal(weak.status, 400);
  assert.match(weak.data.message, /at least 6/);
});

test('JWT and RBAC behaviour is unchanged for protected routes', async () => {
  const login = await api('POST', '/api/auth/login', {
    body: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_NEW_PASSWORD }
  });
  assert.equal(login.status, 200);
  employeeToken = login.data.token;

  const me = await api('GET', '/api/users/me', { token: employeeToken });
  assert.equal(me.status, 200);

  const adminOnly = await api('GET', '/api/users', { token: employeeToken });
  assert.equal(adminOnly.status, 403);

  const managerOnly = await api('GET', '/api/users/directory', { token: employeeToken });
  assert.equal(managerOnly.status, 403);

  const noToken = await api('GET', '/api/users/me');
  assert.equal(noToken.status, 401);
});

test('forgot-password requests are rate limited', async () => {
  let sawRateLimit = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await api('POST', '/api/auth/forgot-password', {
      body: { email: `rate-probe-${attempt}@ricoz.test` }
    });
    if (response.status === 429) {
      sawRateLimit = true;
      assert.match(response.data.message, /Too many/i);
      assert.ok(response.headers.get('retry-after'));
      break;
    }
    assert.equal(response.status, 200);
  }
  assert.ok(sawRateLimit, 'expected a 429 after exceeding the forgot-password rate limit');
});
