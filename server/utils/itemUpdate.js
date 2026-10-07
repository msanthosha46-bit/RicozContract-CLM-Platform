// Shared logic for obligations and milestones (the same work-item shape): the
// PUT RBAC rules for who may edit what, contract immutability, detail validation,
// reassignment, the archived-contract freeze, status transition enforcement, and
// the due-date input parsing shared by PUT and by each create route.
const User = require('../models/User');
const { idOf, isPrivileged } = require('./access');
const { canTransitionItem, isValidItemStatus } = require('./itemTransitions');

const DETAIL_FIELDS = ['title', 'description', 'dueDate', 'assignedTo', 'contract'];

// A due date is a calendar date, but `new Date(x)` is far more permissive than
// that: it accepts a boolean (`new Date(true)` is 1970-01-01T00:00:00.001Z) and
// an array (`new Date([2026, 10, 30])` is *local* midnight, not UTC midnight).
// Both previously passed validation, so a caller that sent the wrong JSON type
// got a 200/201 and an item that was nonsense on arrival - the 1970 one is
// instantly Overdue, and the array one sits at the wrong UTC calendar day and
// therefore flips overdue a day early. Restricting the input to the three types
// a date picker, an ISO string or an epoch number actually produce closes that
// without rejecting anything legitimate. Returns null when unusable.
const parseDueDate = (value) => {
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// Applies the request body to `item` in memory (no database write here).
// Returns { error: { status, message } } to short-circuit, or { changes: [...] }
// describing what was updated so the caller can log an accurate activity entry.
const applyItemUpdate = async ({ req, item, contract, label }) => {
  const body = req.body || {};
  const changes = [];

  if (contract && contract.isArchived) {
    const detailRequested = DETAIL_FIELDS.some((field) => body[field] !== undefined);
    if (detailRequested) {
      return {
        error: {
          status: 400,
          message: `Details of ${label}s on an archived contract cannot be edited`
        }
      };
    }
  }

  if (body.contract !== undefined && idOf(body.contract) !== idOf(item.contract)) {
    return { error: { status: 400, message: 'An item cannot be moved to a different contract' } };
  }

  // Detail editing is a privileged capability, so it is gated on the same
  // allow-list the route guards and `canAccessContract` use. The branch used to
  // be `if (role === 'Employee') { restricted } else { privileged }`, which
  // granted the privileged branch to every role that was not literally
  // 'Employee': an account whose stored role was null, renamed or from a future
  // role could retitle, reschedule and reassign every obligation and milestone
  // in the system. Failing closed keeps the two rules in step.
  if (isPrivileged(req.user)) {
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) return { error: { status: 400, message: 'Title cannot be empty' } };
      item.title = title;
      changes.push('title');
    }
    if (body.description !== undefined) {
      item.description = body.description ? String(body.description).trim() : '';
      changes.push('description');
    }
    if (body.dueDate !== undefined) {
      const parsed = parseDueDate(body.dueDate);
      if (!parsed) {
        return { error: { status: 400, message: 'A valid due date is required' } };
      }
      item.dueDate = parsed;
      changes.push('dueDate');
    }
    if (body.assignedTo !== undefined) {
      if (!body.assignedTo) {
        return { error: { status: 400, message: 'An assignee is required' } };
      }
      const assignee = await User.findById(body.assignedTo);
      if (!assignee) return { error: { status: 404, message: 'Assigned user not found' } };
      item.assignedTo = assignee._id;
      changes.push('assignedTo');
    }
  } else {
    if (idOf(item.assignedTo) !== idOf(req.user._id)) {
      return {
        error: { status: 403, message: `You can only update ${label}s assigned to you` }
      };
    }
    const detailRequested = DETAIL_FIELDS.some((field) => body[field] !== undefined);
    if (detailRequested) {
      return { error: { status: 403, message: 'Only Admin and Manager can edit item details' } };
    }
  }

  if (body.status !== undefined) {
    if (!isValidItemStatus(body.status)) {
      return { error: { status: 400, message: `Invalid ${label} status` } };
    }
    if (!canTransitionItem(item.status, body.status)) {
      return {
        error: {
          status: 400,
          message: `Cannot change status from '${item.status}' to '${body.status}'`
        }
      };
    }
    item.status = body.status;
    changes.push('status');
  }

  if (changes.length === 0) {
    return { error: { status: 400, message: 'No updatable fields were provided' } };
  }

  return { changes };
};

module.exports = { applyItemUpdate, parseDueDate };

