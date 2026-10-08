const crypto = require('crypto');

// One-time code for the Google sign-in verification step.
//
// The code is six digits drawn from a cryptographically secure source so the
// space a brute-force attacker must search is real. Only its SHA-256 hash is
// ever stored or compared (mirroring the password-reset token handling in
// passwordReset.js); the raw code exists in memory only, and only long enough
// to be emailed and compared. It is never returned in an API response, never
// written to localStorage/sessionStorage and never logged.

const OTP_LENGTH = 6;
// crypto.randomInt(OTP_MIN, OTP_MAX) yields 100000..999999 inclusive: exactly
// six digits with no leading-zero caveat and no timestamp/counter predictability.
const OTP_MIN = 100000;
const OTP_MAX = 1000000; // exclusive upper bound
const OTP_TTL_SECONDS = 5 * 60; // approved expiry: 5 minutes
const OTP_TTL_MS = OTP_TTL_SECONDS * 1000;
const OTP_MAX_ATTEMPTS = 5; // approved attempt cap
const RESEND_COOLDOWN_SECONDS = 60; // approved resend cooldown
const RESEND_COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1000;
const OTP_MAX_RESENDS = 5; // approved maximum resends per challenge

const OTP_PATTERN = /^\d{6}$/;
// challengeId is crypto.randomBytes(24) hex = 48 hex chars.
const CHALLENGE_ID_PATTERN = /^[a-f0-9]{48}$/;

const generateOtp = () => String(crypto.randomInt(OTP_MIN, OTP_MAX));

const generateChallengeId = () => crypto.randomBytes(24).toString('hex');

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

// Constant-time comparison of the SHA-256 digests. Both digests are fixed 64
// hex chars, so buffer lengths always agree before timingSafeEqual runs; the
// length guard is kept anyway so a malformed stored hash can never reach it.
const otpHashesMatch = (candidateOtp, storedHash) => {
  if (typeof candidateOtp !== 'string' || !OTP_PATTERN.test(candidateOtp)) return false;
  if (typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashOtp(candidateOtp), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Email masking for the UX: first character + *** + domain (s***@gmail.com).
const maskEmail = (email) => {
  if (typeof email !== 'string' || !email.includes('@')) return 's***@';
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.charAt(0) || 's'}***${domain}`;
};

module.exports = {
  OTP_LENGTH,
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
};