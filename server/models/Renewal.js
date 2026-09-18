const mongoose = require('mongoose');

const renewalSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  oldEndDate: { type: Date, required: true },
  newEndDate: { type: Date, required: true },
  renewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Renewal', renewalSchema);