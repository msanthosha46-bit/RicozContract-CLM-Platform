const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// The one definition of the two closed value sets, exported so the routes that
// accept them validate against the same list the schema enforces. Keeping a
// second copy in a route is how the two drift apart.
const USER_ROLES = ['Admin', 'Manager', 'Employee'];
const USER_STATUSES = ['Active', 'Inactive'];

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: function () { return !this.googleId; } },
  googleId: { type: String, unique: true, sparse: true },
  role: { type: String, enum: USER_ROLES, default: 'Employee' },
  department: { type: String, default: 'General' },
  status: { type: String, enum: USER_STATUSES, default: 'Active' },
  preferences: {
    emailNotifications: { type: Boolean, default: true },
    approvalReminders: { type: Boolean, default: true },
    expiryAlerts: { type: Boolean, default: true }
  },
  // Password-reset fields: only the SHA-256 hash of the reset token is stored,
  // never the raw token. Hidden from queries by default (select: false).
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  // Included in JWTs so sessions issued before a password reset can be revoked.
  tokenVersion: { type: Number, default: 0 }
}, { timestamps: true });

// Speeds up reset-token lookups; sparse so only users with a pending reset
// (and non-cleared nulls) are indexed. Expiry is enforced in the query itself.
userSchema.index({ passwordResetToken: 1 }, { sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.password || !this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
module.exports.USER_ROLES = USER_ROLES;
module.exports.USER_STATUSES = USER_STATUSES;
