const mongoose = require('mongoose');
const { OTP_MAX_ATTEMPTS, OTP_MAX_RESENDS } = require('../utils/googleOtp');

// A temporary challenge created when a user begins Google sign-in. It binds the
// server-verified Google identity (googleSub + email) to an emailed one-time
// code, whose SHA-256 hash is stored instead of the code itself.
//
// The challenge deliberately holds no reference to a Mongo user: the account
// may not exist yet and must never be created before the OTP is verified (a
// "user" guessed from an unverified browser value). Only the OTP verify
// endpoint resolves the identity into an account and issues a JWT.
//
// A TTL index removes the document when expiresAt passes, so stale challenges
// cannot pile up.

const googleOtpChallengeSchema = new mongoose.Schema(
  {
    challengeId: { type: String, required: true, unique: true },
    googleSub: { type: String, required: true },
    // The verified Google payload email, lower-cased. Never a client value.
    email: { type: String, required: true, lowercase: true, trim: true },
    // Display name from the verified Google payload, used only when the
    // account is created after successful verification.
    name: { type: String, trim: true, default: '' },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: OTP_MAX_ATTEMPTS },
    usedAt: { type: Date, default: null },
    resendAvailableAt: { type: Date, default: () => new Date() },
    resendCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Auto-cleanup: a challenge is only meant to live a few minutes.
googleOtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
googleOtpChallengeSchema.index({ email: 1 });

module.exports = mongoose.model('GoogleOtpChallenge', googleOtpChallengeSchema);
module.exports.OTP_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;
module.exports.OTP_MAX_RESENDS = OTP_MAX_RESENDS;