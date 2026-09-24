// Central contract lifecycle rules. Manual status edits (PUT /contracts/:id)
// may only move along the allowed transitions below; approval decisions and
// renewal/expiry are performed by their own routes so they cannot run through
// the manual-edit map (and therefore cannot be bypassed into "Active").

const VALID_STATUSES = new Set([
  'Draft',
  'Pending Review',
  'Pending Approval',
  'Approved',
  'Rejected',
  'Active',
  'Expired',
  'Renewed',
  'Closed'
]);

// Allowed manual status transitions (Admin/Manager edit).
// - Assembly of an approval can be started manually (Draft/Rejected ->
//   Pending Approval), but reaching Active/Rejected requires the approval
//   decision route, which is guarded separately (no self-approval).
// - Closed is terminal: nothing may leave it (also applies to submit/renewal,
//   which check isTerminalState/isArchived themselves).
// - Expired only leaves via renewal (which revives to Active) or Close.
const TRANSITIONS = {
  'Draft': ['Pending Review', 'Pending Approval', 'Closed'],
  'Pending Review': ['Draft', 'Pending Approval', 'Closed'],
  'Pending Approval': ['Draft', 'Closed'],
  'Approved': ['Closed'],
  'Rejected': ['Draft', 'Pending Approval', 'Closed'],
  'Active': ['Expired', 'Closed'],
  'Expired': ['Closed'],
  'Renewed': ['Closed'],
  'Closed': []
};

const canTransition = (from, to) => {
  if (!VALID_STATUSES.has(from) || !VALID_STATUSES.has(to)) return false;
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
};

const isTerminalState = (status) => status === 'Closed';

// States from which a contract may be (re)submitted for approval. Active and
// Closed contracts, and contracts already pending, are excluded.
const SUBMITTABLE_FROM = new Set(['Draft', 'Pending Review', 'Approved', 'Rejected']);
const canSubmitForApproval = (status) => SUBMITTABLE_FROM.has(status);

// States from which a contract may be renewed. Excluded: Draft/Rejected (must
// go through approval), Pending/Pending Review/Pending Approval (in flight).
const RENEWABLE_FROM = new Set(['Active', 'Approved', 'Expired', 'Renewed']);
const canRenewContract = (status) => RENEWABLE_FROM.has(status);

module.exports = {
  VALID_STATUSES,
  TRANSITIONS,
  canTransition,
  isTerminalState,
  SUBMITTABLE_FROM,
  canSubmitForApproval,
  RENEWABLE_FROM,
  canRenewContract
};