const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// Load server/.env so JWT_SECRET and GOOGLE_CLIENT_ID are available in tests.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// CI-safe fallbacks: provide non-production test values when the env file is
// absent. Real local/production values are never touched.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
}
if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
}

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const GoogleOtpChallenge = require('../models/GoogleOtpChallenge');
const authRoutes = require('../routes/authRoutes');
const userRoutes = require('../routes/userRoutes');
const mailer = require('../utils/mailer');
const googleAuth = require('../utils/googleAuth');
const { hashOtp, OTP_TTL_SECONDS, OTP_TTL_MS } = require('../utils/googleOtp');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_google_otp_test';

const PASSWORD = 'Secret123!';

// The real one-time code is captured instead of emailed, exactly like the
// reset link is captured elsewhere in the suite.
let capturedOtp = null;
let capturedOtpTo = null;

const originalSendOtpEmail = mailer.sendOtpEmail;
const originalVerifyGoogleIdToken = googleAuth.verifyGoogleIdToken;

const captureOtpEmail = async ({ to, otp }) => {
  capturedOtp = otp;
  capturedOtpTo = to;
};

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

// The verifyGoogleIdToken stub: each test sets `payload` (or keeps null to make
// the verification throw, like a forged / expired / wrong-audience token).
const setGooglePayload = (payload) => {
  googleAuth.verifyGoogleIdToken.payload = payload;
  return payload;
};

const begin = async (credential = 'test-id-token') => {
  capturedOtp = null;
  capturedOtpTo = null;
  return api('POST', '/api/auth/google/begin', { body: { credential } });
};

const verify = async (challengeId, otp, { email } = {}) =>
  api('POST', '/api/auth/google/verify-otp', {
    body: email === undefined ? { challengeId, otp } : { challengeId, otp, email }
  });

const resend = async (challengeId) =>
  api('POST', '/api/auth/google/resend-otp', { body: { challengeId } });

const findChallenge = async (challengeId) => GoogleOtpChallenge.findOne({ challengeId });

