const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract' },
  action: { type: String, required: true },
  details: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);