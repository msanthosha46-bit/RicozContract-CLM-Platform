// Frontend mirror of the contract lifecycle state machine.
// The backend (server/utils/contractTransitions.js) is the final authority;
// this must stay synchronised with it so the UI never offers a transition the
// API will reject. See that file for the transition rules.
//
// Manual status edits (PUT /contracts/:id) may only move along the allowed
// transitions below; approval decisions and renewal/expiry run through their
// own routes and are not offered as manual-edits here.

export const VALID_STATUSES = [
  'Draft',
  'Pending Review',
  'Pending Approval',
  'Approved',
  'Rejected',
  'Active',
  'Expired',
  'Renewed',
  'Closed'
];

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

export const canTransition = (from, to) => {
  if (!VALID_STATUSES.includes(from) || !VALID_STATUSES.includes(to)) return false;
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
};

export const isTerminalState = (status) => status === 'Closed';

// Statuses that may (re)submit for approval. Active/Closed and anything
// already pending are excluded.
const SUBMITTABLE_FROM = new Set(['Draft', 'Pending Review', 'Approved', 'Rejected']);
export const canSubmitForApproval = (status) => SUBMITTABLE_FROM.has(status);

// Statuses from which renewal is allowed.
const RENEWABLE_FROM = new Set(['Active', 'Approved', 'Expired', 'Renewed']);
export const canRenewContract = (status) => RENEWABLE_FROM.has(status);

// Valid manual-edit target statuses for a contract in `status`, ordered so the
// current status appears first (a no-op save) followed by the allowed moves.
export const getManualEditTargets = (status) => {
  const targets = VALID_STATUSES.filter((candidate) =>
    candidate === status || canTransition(status, candidate)
  );
  return targets.sort((a, b) => {
    if (a === status) return -1;
    if (b === status) return 1;
    return VALID_STATUSES.indexOf(a) - VALID_STATUSES.indexOf(b);
  });
};