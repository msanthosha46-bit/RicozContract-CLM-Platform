const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

const markOverdueItems = async () => {
  const cutoff = new Date(startOfUtcDay(new Date()));
  const filter = {
    dueDate: { $lt: cutoff },
    status: { $in: ['Pending', 'In Progress'] }
  };

  const [obligations, milestones] = await Promise.all([
    Obligation.updateMany(filter, { $set: { status: 'Overdue' } }),
    Milestone.updateMany(filter, { $set: { status: 'Overdue' } })
  ]);

  return {
    obligations: obligations.modifiedCount || 0,
    milestones: milestones.modifiedCount || 0
  };
};

module.exports = markOverdueItems;

