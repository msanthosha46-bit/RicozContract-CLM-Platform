const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const googleAuth = require('../utils/googleAuth');
const mailer = require('../utils/mailer');
const createRateLimiter = require('../middleware/rateLimit');
const GoogleOtpChallenge = require('../models/GoogleOtpChallenge');
const {
  OTP_TTL_SECONDS,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  RESEND_COOLDOWN_MS,
  OTP_MAX_RESENDS,
  OTP_PATTERN,
  CHALLENGE_ID_PATTERN,
  generateOtp,
  generateChallengeId,
  hashOtp,
  otpHashesMatch,
  maskEmail
} = require('../utils/googleOtp');
const {
  RESET_TOKEN_TTL_MINUTES,
  generateResetToken,
  hashResetToken,
  buildResetLink,
  validatePassword
} = require('../utils/passwordReset');

// tokenVersion travels inside the JWT so sessions issued before a password
// reset can be revoked by the auth middleware.
const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

const forgotPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests. Please try again in 15 minutes.'
});

const resetPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many password reset attempts. Please try again in 15 minutes.'
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again in 15 minutes.'
});

// Public sign-up and Google entry points are also throttled so the API cannot
// be used to mass-create accounts or to hammer Google's token verification.
const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many account requests. Please try again in 15 minutes.'
});

// Public Google entry points are throttled so the API cannot be used to mass
// create OTP challenges, to brute-force codes across many challenge ids from
// one connection, or to hammer Google's token verification. The per-challenge
// attempt cap (not the button on the client) is the real defence against
// brute force; these limits are the second layer.
const googleBeginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many Google sign-in attempts. Please try again in 15 minutes.'
});

const googleVerifyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many verification attempts. Please try again in 15 minutes.'
});

const googleResendLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many verification code requests. Please try again in 15 minutes.'
});

// One response for every failed sign-in, so neither the account state nor the
// password can be probed from the response.
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// A real bcrypt hash of an unguessable value. Comparing against it when no
// account matches keeps the response time of an unknown address close to that
// of a wrong password, which would otherwise reveal which emails are registered.
let decoyHashPromise = null;
const getDecoyHash = () => {
  if (!decoyHashPromise) {
    decoyHashPromise = require('bcryptjs')
      .hash(`decoy-${require('crypto').randomBytes(24).toString('hex')}`, 10);
  }
  return decoyHashPromise;
};

// Identical response whether or not the email exists (no account enumeration).
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

const INVALID_RESET_LINK_MESSAGE =
  'This reset link is invalid or has expired. Please request a new one.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { name, email, password, department } = req.body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const userExists = await User.findOne({ email: normalizedEmail });
    // Same wording whether the address is free or taken, so the endpoint
    // cannot be used to discover which emails hold an account.
    if (userExists) return res.status(400).json({ message: 'Unable to create an account with those details.' });

    // Role is always 'Employee' at registration; Admin/Manager roles are only
    // ever assigned by an existing Admin through the user management routes.
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      role: 'Employee',
      department
    });
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
      status: user.status,
      preferences: user.preferences,
      token: generateToken(user)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !user.password) {
      // Burn a comparable amount of CPU so a missing account and a wrong
      // password take about the same time to answer.
      await require('bcryptjs').compare(String(password ?? ''), await getDecoyHash());
      return res.status(401).json({ message: INVALID_CREDENTIALS_MESSAGE });
    }
    // The password is always compared, even for a disabled account. Rejecting
    // an inactive user before the comparison would answer orders of magnitude
    // faster than a wrong password and so reveal that the address exists and
    // is switched off. All four outcomes below cost one bcrypt comparison.
    if (await user.matchPassword(password)) {
      if (user.status === 'Inactive') {
        return res.status(401).json({ message: INVALID_CREDENTIALS_MESSAGE });
      }
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        status: user.status,
        preferences: user.preferences,
        token: generateToken(user)
      });
    } else {
      res.status(401).json({ message: INVALID_CREDENTIALS_MESSAGE });
    }
  } catch (error) {
    next(error);
  }
});

