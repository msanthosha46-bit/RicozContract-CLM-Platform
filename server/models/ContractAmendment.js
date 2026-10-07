const mongoose = require('mongoose');

// A request to change a locked field (amount, currency, startDate, endDate,
// assignedUser) after submission. It exists because PUT /contracts/:id now
// refuses those changes with 409, and a refusal with no forward path would leave
// no way to correct a genuine commercial change after a contract is signed.
//
// One request carries the full set of proposed changes rather than one row per
// field: a price and a term are usually amended together, and they are approved
// together or not at all.
//
// The proposed values are stored as Mixed. Each locked field has a different
// shape (a number, a string, a Date, an ObjectId), so a per-field schema would
// need a discriminated union; Mixed plus a validator that checks the keys
// against LOCKED_FIELDS and the payload against the field's own rules keeps the
// integrity guarantee in one place.
const contractAmendmentSchema = new mongoose.Schema({
  contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', required: true },
  // Who asked for the change.
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // { amount: 130000, endDate: Date, assignedUser: ObjectId|null, currency: 'USD' }
  proposed: { type: mongoose.Schema.Types.Mixed, required: true },
  // A free-text business justification. Required, because an unapproved change to
  // a signed contract must always be explainable.
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Withdrawn'],
    default: 'Pending'
  },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decisionComments: { type: String, trim: true, maxlength: 1000, default: null },
  decidedAt: { type: Date, default: null },
  // The values in force when the request was made, so the history is readable
  // without reconstructing it from the current contract.
  before: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });

// Only keys from the locked set may appear in `proposed`, and a Pending request
// carries no decision fields. Enforced here rather than only in the route so the
// invariant also holds for anything written outside the HTTP layer.
contractAmendmentSchema.pre('validate', function enforceShape(next) {
  const { LOCKED_FIELDS } = require('../utils/contractEditLock');
  const proposed = this.proposed || {};
  const unknown = Object.keys(proposed).filter((field) => !LOCKED_FIELDS.includes(field));
  if (unknown.length) {
    return next(new Error(`Only ${LOCKED_FIELDS.join(', ')} may be amended (got: ${unknown.join(', ')})`));
  }
  if (Object.keys(proposed).length === 0) {
    return next(new Error('An amendment must propose at least one change'));
  }
  if (this.isNew && (this.decidedBy || this.decidedAt)) {
    return next(new Error('A new amendment cannot carry a decision'));
  }
  if (!this.isNew && this.status !== 'Pending' && !this.decidedBy) {
    return next(new Error(`A '${this.status}' amendment must record who decided it`));
  }
  return next();
});

// The queue is "my pending requests" and "pending requests to decide".
contractAmendmentSchema.index({ status: 1, createdAt: -1 });
contractAmendmentSchema.index({ contract: 1, createdAt: -1 });
// One open request per contract at a time. Without this two managers can open
// competing amendments for the same contract and the first approval silently
// decides the value the second one was written against.
contractAmendmentSchema.index(
  { contract: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' }, name: 'one_pending_amendment_per_contract' }
);

module.exports = mongoose.model('ContractAmendment', contractAmendmentSchema);
