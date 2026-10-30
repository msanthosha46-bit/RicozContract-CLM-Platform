const Contract = require('../models/Contract');
const logActivity = require('./activityLogger');
const { compareAndSetContract } = require('./contractRevision');

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const runExpiryPass = async () => {
  // Contract end dates are calendar dates (UTC midnight when set from a date
  // picker), so a contract expires only once its entire final UTC day has
  // passed. `$lt` against today's UTC midnight means a contract ending today is
  // still Active, and it is picked up on the next run - not before, not twice.
  const cutoff = new Date(startOfUtcDay(new Date()));
  const eligible = await Contract.find({
    status: 'Active',
    isArchived: false,
    endDate: { $lt: cutoff }
  }).select('_id contractNumber createdBy assignedUser revision');

  let expired = 0;
  for (const contract of eligible) {
    // The status, archive and revision guards make this a compare-and-set: a
    // contract renewed, edited, closed, or archived since the scan is left
    // alone. A later expiry pass can retry if it remains eligible.
    const flipped = await compareAndSetContract({
      contractId: contract._id,
      expectedRevision: contract.revision === undefined ? 0 : contract.revision,
      expectedStatus: 'Active',
      requireUnarchived: true,
      set: { status: 'Expired' }
    });
    if (flipped) {
      expired += 1;
      // Only a successful compare-and-set writes an audit entry, so repeated
      // runs cannot produce duplicate "Contract Expired" activity.
      const actor = contract.assignedUser || contract.createdBy;
      await logActivity(actor, 'Contract Expired', contract._id, `Contract ${contract.contractNumber} automatically expired after its end date`);
    }
  }

  return { expired };
};

// In-flight guard. server.js runs this on a timer and again on every boot, so a
// slow pass (a large backlog is one find + N compare-and-set round trips) can
// still be running when the next trigger fires. Both triggers share the same
// promise instead of starting a second overlapping scan, which is what keeps a
// long-running pass from being executed twice concurrently.
let inFlight = null;

const expireEligibleContracts = () => {
  if (!inFlight) {
    inFlight = runExpiryPass().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

expireEligibleContracts.isRunning = () => inFlight !== null;

module.exports = expireEligibleContracts;
