const mongoose = require('mongoose');

const approvalSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  comments: { type: String },
  decisionDate: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Approval', approvalSchema);