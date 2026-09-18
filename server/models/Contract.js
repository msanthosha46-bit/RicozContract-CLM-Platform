const mongoose = require('mongoose');

const contractSchema = new mongoose.Schema({
  contractNumber: { type: String, required: true, unique: true },
  title: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['Vendor', 'Client', 'NDA', 'SLA', 'Employment', 'Partnership', 'Other'] },
  partyName: { type: String, required: true },
  description: { type: String },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { 
    type: String, 
    enum: ['Draft', 'Pending Review', 'Pending Approval', 'Approved', 'Rejected', 'Active', 'Expired', 'Renewed', 'Closed'], 
    default: 'Draft' 
  },
  isArchived: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Contract', contractSchema);