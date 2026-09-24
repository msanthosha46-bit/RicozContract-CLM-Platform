// Shared PUT logic for obligations and milestones (the same work-item shape):
// RBAC rules for who may edit what, contract immutability, detail validation,
// reassignment, archived-contract freeze, and status transition enforcement.
const User = require('../models/User');
const { idOf } = require('./access');
const { canTransitionItem, isValidItemStatus } = require('./itemTransitions');

const DETAIL_FIELDS = ['title', 'description', 'dueDate', 'assignedTo', 'contract'];

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

  if (req.user.role === 'Employee') {
    if (idOf(item.assignedTo) !== idOf(req.user._id)) {
      return {
        error: { status: 403, message: `You can only update ${label}s assigned to you` }
      };
    }
    const detailRequested = DETAIL_FIELDS.some((field) => body[field] !== undefined);
    if (detailRequested) {
      return { error: { status: 403, message: 'Only Admin and Manager can edit item details' } };
    }
  } else {
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
      const parsed = new Date(body.dueDate);
      if (Number.isNaN(parsed.getTime())) {
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

module.exports = { applyItemUpdate };