// The existing Google account resolution: find by googleId OR email, reject
// inactive accounts, link an existing email account to this Google identity,
// and create new users as Employees. This runs ONLY after the OTP has been
// verified; it requires the verified identity (googleSub + email) captured on
// the challenge, never a browser-supplied value.
const resolveGoogleUser = async ({ googleSub, email, name }) => {
  let user = await User.findOne({ $or: [{ googleId: googleSub }, { email }] });

  if (user) {
    if (user.status === 'Inactive') {
      const error = new Error('This account is inactive. Contact an administrator.');
      error.status = 401;
      error.expose = true;
      throw error;
    }
    if (!user.googleId) {
      user.googleId = googleSub;
      await user.save();
    }
    return user;
  }

  try {
    return await User.create({
      name: name || email.split('@')[0],
      email,
      googleId: googleSub,
      role: 'Employee'
    });
  } catch (error) {
    // Two verifications may race to create the same brand-new account. Re-fetch
    // the winner instead of inventing a transaction layer, and continue only if
    // it really is this verified identity.
    if (error.code !== 11000) throw error;
    const winner = await User.findOne({ $or: [{ googleId: googleSub }, { email }] });
    if (!winner) {
      const safeError = new Error('Unable to sign in with Google.');
      safeError.status = 401;
      safeError.expose = true;
      throw safeError;
    }
    if (winner.status === 'Inactive') {
      const inactiveError = new Error('This account is inactive. Contact an administrator.');
      inactiveError.status = 401;
      inactiveError.expose = true;
      throw inactiveError;
    }
    if (!winner.googleId) {
      winner.googleId = googleSub;
      await winner.save();
    }
    return winner;
  }
};

// Step 1: verify the Google identity, create an OTP challenge bound to it and
// email the code. No JWT and no session yet; the identity is only captured on
// the challenge. The same success shape is returned for new and existing
// emails so the endpoint cannot be used to probe which addresses hold accounts.
router.post('/google/begin', googleBeginLimiter, async (req, res, next) => {
  const { credential } = req.body || {};

  if (!googleAuth.getGoogleClientId()) {
    return res.status(503).json({ message: 'Google Sign-In is not configured' });
  }
  if (!credential || typeof credential !== 'string' || !credential.trim()) {
    return res.status(400).json({ message: 'A Google credential is required' });
  }
  if (credential.length > 8192) {
    return res.status(400).json({ message: 'A Google credential is required' });
  }

  // 1) Verify the Google ID token server-side (signature, issuer, audience).
  let payload;
  try {
    payload = await googleAuth.verifyGoogleIdToken(credential.trim());
  } catch (error) {
    // Invalid / forged / expired / wrong-audience token. Message is safe to log.
    console.warn('Google ID token verification failed:', error.message);
    return res.status(401).json({ message: 'Google Sign-In could not be verified' });
  }

  // 2) Only trust verified information from the Google payload.
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    return res.status(401).json({ message: 'Google account email could not be verified' });
  }

  try {
    const email = payload.email.toLowerCase();
    const otp = generateOtp();
    const challenge = await GoogleOtpChallenge.create({
      challengeId: generateChallengeId(),
      googleSub: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name.trim() : '',
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      // The cooldown announced to the client starts with the first code.
      resendAvailableAt: new Date(Date.now() + RESEND_COOLDOWN_MS),
      resendCount: 0
    });

    try {
      await mailer.sendOtpEmail({ to: email, otp, expiresInMinutes: OTP_TTL_SECONDS / 60 });
    } catch (error) {
      // describeEmailError is the only sanitised form: transports tried and
      // their reasons, never the code, a credential, a key or the recipient.
      console.error('Google sign-in verification code email could not be sent:', mailer.describeEmailError(error));
      await GoogleOtpChallenge.deleteOne({ _id: challenge._id }).catch(() => {});
      return res.status(503).json({ message: 'Unable to send the verification code. Please try again.' });
    }

    // Only what the client needs for the next step. The code, the google sub,
    // any role and any account existence are all intentionally absent.
    return res.json({
      challengeId: challenge.challengeId,
      email: maskEmail(email),
      expiresIn: OTP_TTL_SECONDS,
      resendAvailableIn: RESEND_COOLDOWN_SECONDS
    });
  } catch (error) {
    next(error);
  }
});