test.before(async () => {
  assert.ok(process.env.JWT_SECRET, 'JWT_SECRET must be set in server/.env to run these tests');
  assert.ok(process.env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID must be set in server/.env to run these tests');

  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  await startTestApp();
  baseURL = `http://127.0.0.1:${server.address().port}`;

  // Capture the code instead of sending real email during tests.
  mailer.sendOtpEmail = captureOtpEmail;

  // Default stub: verifies with a fixed identity so `begin` calls work without
  // every test having to install its own stub.
  googleAuth.verifyGoogleIdToken = async () => {
    if (!googleAuth.verifyGoogleIdToken.payload) throw new Error('stub verification failed');
    return googleAuth.verifyGoogleIdToken.payload;
  };
});

test.after(async () => {
  mailer.sendOtpEmail = originalSendOtpEmail;
  googleAuth.verifyGoogleIdToken = originalVerifyGoogleIdToken;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---------- BEGIN ----------

test('begin creates a challenge, stores only a hash, and returns no JWT or account', async () => {
  setGooglePayload({
    sub: 'g-begin',
    email: 'begin@ricoz.test',
    email_verified: true,
    name: 'Begin User'
  });
  const response = await begin('token-begin');
  assert.equal(response.status, 200);
  assert.ok(response.data.challengeId);
  assert.equal(response.data.email, 'b***@ricoz.test');
  assert.equal(response.data.expiresIn, OTP_TTL_SECONDS);
  assert.equal(response.data.token, undefined, 'no JWT may be issued at begin');
  assert.equal(response.data.googleSub, undefined);

  // The code was sent to the verified address and is not in the response.
  assert.equal(capturedOtpTo, 'begin@ricoz.test');
  assert.match(String(capturedOtp), /^\d{6}$/);
  assert.ok(!JSON.stringify(response.data).includes(String(capturedOtp)));

  // Only the SHA-256 hash is stored.
  const challenge = await findChallenge(response.data.challengeId);
  assert.ok(challenge);
  assert.equal(challenge.googleSub, 'g-begin');
  assert.equal(challenge.email, 'begin@ricoz.test');
  assert.equal(challenge.otpHash, hashOtp(String(capturedOtp)));
  assert.notEqual(challenge.otpHash, String(capturedOtp));
  assert.equal(challenge.attempts, 0);
  assert.equal(challenge.usedAt, null);

  // No user exists yet.
  const user = await User.findOne({ email: 'begin@ricoz.test' });
  assert.equal(user, null);
});

test('begin returns the same shape for new and existing emails (no enumeration)', async () => {
  const existing = await User.create({ name: 'Existing', email: 'known@ricoz.test', password: PASSWORD });

  setGooglePayload({ sub: 'g-new-shape', email: 'brand.new@ricoz.test', email_verified: true });
  const fresh = await begin('token-fresh');
  assert.equal(fresh.status, 200);

  setGooglePayload({ sub: 'g-known-shape', email: 'known@ricoz.test', email_verified: true });
  const known = await begin('token-known');
  assert.equal(known.status, 200);

  // Same fields, and no mention of whether an account exists.
  assert.deepEqual(
    Object.keys(fresh.data).sort(),
    Object.keys(known.data).sort()
  );
  assert.ok(known.data.challengeId);
  assert.equal(known.data.email, 'k***@ricoz.test');
  assert.equal(known.data.token, undefined);
  assert.equal(known.data.role, undefined);

  const stillThere = await User.findById(existing._id);
  assert.equal(stillThere.googleId, undefined, 'begin must not link or touch the account');
});

test('begin rejects missing, invalid and unverified credentials', async () => {
  const missing = await api('POST', '/api/auth/google/begin', { body: {} });
  assert.equal(missing.status, 400);

  setGooglePayload(null);
  const invalid = await begin('garbage.token.value');
  assert.equal(invalid.status, 401);
  assert.equal(invalid.data.message, 'Google Sign-In could not be verified');

  setGooglePayload({ sub: 'g-no-email', email_verified: true });
  const noEmail = await begin('token-no-email');
  assert.equal(noEmail.status, 401);
  assert.match(noEmail.data.message, /email could not be verified/);

  setGooglePayload({ sub: 'g-unverified', email: 'u@ricoz.test', email_verified: false });
  const unverified = await begin('token-unverified');
  assert.equal(unverified.status, 401);
  assert.match(unverified.data.message, /email could not be verified/);
});

// ---------- VERIFY ----------

test('correct OTP authenticates an existing Google user with a working JWT', async () => {
  const googleUser = await User.create({ name: 'Google Alum', email: 'alum@ricoz.test', password: PASSWORD, googleId: 'g-alum' });
  setGooglePayload({ sub: 'g-alum', email: 'alum@ricoz.test', email_verified: true });
  const started = await begin('token-alum');
  assert.equal(started.status, 200);

  const ok = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, 'alum@ricoz.test');
  assert.ok(ok.data.token);
  assert.equal(ok.data.role, 'Employee');

  const reloaded = await User.findById(googleUser._id);
  assert.equal(reloaded.googleId, 'g-alum', 'an existing Google user keeps its id');

  const me = await api('GET', '/api/users/me', { token: ok.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'alum@ricoz.test');
});

test('correct OTP links an existing password account and preserves its role', async () => {
  const existing = await User.create({ name: 'Link Target', email: 'link.me@ricoz.test', password: PASSWORD, role: 'Manager' });
  setGooglePayload({ sub: 'g-link', email: 'LINK.ME@ricoz.test', email_verified: true, name: 'Link Target' });
  const started = await begin('token-link');
  assert.equal(started.status, 200);

  const ok = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.role, 'Manager', 'existing role is preserved after OTP');

  const reloaded = await User.findById(existing._id);
  assert.equal(reloaded.googleId, 'g-link');
  assert.ok(await reloaded.matchPassword(PASSWORD), 'linking must not change the password');
});

test('correct OTP creates a brand-new Google user as Employee and stores no password', async () => {
  setGooglePayload({ sub: 'g-new-user', email: 'google.new@ricoz.test', email_verified: true, name: 'Google New' });
  const started = await begin('token-new-user');
  assert.equal(started.status, 200);

  const ok = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.role, 'Employee');
  assert.equal(ok.data.email, 'google.new@ricoz.test');
  assert.ok(ok.data.token);

  const created = await User.findOne({ email: 'google.new@ricoz.test' });
  assert.ok(created);
  assert.equal(created.googleId, 'g-new-user');
  assert.equal(created.role, 'Employee');
  assert.equal(created.name, 'Google New');
  assert.ok(!created.password, 'Google users must not get a password');
});

test('wrong OTP is rejected, attempts increment, and the fifth failure blocks the challenge', async () => {
  setGooglePayload({ sub: 'g-brute', email: 'brute.force@ricoz.test', email_verified: true });
  const started = await begin('token-brute');
  assert.equal(started.status, 200);

  // First four wrong attempts are "invalid code" and count.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const wrong = await verify(started.data.challengeId, '000000');
    assert.equal(wrong.status, 400);
    assert.equal(wrong.data.message, 'Invalid verification code. Please try again.');
  }
  const challenge = await findChallenge(started.data.challengeId);
  assert.equal(challenge.attempts, 4);

  // The fifth wrong attempt consumes the cap; the next request is blocked.
  const fifth = await verify(started.data.challengeId, '000000');
  assert.equal(fifth.status, 400);
  const blocked = await verify(started.data.challengeId, '000000');
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /Too many attempts/);

  // Even the real code is refused now.
  const realCode = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(realCode.status, 400);
  assert.match(realCode.data.message, /Too many attempts/);

  // A malformed code is rejected before it reaches the challenge.
  const malformed = await verify(started.data.challengeId, '12345');
  assert.equal(malformed.status, 400);

  // The brand-new email must never have been created.
  const user = await User.findOne({ email: 'brute.force@ricoz.test' });
  assert.equal(user, null, 'no account may exist before OTP succeeds');
});

