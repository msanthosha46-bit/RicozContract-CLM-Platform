const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  action: { type: String, required: true },
  details: { type: String },
  // The assignee a reassignment handed the contract to. It is the recipient
  // the notification feed reads to tell the new assignee, so it is set only on
  // a `Contract Reassigned` entry and only when somebody was actually
  // assigned: a cleared assignment notifies nobody.
  targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // The assignee the contract was taken from, for the same reason: the
  // before-side of the change, kept next to the after-side so the entry can
  // be read without the contract it refers to.
  previousUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Used only by idempotent lifecycle activity records; absent on legacy rows.
  operationId: { type: String, trim: true, minlength: 1, maxlength: 128, match: /^[A-Za-z0-9:_-]+$/ }
}, { timestamps: true });

// GET /api/activities is the only query on this collection: newest 50 rows,
// newest first. Without this index the explain plan is a COLLSCAN feeding a
// blocking SORT of the whole collection, so the cost of the activity page grows
// with the lifetime of the install rather than with the 50 rows it returns.
activityLogSchema.index({ createdAt: -1 });

// The notification feed asks for the reassignments addressed to ONE user,
// newest first. Without this index the same COLLSCAN would run for every
// reader of the feed, on every request.
activityLogSchema.index({ targetUser: 1, createdAt: -1 });
activityLogSchema.index(
  { operationId: 1 },
  { unique: true, partialFilterExpression: { operationId: { $type: 'string' } }, name: 'operationId_1' }
);

module.exports = mongoose.model('ActivityLog', activityLogSchema);
