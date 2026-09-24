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

// Indexes justified by the queries actually executed: status-scoped listing and
// metric counts, expiring-soon windows, employee-scoped access (createdBy /
// assignedUser), and newest-first repository ordering.
contractSchema.index({ status: 1, isArchived: 1 });
contractSchema.index({ isArchived: 1, status: 1, endDate: 1 });
contractSchema.index({ createdBy: 1, isArchived: 1 });
contractSchema.index({ assignedUser: 1, isArchived: 1 });
contractSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Contract', contractSchema);