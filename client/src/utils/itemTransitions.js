// Client-side mirror of the shared obligation/milestone lifecycle rules
// (server/utils/itemTransitions.js is the source of truth; this only gates
// which buttons/options the UI offers before the server validates).
export const ITEM_STATUSES = ['Pending', 'In Progress', 'Completed', 'Overdue'];

export const ITEM_TRANSITIONS = {
  Pending: ['In Progress', 'Completed', 'Overdue'],
  'In Progress': ['Pending', 'Completed', 'Overdue'],
  Overdue: ['Pending', 'In Progress', 'Completed'],
  Completed: ['Pending', 'In Progress']
};

export const canTransitionItem = (from, to) => {
  if (!to) return true;
  if (from === to) return true;
  return Boolean(ITEM_TRANSITIONS[from]?.includes(to));
};

export const statusOptionsFor = (current) => {
  const candidates = new Set([current, ...(ITEM_TRANSITIONS[current] || [])]);
  return ITEM_STATUSES.filter((status) => candidates.has(status));
};

