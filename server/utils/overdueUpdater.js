const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

// Obligation/milestone due dates are calendar dates stored as UTC midnight
// (that is what clients `type="date"` inputs produce). An item is only
// overdue once its entire due day has passed in UTC, so an item due *today*
// must not be flipped to Overdue at 00:00:01 UTC of that same day. Completed
// items are intentionally excluded: work that has been finished is never
// marked overdue again, even if its due date has passed.
const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const runOverduePass = async () => {
  const cutoff = new Date(startOfUtcDay(new Date()));
  const filter = {
    dueDate: { $lt: cutoff },
    status: { $in: ['Pending', 'In Progress'] }
  };

  // `updateMany` is a single atomic multi-document write, and the status guard
  // lives in the filter, so an item already marked Overdue is not matched again.
  // `modifiedCount` is therefore 0 on every execution after the first, which is
  // what makes the job idempotent and what the log line reports.
  const [obligations, milestones] = await Promise.all([
    Obligation.updateMany(filter, { $set: { status: 'Overdue' } }),
    Milestone.updateMany(filter, { $set: { status: 'Overdue' } })
  ]);

  return {
    obligations: obligations.modifiedCount || 0,
    milestones: milestones.modifiedCount || 0
  };
};

// In-flight guard, as in utils/expiryUpdater.js: server.js triggers this on a
// timer and on every boot, and a slow pass must not be able to overlap with the
// next trigger.
let inFlight = null;

const markOverdueItems = () => {
  if (!inFlight) {
    inFlight = runOverduePass().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

markOverdueItems.isRunning = () => inFlight !== null;

module.exports = markOverdueItems;
module.exports.startOfUtcDay = startOfUtcDay;
