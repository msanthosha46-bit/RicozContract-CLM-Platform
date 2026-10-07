// Contract edit-lock policy.
//
// WHY THIS EXISTS
// ---------------
// `PUT /contracts/:id` used to apply exactly one authorization rule -
// canAccessContract - and no status-based rule at all. `status` alone was
// role-gated, so any user with access to a contract (including an assigned
// Employee) could change `amount`, `startDate`, `endDate` and `assignedUser`
// on a contract that had already been submitted, approved and activated.
// Reproduced through the real workflow in Phase 12:
//
//   admin created -> submitted -> a different Manager approved (status Active)
//   Employee PUT amount=999999 endDate=2030-12-31  ->  HTTP 200, both applied
//   Employee PUT assignedUser=<admin>              ->  HTTP 200, reassigned
//
// The approval that authorised the terms was therefore not binding: the terms
// could be rewritten afterwards without any approval, and without a trace in
// the approval history.
//
// THE RULE
// --------
//  * Draft and Rejected stay editable, at the role permissions that already
//    exist (unchanged).
//  * From submission onwards, the financial terms, the contract dates and the
//    assignee are locked FOR EVERY ROLE, including Admin and Manager. An
//    approval must bind the terms it approved.
//  * Post-approval changes go through an amendment request instead, which is a
//    separate approval workflow (see server/models/ContractAmendment.js).
//
// WHAT IS AND IS NOT LOCKED
// -------------------------
// Locked:   amount, currency, startDate, endDate, assignedUser
// Open:     title, type, partyName, description, status
//
// Descriptive fields stay editable on purpose - renaming a counterparty or
// correcting a typo must not require a re-approval, and locking them would make
// the contract record stale rather than safer. `status` keeps its existing
// role check and its existing transition table; this policy does not change it.
//
// COMPATIBILITY
// -------------
// Every legitimate post-submission change to a locked field already has its own
// authorized route and its own audit record, so none of them are affected:
//   * renewal  - POST /renewals/renew/:id writes endDate and status directly
//                on the model (renewalRoutes.js), never through this route,
//                and records a Renewal with oldEndDate/newEndDate.
//   * expiry   - the expiry job changes status with a conditional updateMany.
//   * approval - the decision route changes status directly on the model.
// A locked field is compared by its EFFECTIVE VALUE, not by its presence, so a
// form that resubmits the unchanged current value is still accepted. That is
// what keeps the existing EditContract screen working: it always posts amount
// and the dates, and most saves are descriptive.

const mongoose = require('mongoose');

// The only states in which a locked field may still be changed directly.
// Matches the rule "Draft and Rejected contracts remain editable".
const UNLOCKED_STATUSES = new Set(['Draft', 'Rejected']);

// The fields the policy locks. 'currency' is grouped with 'amount' because a
// currency change is a financial-term change, not a cosmetic one.
const LOCKED_FIELDS = ['amount', 'currency', 'startDate', 'endDate', 'assignedUser'];

// Descriptive fields, named so the 409 message can tell the user what is still
// allowed rather than leaving them to guess.
const OPEN_FIELDS = ['title', 'type', 'partyName', 'description'];

const isEditableStatus = (status) => UNLOCKED_STATUSES.has(status);

const sameDate = (a, b) => {
  const left = a ? new Date(a).getTime() : null;
  const right = b ? new Date(b).getTime() : null;
  return left === right && (Number.isNaN(left) === Number.isNaN(right));
};

// null and an absent id are the same thing: the contract has no assignee.
// resolveAssignee already normalises null / '' to null, so an unchanged
// assignment compares equal whether the client sent an id, null or ''.
const sameId = (a, b) => {
  const left = a === null || a === undefined || a === '' ? null : String(a);
  const right = b === null || b === undefined || b === '' ? null : String(b);
  return left === right;
};

const sameValue = (field, next, current) => {
  if (field === 'startDate' || field === 'endDate') return sameDate(next, current);
  if (field === 'assignedUser') return sameId(next, current);
  if (field === 'amount') return Number(next) === Number(current);
  if (field === 'currency') return String(next ?? '') === String(current ?? '');
  return String(next ?? '') === String(current ?? '');
};

/**
 * Decide whether a proposed update may be applied.
 *
 * `current` is the persisted contract, `proposed` a map of the values the route
 * has already resolved and validated (so `assignedUser` is already an ObjectId
 * or null, `amount` already a number and the dates already Date objects).
 *
 * Returns null when the update is allowed, or
 * { status: 409, lockedFields, message } when it is not.
 */
const evaluateContractEdit = ({ contract, proposed }) => {
  if (isEditableStatus(contract.status)) return null;

  const lockedFields = LOCKED_FIELDS.filter((field) => (
    proposed[field] !== undefined && !sameValue(field, proposed[field], contract[field])
  ));

  if (lockedFields.length === 0) return null;

  const state = contract.status;
  return {
    status: 409,
    lockedFields,
    message:
      `Cannot change ${lockedFields.join(', ')} on a contract in state '${state}'. ` +
      `Financial terms, dates and the assignee are locked from submission onwards for every role. ` +
      `Submit an amendment request instead (POST /api/contract-amendments with contract, proposed, reason), ` +
      `which is approved separately and recorded in the contract history. ` +
      `You can still edit: ${OPEN_FIELDS.join(', ')}.`
  };
};

module.exports = {
  UNLOCKED_STATUSES,
  LOCKED_FIELDS,
  OPEN_FIELDS,
  isEditableStatus,
  sameValue,
  evaluateContractEdit
};