// Step 2: verify the OTP the user entered against the challenge bound to the
// verified Google identity. A client-supplied email is deliberately ignored;
// the challenge's googleSub/email are the only identity used.
router.post('/google/verify-otp', googleVerifyLimiter, async (req, res, next) => {
  const { challengeId, otp } = req.body || {};

  if (typeof challengeId !== 'string' || !CHALLENGE_ID_PATTERN.test(challengeId)) {
    return res.status(400).json({ message: 'This verification session is invalid or has expired.' });
  }
  if (typeof otp !== 'string' || !OTP_PATTERN.test(otp)) {
    return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
  }

  // Read once so each failure can be explained without revealing internals.
  const challenge = await GoogleOtpChallenge.findOne({ challengeId });
  if (!challenge || challenge.usedAt) {
    return res.status(400).json({ message: 'This verification session is invalid or has expired.' });
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    return res.status(400).json({ message: 'This verification code has expired. Request a new code.' });
  }
  if (challenge.attempts >= challenge.maxAttempts) {
    return res.status(400).json({ message: 'Too many attempts. Request a new verification code.' });
  }

  // Atomically consume one attempt. The filter refuses a challenge that was
  // already used, just expired, or has already hit the attempt cap.
  const updated = await GoogleOtpChallenge.findOneAndUpdate(
    {
      challengeId,
      usedAt: null,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: OTP_MAX_ATTEMPTS }
    },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!updated) {
    return res.status(400).json({ message: 'This verification session is invalid or has expired.' });
  }

  // Constant-time comparison against the stored hash.
  if (!otpHashesMatch(otp, updated.otpHash)) {
    if (updated.attempts >= updated.maxAttempts) {
      return res.status(400).json({ message: 'Too many attempts. Request a new verification code.' });
    }
    return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
  }

  // Success: consume the challenge NOW (single use), then resolve the account.
  await GoogleOtpChallenge.updateOne({ _id: updated._id }, { usedAt: new Date() });

  let user;
  try {
    user = await resolveGoogleUser({
      googleSub: updated.googleSub,
      email: updated.email,
      name: updated.name
    });
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.expose) {
      return res.status(error.status).json({ message: error.message });
    }
    return next(error);
  }

  // The existing JWT and session behaviour, identical to every other login path.
  return res.json({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    status: user.status,
    preferences: user.preferences,
    token: generateToken(user)
  });
});

// Step 3: re-send a code for the same challenge. The old code is only
// invalidated after a successful send, so a transport failure never leaves the
// user with no working code (mirrors the password-reset mailer behaviour).
router.post('/google/resend-otp', googleResendLimiter, async (req, res, next) => {
  const { challengeId } = req.body || {};

  if (typeof challengeId !== 'string' || !CHALLENGE_ID_PATTERN.test(challengeId)) {
    return res.status(400).json({ message: 'This verification session is invalid or has expired.' });
  }

  const challenge = await GoogleOtpChallenge.findOne({ challengeId });
  if (!challenge || challenge.usedAt) {
    return res.status(400).json({ message: 'This verification session is invalid or has expired.' });
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    return res.status(400).json({ message: 'This verification code has expired. Request a new code.' });
  }
  if (challenge.resendCount >= OTP_MAX_RESENDS) {
    return res.status(429).json({ message: 'Too many verification codes requested. Please try again later.' });
  }

  const waitMs = challenge.resendAvailableAt.getTime() - Date.now();
  if (waitMs > 0) {
    res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
    return res.status(429).json({ message: 'Please wait before requesting another verification code.' });
  }

  const otp = generateOtp();
  try {
    await mailer.sendOtpEmail({ to: challenge.email, otp, expiresInMinutes: OTP_TTL_SECONDS / 60 });
  } catch (error) {
    console.error('Google sign-in verification code resend could not be sent:', mailer.describeEmailError(error));
    return res.status(503).json({ message: 'Unable to send the verification code. Please try again.' });
  }

  await GoogleOtpChallenge.updateOne(
    { _id: challenge._id },
    {
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      resendCount: challenge.resendCount + 1,
      resendAvailableAt: new Date(Date.now() + RESEND_COOLDOWN_MS)
    }
  );

  return res.json({ message: 'New verification code sent.', resendAvailableIn: RESEND_COOLDOWN_SECONDS });
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (user) {
      try {
        // The hash is stored before the send is attempted, so a transport
        // failure leaves the token intact and still usable. Clearing it here
        // would invalidate a token the user may already have received.
        const { token, tokenHash, expiresAt } = generateResetToken();
        user.passwordResetToken = tokenHash; // raw token is never stored
        user.passwordResetExpires = expiresAt;
        await user.save();

        await mailer.sendPasswordResetEmail({
          to: user.email,
          resetLink: buildResetLink(token),
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES
        });
      } catch (error) {
        // describeEmailError is the only sanitised form: the transports tried
        // and their reasons, never the token, the reset link, the API key or
        // the recipient address. The stored token above stays valid.
        console.error('Password reset email could not be sent:', mailer.describeEmailError(error));
      }
    }

    // Same response for existing and non-existing emails.
    return res.json({ message: FORGOT_PASSWORD_MESSAGE });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', resetPasswordLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};

    if (typeof token !== 'string' || !RESET_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ message: INVALID_RESET_LINK_MESSAGE });
    }

    // Token exists, is valid and has not expired (or has already been used,
    // since successful resets clear the stored hash).
    const user = await User.findOne({
      passwordResetToken: hashResetToken(token),
      passwordResetExpires: { $gt: new Date() }
    });
    if (!user) {
      return res.status(400).json({ message: INVALID_RESET_LINK_MESSAGE });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    user.password = password; // hashed by the existing bcrypt pre-save hook
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    // Invalidate sessions issued before this reset (JWT token versioning).
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res.json({ message: 'Your password has been reset. You can now sign in.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
