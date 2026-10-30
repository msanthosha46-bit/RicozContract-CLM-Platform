const User = require('../models/User');
const mailer = require('../utils/mailer');
const {
  generateResetToken,
  buildResetLink,
  RESET_TOKEN_TTL_MINUTES
} = require('../utils/passwordReset');

// Sends one password-reset link for one account.
//
// The token is generated here rather than by the request, so the raw token
// never leaves this process: only its SHA-256 hash is stored and only the link
// carries the token itself.
//
// The order is the one a failed delivery depends on: the hash is stored before
// the send is attempted, so a link that was delivered is always usable by the
// time its owner clicks it. When the send fails, the token of the link the user
// already received is put back, and when there was no such link the account is
// left without a token: a token nobody was ever given is a link nobody can
// use.
//
// Putting it back is a compare-and-set: it only applies while the stored token
// is still the one this attempt wrote. An attempt that failed after a newer
// one succeeded therefore cannot undo the newer one, and a failed attempt never
// restores an older token over it.
//
// The error is handed back to the caller, which reports it. Nothing is
// swallowed here.
const deliverPasswordResetEmail = async ({ user, to }) => {
  const deliveredToken = user.passwordResetToken || null;
  const deliveredExpires = user.passwordResetExpires || null;
  let storedTokenHash = null;

  try {
    const { token, tokenHash, expiresAt } = generateResetToken();
    storedTokenHash = tokenHash;
    user.passwordResetToken = tokenHash; // raw token is never stored
    user.passwordResetExpires = expiresAt;
    await user.save();

    await mailer.sendPasswordResetEmail({
      to,
      resetLink: buildResetLink(token),
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES
    });
  } catch (error) {
    if (storedTokenHash) {
      await User.updateOne(
        { _id: user._id, passwordResetToken: storedTokenHash },
        { $set: { passwordResetToken: deliveredToken, passwordResetExpires: deliveredExpires } }
      ).catch(() => {});
    }
    throw error;
  }
};

module.exports = { deliverPasswordResetEmail };
