// Shared presentation and request-shaping rules for the contract amendment
// workflow.
//
// The server (routes/amendmentRoutes.js + utils/contractEditLock.js) is the
// authority for what may be amended, who may decide it and whether the values
// are legal. Nothing here decides any of that. This module exists so the
// request form, the approver queue and the contract history all describe an
// amendment the same way, and so a form can say what is wrong before a round
// trip instead of after it.
//
// The field list is a mirror of the server's LOCKED_FIELDS, for the same reason
// contractEditLock.js mirrors the edit lock: the form has to render a row per
// locked field, and fetching the list would mean a request on every form open.
// client/test/amendments.test.js pins it to the server file so the two cannot
// drift apart unnoticed.

// The server's LOCKED_FIELDS, in the order the request form renders them.
// Imported, not re-declared: `canRequestAmendment` has to agree with the edit
// lock about which states are edited directly, and a second copy of that status
// list is exactly how the two would drift.
//
// The extension is written out because `client/test/amendments.test.js` loads this
// module through `require`, and Node's ESM resolver - unlike webpack's - will not
// guess an extension for a relative specifier.
import { isEditableStatus } from './contractEditLock.js';

export const AMENDABLE_FIELDS = ['amount', 'currency', 'startDate', 'endDate', 'assignedUser'];

// Mirrors the enum in server/models/ContractAmendment.js. 'Withdrawn' is in the
// model but no route can set it, so it is listed for completeness only and
// never produced by this client.
export const AMENDMENT_STATUSES = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

// The four currencies the create and edit forms already offer. The server
// accepts any non-empty string for `currency`, so this list is a UI
// convenience shared by all three forms, not a validation rule. Pinned against
// CreateContract.js and EditContract.js in client/test/amendments.test.js.
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR'];

// The assignee field has to express three states - "not part of this amendment",
// "clear the assignee" and "assign to this person" - and a single <select>
// cannot say "not proposed" as a value without offering it as one. A sentinel
// for "unassigned" leaves the empty option free to mean "leave it alone".
export const UNASSIGNED = '__unassigned__';

export const FIELD_LABELS = {
  amount: 'Amount',
  currency: 'Currency',
  startDate: 'Start date',
  endDate: 'End date',
  assignedUser: 'Assigned user'
};

const idOf = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';

// Same comparison the server's sameValue() makes, for the same reason: a form
// that proposes the value already in force is a no-op the server refuses, and
// telling the user that in the form is better than a 400. Dates compare by
// instant, so the UTC-midnight round trip a date input introduces is not read
// as a change.
export const sameAmendmentValue = (field, next, current) => {
  if (field === 'startDate' || field === 'endDate') {
    const left = next ? new Date(next).getTime() : null;
    const right = current ? new Date(current).getTime() : null;
    return left === right && (Number.isNaN(left) === Number.isNaN(right));
  }
  if (field === 'assignedUser') return idOf(next) === idOf(current);
  if (field === 'amount') return Number(next) === Number(current);
  return String(next ?? '') === String(current ?? '');
};

// Every field starts blank, and blank means "not part of this amendment". The
// current value is shown as the input's placeholder, so the form displays the
// locked value without pre-filling it: a pre-filled value would make it
// impossible to submit an amendment that changes only some of the fields.
export const emptyAmendmentDraft = () => ({
  amount: '',
  currency: '',
  startDate: '',
  endDate: '',
  assignedUser: ''
});

// The payload for POST /contract-amendments. Only the fields the user actually
// filled in are included, coerced to the types the server expects, so the
// request can never carry a locked field the user did not mean to change.
export const buildProposed = (draft) => {
  const proposed = {};
  if (!isBlank(draft.amount)) proposed.amount = Number(draft.amount);
  if (!isBlank(draft.currency)) proposed.currency = String(draft.currency).trim();
  if (!isBlank(draft.startDate)) proposed.startDate = draft.startDate;
  if (!isBlank(draft.endDate)) proposed.endDate = draft.endDate;
  if (draft.assignedUser === UNASSIGNED) proposed.assignedUser = null;
  else if (!isBlank(draft.assignedUser)) proposed.assignedUser = draft.assignedUser;
  return proposed;
};

// The keys the draft proposes, in the render order. Used for the "N fields
// selected" summary and for the no-op check.
export const changedFields = (draft) => AMENDABLE_FIELDS.filter((field) => {
  if (field === 'assignedUser') return !isBlank(draft.assignedUser);
  return !isBlank(draft[field]);
});

/**
 * Client-side mirror of the server's request-time rules, so the form can point
 * at the offending input instead of showing a message about the request.
 *
 * Returns { fieldErrors, formError, reasonError, proposed }.
 */
