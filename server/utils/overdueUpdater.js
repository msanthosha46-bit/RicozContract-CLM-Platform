const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

const markOverdueItems = async () => {
  const now = new Date();
  const filter = {
    dueDate: { $lt: now },
    status: { $in: ['Pending', 'In Progress'] }
  };

  await Promise.all([
    Obligation.updateMany(filter, { $set: { status: 'Overdue' } }),
    Milestone.updateMany(filter, { $set: { status: 'Overdue' } })
  ]);
};

module.exports = markOverdueItems;
