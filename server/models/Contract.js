const mongoose = require('mongoose');

// The currencies the create and edit forms offer, and the only ones the
// dashboard's `Intl.NumberFormat` call and the report grouping handle. Shared
// with utils/contractValidation.js, which validates the value on the way in so
// a refusal is a 400 with a readable message; the enum here is the backstop that
// holds on a direct model write.
const CURRENCIES = require('../utils/contractValidation').CONTRACT_CURRENCIES;

const CONTRACT_OPERATION_TYPES = ['ApprovalSubmission', 'ApprovalDecision', 'AmendmentDecision', 'Renewal'];

const renewalOperationPayloadSchema = new mongoose.Schema({
  oldEndDate: { type: Date, required: true },
  newEndDate: { type: Date, required: true },
  renewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String, default: null },
  committedRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger }
}, { _id: false, strict: 'throw' });

const contractOperationMarkerSchema = new mongoose.Schema({
  operationId: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 128,
    match: /^[A-Za-z0-9:_-]+$/
  },
  operationType: { type: String, required: true, enum: CONTRACT_OPERATION_TYPES },
  renewal: { type: renewalOperationPayloadSchema, default: undefined }
}, { _id: false, strict: 'throw' });

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
  isArchived: { type: Boolean, default: false },
  // Explicit application-level concurrency token. The default initializes new
  // contracts; the CAS helper separately handles legacy documents where this
  // field has not yet been persisted.
  revision: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: {
      validator: Number.isSafeInteger,
      message: 'Contract revision must be a non-negative integer'
    }
  },
  // A renewal carries its immutable recovery payload here so it is committed
  // atomically with the contract change. Other operation types keep only ID/kind.
  operationMarker: { type: contractOperationMarkerSchema, default: undefined }
}, {
  timestamps: true,
  // The operation marker is internal coordination state and its renewal
  // payload can contain business notes. Never include it in API serialization.
  toJSON: { transform: (_document, ret) => { delete ret.operationMarker; return ret; } },
  toObject: { transform: (_document, ret) => { delete ret.operationMarker; return ret; } }
});

// Indexes justified by the queries actually executed: status-scoped listing and
// metric counts, expiring-soon windows, employee-scoped access (createdBy /
// assignedUser), and newest-first repository ordering.
contractSchema.index({ status: 1, isArchived: 1 });
contractSchema.index({ isArchived: 1, status: 1, endDate: 1 });
contractSchema.index({ createdBy: 1, isArchived: 1 });
contractSchema.index({ assignedUser: 1, isArchived: 1 });
contractSchema.index({ createdAt: -1 });
contractSchema.index(
  { 'operationMarker.operationId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'operationMarker.operationId': { $type: 'string' } },
    name: 'operationMarker.operationId_1'
  }
);

module.exports = mongoose.model('Contract', contractSchema);
