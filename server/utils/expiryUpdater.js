const Contract = require('../models/Contract');
const logActivity = require('./activityLogger');

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const expireEligibleContracts = async () => {
  const cutoff = new Date(startOfUtcDay(new Date()));
  const eligible = await Contract.find({
    status: 'Active',
    isArchived: false,
    endDate: { $lt: cutoff }
  }).select('_id contractNumber createdBy assignedUser');

  let expired = 0;
  for (const contract of eligible) {
    const flipped = await Contract.findOneAndUpdate(
      { _id: contract._id, status: 'Active', isArchived: false },
      { $set: { status: 'Expired' } },
      { new: false }
    );
    if (flipped) {
      expired += 1;
      const actor = contract.assignedUser || contract.createdBy;
      await logActivity(actor, 'Contract Expired', contract._id, `Contract ${contract.contractNumber} automatically expired after its end date`);
    }
  }

  return { expired };
};

module.exports = expireEligibleContracts;