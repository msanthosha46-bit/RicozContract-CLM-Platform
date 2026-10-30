const mongoose = require('mongoose');

const renewalSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  oldEndDate: { type: Date, required: true },
  newEndDate: { type: Date, required: true },
  renewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String },
  // Absent on legacy history rows; present on operations created by the
  // idempotent renewal workflow.
  operationId: { type: String, trim: true, minlength: 1, maxlength: 128, match: /^[A-Za-z0-9:_-]+$/ }
}, { timestamps: true });

renewalSchema.index({ contract: 1, createdAt: -1 });
renewalSchema.index(
  { operationId: 1 },
  { unique: true, partialFilterExpression: { operationId: { $type: 'string' } }, name: 'operationId_1' }
);

module.exports = mongoose.model('Renewal', renewalSchema);
