// Single lifecycle rule set for both obligations and milestones. They are the
// same kind of work item (assignedTo + dueDate + status) and must not drift
// into two separate subsystems with different semantics.

const ITEM_STATUSES = ['Pending', 'In Progress', 'Completed', 'Overdue'];

// Allowed status transitions. Overdue is reached automatically by the hourly
// job (or manually); Completed is only reopenable and can never be flipped to
// Overdue - the hourly job also skips Completed for the same reason.
const ITEM_TRANSITIONS = {
  Pending: ['In Progress', 'Completed', 'Overdue'],
  'In Progress': ['Pending', 'Completed', 'Overdue'],
  Overdue: ['Pending', 'In Progress', 'Completed'],
  Completed: ['Pending', 'In Progress']
};

const isValidItemStatus = (status) => ITEM_STATUSES.includes(status);

// Treating a self-transition as a no-op makes idempotent PUTs safe.
const canTransitionItem = (from, to) => {
  if (!isValidItemStatus(to)) return false;
  if (from === to) return true;
  const allowed = ITEM_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
};

module.exports = {
  ITEM_STATUSES,
  ITEM_TRANSITIONS,
  isValidItemStatus,
  canTransitionItem
};

