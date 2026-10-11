const jwt = require('jsonwebtoken');

// tokenVersion travels inside the JWT so sessions issued before a password
// change or reset can be revoked by the auth middleware. Single source of the
// session-token contract for every login path (register, email login, Google
// OTP) and for the profile route that rotates a user's session.
const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

module.exports = { generateToken };