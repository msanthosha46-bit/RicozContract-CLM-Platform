const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  action: { type: String, required: true },
  details: { type: String }
}, { timestamps: true });

// GET /api/activities is the only query on this collection: newest 50 rows,
// newest first. Without this index the explain plan is a COLLSCAN feeding a
// blocking SORT of the whole collection, so the cost of the activity page grows
// with the lifetime of the install rather than with the 50 rows it returns.
activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