test('an expired challenge is rejected and cannot authenticate', async () => {
  setGooglePayload({ sub: 'g-expired', email: 'expired@ricoz.test', email_verified: true });
  const started = await begin('token-expired');
  assert.equal(started.status, 200);

  await GoogleOtpChallenge.updateOne(
    { challengeId: started.data.challengeId },
    { expiresAt: new Date(Date.now() - 1000) }
  );

  const expired = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(expired.status, 400);
  assert.match(expired.data.message, /expired/);

  const user = await User.findOne({ email: 'expired@ricoz.test' });
  assert.equal(user, null);
});

test('a consumed OTP cannot be replayed', async () => {
  setGooglePayload({ sub: 'g-replay', email: 'replay@ricoz.test', email_verified: true });
  const started = await begin('token-replay');
  assert.equal(started.status, 200);
  const code = String(capturedOtp);

  const first = await verify(started.data.challengeId, code);
  assert.equal(first.status, 200);

  const challenge = await findChallenge(started.data.challengeId);
  assert.ok(challenge.usedAt, 'the challenge must be consumed');

  const second = await verify(started.data.challengeId, code);
  assert.equal(second.status, 400);
  assert.match(second.data.message, /invalid or has expired/);
});

test('a forged challenge id is rejected', async () => {
  const forged = await verify('f'.repeat(48), '123456');
  assert.equal(forged.status, 400);
  assert.match(forged.data.message, /invalid or has expired/);
});

test('a client-supplied email cannot change the verified identity', async () => {
  setGooglePayload({ sub: 'g-identity', email: 'identity@ricoz.test', email_verified: true });
  const started = await begin('token-identity');
  assert.equal(started.status, 200);

  // The attacker tries to bind the code to someone else's address. The route
  // ignores the body's email entirely; the challenge's verified email wins.
  const hijack = await verify(started.data.challengeId, String(capturedOtp), { email: 'victim@ricoz.test' });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.data.email, 'identity@ricoz.test');

  const victim = await User.findOne({ email: 'victim@ricoz.test' });
  assert.equal(victim, null, 'the supplied email must never be used to create an account');
});

