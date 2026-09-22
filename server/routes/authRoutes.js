const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const googleAuth = require('../utils/googleAuth');
const mailer = require('../utils/mailer');
const createRateLimiter = require('../middleware/rateLimit');
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

// Identical response whether or not the email exists (no account enumeration).
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

const INVALID_RESET_LINK_MESSAGE =
  'This reset link is invalid or has expired. Please request a new one.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_PATTERN = /^[a-fA-F0-9]{64}$/;

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, department } = req.body;
    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    // Role is always 'Employee' at registration; Admin/Manager roles are only
    // ever assigned by an existing Admin through the user management routes.
    const user = await User.create({ name, email, password, role: 'Employee', department });
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

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (user && user.status === 'Inactive') {
      return res.status(401).json({ message: 'This account is inactive. Contact an administrator.' });
    }
    if (user && user.password && (await user.matchPassword(password))) {
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
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    next(error);
  }
});

router.post('/google', async (req, res, next) => {
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

  // 3) Find-or-create the user and issue the existing JWT. Database failures
  //    fall through to the central error handler (no internals exposed).
  try {
    const email = payload.email.toLowerCase();
    let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] });

    if (user && user.status === 'Inactive') {
      return res.status(401).json({ message: 'This account is inactive. Contact an administrator.' });
    }

    if (!user) {
      // New Google users always become Employees: they can never self-register
      // as Admin or Manager. Only the verified Google identity is stored.
      user = await User.create({
        name: payload.name || email.split('@')[0],
        email,
        googleId: payload.sub,
        role: 'Employee'
      });
    } else if (!user.googleId) {
      // Existing email account: safely link it to this Google identity.
      user.googleId = payload.sub;
      await user.save();
    }

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
  } catch (error) {
    next(error);
  }
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
        // Log only the reason - never the token or reset link.
        console.error('Password reset email could not be sent:', error.message);
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
