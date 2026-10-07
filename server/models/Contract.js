const mongoose = require('mongoose');

// The currencies the create and edit forms offer, and the only ones the
// dashboard's `Intl.NumberFormat` call and the report grouping handle. Shared
// with utils/contractValidation.js, which validates the value on the way in so
// a refusal is a 400 with a readable message; the enum here is the backstop that
// holds on a direct model write.
const CURRENCIES = require('../utils/contractValidation').CONTRACT_CURRENCIES;

const contractSchema = new mongoose.Schema({
  contractNumber: { type: String, required: true, unique: true },
  title: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['Vendor', 'Client', 'NDA', 'SLA', 'Employment', 'Partnership', 'Other'] },
  // `trim` was missing here while `title` above had it, so a required business
  // field accepted "   ": `required` rejects an empty string, but not one that
  // is only whitespace, and the blank counterparty was then stored as sent.
  partyName: { type: String, required: true, trim: true },
  description: { type: String },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: CURRENCIES, default: 'USD' },
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