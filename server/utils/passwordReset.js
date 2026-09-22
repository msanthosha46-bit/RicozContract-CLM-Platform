const crypto = require('crypto');

// Password reset tokens are short-lived: 15 minutes.
const RESET_TOKEN_TTL_MINUTES = 15;
const RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MINUTES * 60 * 1000;

// Hashing (not encryption) is used because the raw token is only ever held
// in memory and in the emailed link; the database only ever sees the hash.
const hashResetToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

// Generates a cryptographically random raw token plus its stored artifacts.
const generateResetToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
  };
};

// CLIENT_URL may contain several comma-separated origins (also used for CORS);
// the reset link points at the first one.
const getClientBaseUrl = () => {
  const raw = process.env.CLIENT_URL || 'http://localhost:3000';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
};

const buildResetLink = (token) =>
  `${getClientBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

// Server-side password policy. Kept consistent with the client-side rules
// already used by Register (min 6 characters).
const validatePassword = (password) => {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }
  if (password.length < 6) {
    return 'Password must be at least 6 characters.';
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  return null;
};

module.exports = {
  RESET_TOKEN_TTL_MINUTES,
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  buildResetLink,
  validatePassword
};