test('inactive accounts are rejected after OTP verification', async () => {
  await User.create({ name: 'Inactive', email: 'inactive@ricoz.test', password: PASSWORD, status: 'Inactive' });
  setGooglePayload({ sub: 'g-inactive', email: 'inactive@ricoz.test', email_verified: true });
  const started = await begin('token-inactive');
  assert.equal(started.status, 200);

  const ok = await verify(started.data.challengeId, String(capturedOtp));
  assert.equal(ok.status, 401);
  assert.match(ok.data.message, /inactive/i);
  assert.equal(ok.data.token, undefined, 'an inactive account must never be handed a JWT');
});

// ---------- RESEND ----------

test('resend before the cooldown ends returns 429 with Retry-After', async () => {
  setGooglePayload({ sub: 'g-cooldown', email: 'cooldown@ricoz.test', email_verified: true });
  const started = await begin('token-cooldown');
  assert.equal(started.status, 200);

  const early = await resend(started.data.challengeId);
  assert.equal(early.status, 429);
  assert.ok(Number(early.headers.get('retry-after')) > 0, 'Retry-After must tell the client how long to wait');
  assert.match(early.data.message, /Please wait/);
});

test('resend after the cooldown issues a new code and invalidates the old one', async () => {
  setGooglePayload({ sub: 'g-resend', email: 'resend@ricoz.test', email_verified: true });
  const started = await begin('token-resend');
  assert.equal(started.status, 200);
  const firstCode = String(capturedOtp);

  // Simulate the cooldown elapsing.
  await GoogleOtpChallenge.updateOne(
    { challengeId: started.data.challengeId },
    { resendAvailableAt: new Date(Date.now() - 1000) }
  );

  const again = await resend(started.data.challengeId);
  assert.equal(again.status, 200);
  assert.equal(again.data.resendAvailableIn, 60);
  const secondCode = String(capturedOtp);
  assert.notEqual(secondCode, firstCode, 'resend must issue a fresh code');

  const challenge = await findChallenge(started.data.challengeId);
  assert.equal(challenge.otpHash, hashOtp(secondCode));
  assert.equal(challenge.resendCount, 1);
  assert.equal(challenge.attempts, 0, 'attempts reset with the new code');
  assert.deepEqual(challenge.resendAvailableAt.getTime() > Date.now(), true);

  // The old code no longer works; the new one does.
  const oldCode = await verify(started.data.challengeId, firstCode);
  assert.equal(oldCode.status, 400);
  const newCode = await verify(started.data.challengeId, secondCode);
  assert.equal(newCode.status, 200);
});

test('the maximum resend count is enforced', async () => {
  setGooglePayload({ sub: 'g-max-resend', email: 'maxresend@ricoz.test', email_verified: true });
  const started = await begin('token-max-resend');
  assert.equal(started.status, 200);

  for (let count = 1; count <= 5; count += 1) {
    await GoogleOtpChallenge.updateOne(
      { challengeId: started.data.challengeId },
      { resendAvailableAt: new Date(Date.now() - 1000) }
    );
    const again = await resend(started.data.challengeId);
    assert.equal(again.status, 200, `resend ${count} should succeed`);
  }

  await GoogleOtpChallenge.updateOne(
    { challengeId: started.data.challengeId },
    { resendAvailableAt: new Date(Date.now() - 1000) }
  );
  const capped = await resend(started.data.challengeId);
  assert.equal(capped.status, 429);
  assert.match(capped.data.message, /Too many verification codes requested/);

  const challenge = await findChallenge(started.data.challengeId);
  assert.equal(challenge.resendCount, 5);
});

// ---------- RATE LIMITS (LAST: the begin flood caps the shared window) ----------

test('the begin endpoint is rate limited by IP, server-side', async () => {
  // Every request in this file has already visited /google/begin (the shared,
  // per-process window is max 20). Keep flooding until the limiter answers 429.
  let saw429 = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    setGooglePayload({ sub: `g-flood-${attempt}`, email: `flood.${attempt}@ricoz.test`, email_verified: true });
    const response = await begin(`token-flood-${attempt}`);
    if (response.status === 429) {
      saw429 = true;
      assert.match(response.data.message, /Too many/);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      break;
    }
  }
  assert.ok(saw429, 'expected a 429 after exceeding the begin rate limit');
});