export const validateAmendmentDraft = (draft, contract, reason = '') => {
  const fieldErrors = {};
  const proposed = buildProposed(draft);
  const changed = changedFields(draft);

  if (isBlank(draft.amount)) {
    delete proposed.amount;
  } else {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      fieldErrors.amount = 'Amount must be a non-negative number';
    }
  }

  if (!isBlank(draft.startDate) && Number.isNaN(new Date(draft.startDate).getTime())) {
    fieldErrors.startDate = 'Enter a valid start date';
  }
  if (!isBlank(draft.endDate) && Number.isNaN(new Date(draft.endDate).getTime())) {
    fieldErrors.endDate = 'Enter a valid end date';
  }

  // The RESULTING range has to be valid, not just the supplied field: moving
  // only the start date past the current end date is accepted by a per-field
  // check and rejected by the server.
  if (!fieldErrors.startDate && !fieldErrors.endDate) {
    const start = proposed.startDate || contract?.startDate;
    const end = proposed.endDate || contract?.endDate;
    if (start && end && new Date(end) < new Date(start)) {
      fieldErrors.endDate = 'The end date must be on or after the start date';
    }
  }

  const reasonError = isBlank(reason)
    ? 'A reason is required for an amendment'
    : reason.trim().length > 1000
      ? 'Keep the reason under 1000 characters'
      : '';

  // The no-op check is the reason this function needs the contract at all: an
  // amendment that proposes what already holds would occupy the single open
  // slot for the contract while changing nothing, and the server refuses it.
  const noop = changed.filter((field) => sameAmendmentValue(field, proposed[field], contract?.[field]));
  const formError = !changed.length
    ? 'Choose at least one locked field to change.'
    : noop.length === changed.length && !Object.keys(fieldErrors).length
      ? `The proposed values already match the contract (${noop.map((f) => FIELD_LABELS[f] || f).join(', ')}). Nothing to amend.`
      : '';

  return {
    fieldErrors,
    formError,
    reasonError,
    proposed,
    changed,
    valid: !formError && !reasonError && !Object.keys(fieldErrors).length
  };
};

// A before/after contract date, rendered in the same UTC calendar-day form as
// the contract overview, so the trail and the overview can never disagree about
// the value of the same field. `toLocaleDateString()` resolves in the device
// timezone, and these dates are stored at UTC midnight, so a user west of UTC
// read a start date one day early (2027-06-30 showed as 29/06).
const displayDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

const displayAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString() : String(value ?? '');
};

// One row of an amendment's before -> after, for the queue and the history.
// The assignee is rendered from the resolved names the route attaches
// (`beforeAssignee` / `proposedAssignee`) rather than from the raw ObjectId the
// Mixed `before`/`proposed` fields carry, because a bare id is not something an
// approver can judge a reassignment by.
export const describeAmendmentChanges = (amendment) => {
  const proposed = amendment?.proposed || {};
  const before = amendment?.before || {};

  return Object.keys(proposed).map((field) => {
    if (field === 'assignedUser') {
      return {
        field,
        label: FIELD_LABELS[field] || field,
        from: amendment.beforeAssignee || 'Unassigned',
        to: amendment.proposedAssignee || 'Unassigned'
      };
    }
    if (field === 'amount') {
      return { field, label: FIELD_LABELS[field] || field, from: displayAmount(before[field]), to: displayAmount(proposed[field]) };
    }
    if (field === 'startDate' || field === 'endDate') {
      return { field, label: FIELD_LABELS[field] || field, from: displayDate(before[field]), to: displayDate(proposed[field]) };
    }
    return { field, label: FIELD_LABELS[field] || field, from: String(before[field] ?? '—'), to: String(proposed[field] ?? '—') };
  });
};

// A short, single-line version of the same, for the notification feed and table
// cells. The values are in the queue and the history; the list only needs to say
// which fields are in play.
export const summariseAmendmentFields = (amendment) =>
  Object.keys(amendment?.proposed || {}).map((field) => FIELD_LABELS[field] || field);

/**
 * Whether the current user may raise an amendment for this contract, and why
 * not if they may not. Reads only what the contract detail page already has.
 *
 * `amendments` is the list already fetched for the history section, so the
 * "one open request per contract" rule is enforced by the same document the
 * history renders rather than by a second request.
 */
export const canRequestAmendment = ({ contract, amendments = [], user }) => {
  if (!contract) return { allowed: false, reason: 'Contract not found' };
  if (contract.isArchived) return { allowed: false, reason: 'Archived contracts cannot be amended' };
  // Draft and Rejected are still edited directly, so an amendment there would
  // bypass the audit trail of a plain edit.
  if (isEditableStatus(contract.status)) {
    return { allowed: false, reason: `A contract in state '${contract.status}' is edited directly, so no amendment is needed.` };
  }
  if (amendments.some((amendment) => amendment?.status === 'Pending')) {
    return { allowed: false, reason: 'An amendment for this contract is already awaiting a decision' };
  }
  // The server allows anyone with contract access to request one; the detail
  // page is only reachable by such a user in the first place. `user` is
  // accepted so the rule has one place to live if that ever tightens.
  if (!user) return { allowed: false, reason: 'Sign in to request an amendment' };
  return { allowed: true, reason: '' };
};

/**
 * Whether the current user may decide this amendment, and why not.
 *
 * The three rules mirror the server exactly - Admin/Manager only, and never
 * your own request - so the queue can hide a control that would be refused
 * rather than offering one and reporting the refusal afterwards.
 */
export const canDecideAmendment = ({ amendment, user }) => {
  if (!amendment || !user) return { allowed: false, reason: 'Sign in to decide an amendment' };
  if (amendment.status !== 'Pending') {
    return { allowed: false, reason: `This amendment has already been ${String(amendment.status).toLowerCase()}` };
  }
  if (!['Admin', 'Manager'].includes(user.role)) {
    return { allowed: false, reason: 'Only administrators and managers can decide an amendment' };
  }
  const requester = idOf(amendment.requestedBy);
  if (requester && requester === idOf(user)) {
    return { allowed: false, reason: 'You cannot approve or reject your own amendment' };
  }
  return { allowed: true, reason: '' };
};
