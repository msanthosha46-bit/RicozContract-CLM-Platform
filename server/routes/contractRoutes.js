const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Contract = require('../models/Contract');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract, employeeContractScope, isPrivileged } = require('../utils/access');
const { canTransition, VALID_STATUSES } = require('../utils/contractTransitions');
const { evaluateContractEdit } = require('../utils/contractEditLock');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every field `PUT /contracts/:id` will write apart from `status`, declared once
// so the archived-contract freeze below and the assignment further down cannot
// drift apart: a field added to one and not the other would be editable on an
// archived contract while reading as frozen. `contractNumber` is absent because
// it is generated, never supplied.
const CONTRACT_EDITABLE_FIELDS = [
  'title',
  'type',
  'partyName',
  'description',
  'currency',
  'startDate',
  'endDate',
  'amount',
  'assignedUser'
];

// `PUT /:id` has always validated the date range and the amount; creation did
// not, so a contract could be born with a negative amount or an end date before
// its start date. Those records are invisible to the editor afterwards (every
// later save is rejected), they skew the dashboard currency totals and they make
// the expiry job and the renewal window misbehave. Creation is validated with
// exactly the same rules so a contract is never persisted in a shape the update
// route would refuse. The shared rationale lives in utils/contractValidation.js.
//
// `parseContractDate` and `validateContractCurrency` are called here as well as
// in the schema because the values have to be checked BEFORE they are coerced.
// `new Date(null)` is 1970-01-01 and `new Date(true)` is 1970-01-01T00:00:01Z,
// so a caller that meant "no date" got a real one, and an unknown currency was
// stored and later threw inside the dashboard's `Intl.NumberFormat`.
const {
  validateContractDates,
  validateContractAmount,
  validateContractCurrency,
  parseContractDate
} = require('../utils/contractValidation');

// Resolves a requested assignee to a real user.
//   { assignee: <ObjectId> }  a user that exists
//   { assignee: null }        clear the assignment (PUT only)
//   { error: { status, message } } rejected
// An assignee that is absent is not an error: `POST` leaves the field unset and
// `PUT` clears it, which is how an unassigned contract is represented.
const resolveAssignee = async (assignedUser) => {
  if (assignedUser === undefined) return { assignee: null };
  if (assignedUser === null || assignedUser === '') return { assignee: null };
  if (!mongoose.isValidObjectId(assignedUser)) {
    return { error: { status: 400, message: 'Assigned user must be a valid identifier' } };
  }
  const assignee = await User.findById(assignedUser).select('_id');
  if (!assignee) {
    return { error: { status: 404, message: 'Assigned user not found' } };
  }
  return { assignee: assignee._id };
};

const nextContractNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `CNT-${year}-`;
  const latest = await Contract.findOne({ contractNumber: new RegExp(`^${prefix}`) })
    .sort({ contractNumber: -1 })
    .select('contractNumber');

  let seq = 1;
  if (latest?.contractNumber) {
    const parsed = Number(latest.contractNumber.slice(prefix.length));
    if (!Number.isNaN(parsed)) seq = parsed + 1;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const contractNumber = `${prefix}${String(seq + attempt).padStart(4, '0')}`;
    const exists = await Contract.exists({ contractNumber });
    if (!exists) return contractNumber;
  }

  return `${prefix}${Date.now().toString().slice(-8)}`;
};

const buildListQuery = (req) => {
  const { search, status, type } = req.query;
  const filters = [{ isArchived: false }];

  // Scoped unless the user is in the privileged allow-list, so this listing can
  // never be broader than `canAccessContract` on GET /:id. Asking "is this an
  // Employee?" instead handed the whole repository to any role that was merely
  // not 'Employee'.
  if (!isPrivileged(req.user)) {
    filters.push(employeeContractScope(req.user._id));
  }

  if (search) {
    const safe = escapeRegExp(String(search).slice(0, 100));
    filters.push({
      $or: [
        { title: { $regex: safe, $options: 'i' } },
        { contractNumber: { $regex: safe, $options: 'i' } },
        { partyName: { $regex: safe, $options: 'i' } }
      ]
    });
  }

  if (status) filters.push({ status });
  if (type) filters.push({ type });

  return filters.length === 1 ? filters[0] : { $and: filters };
};

router.get('/', protect, async (req, res, next) => {
  try {
    if (req.query.status && !VALID_STATUSES.has(req.query.status)) {
      return res.status(400).json({ message: 'Invalid status filter value' });
    }

    const query = buildListQuery(req);
    let contracts = Contract.find(query).populate('createdBy', 'name email').populate('assignedUser', 'name email');
    if (req.query.sort === 'oldest') contracts = contracts.sort({ createdAt: 1 });
    else contracts = contracts.sort({ createdAt: -1 });

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 0;
    if (req.query.page !== undefined && (!Number.isInteger(page) || page < 1)) {
      return res.status(400).json({ message: 'Invalid page value' });
    }
    if (req.query.limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return res.status(400).json({ message: 'Invalid limit value (must be 1-100)' });
    }

    if (req.query.fields) {
      const fields = String(req.query.fields).split(',').map((field) => field.trim()).filter(Boolean);
      if (fields.length) contracts = contracts.select(fields.join(' '));
    }

    if (limit) {
      const total = await Contract.countDocuments(query);
      const result = await contracts.skip((page - 1) * limit).limit(limit);
      res.json({ contracts: result, total, page, totalPages: Math.ceil(total / limit) });
    } else {
      const result = await contracts;
      res.json(result);
    }
  } catch (error) {
    next(error);
  }
});

router.post('/', protect, async (req, res, next) => {
  try {
    // A date and a currency are checked in their raw form first: `new Date(null)`
    // is 1970-01-01 and `new Date(true)` is 1970-01-01T00:00:01Z - real Dates
    // that then pass the range check below, so a caller sending "no date" stored
    // the epoch. An empty string is caught by the same guard, even though
    // `new Date('')` happens to be Invalid Date rather than the epoch.
    const startRaw = parseContractDate(req.body.startDate);
    if (typeof startRaw === 'string') return res.status(400).json({ message: startRaw });
    const endRaw = parseContractDate(req.body.endDate);
    if (typeof endRaw === 'string') return res.status(400).json({ message: endRaw });

    const dateError = validateContractDates(startRaw, endRaw);
    if (dateError) return res.status(400).json({ message: dateError });

    // The four currencies the forms offer. The schema enum alone would refuse
    // the write too, but only as an opaque ValidationError after the record was
    // built, and it would not have stopped a bad value reaching the dashboard
    // totals through any other writer.
    const currencyError = validateContractCurrency(req.body.currency);
    if (currencyError) return res.status(400).json({ message: currencyError });

    // `Number(true)` is 1 and `Number([])` is 0, so a boolean or an array body
    // became a real amount. validateContractAmount now refuses both types; an
    // absent value still has to be named here, because an omitted amount is a
    // required-field error rather than a coercion question.
    if (req.body.amount === undefined) {
      return res.status(400).json({ message: 'Amount must be a non-negative number' });
    }
    const amount = validateContractAmount(req.body.amount);
    if (typeof amount === 'string') return res.status(400).json({ message: amount });

    const assigneeResult = await resolveAssignee(req.body.assignedUser);
    if (assigneeResult.error) {
      return res.status(assigneeResult.error.status).json({ message: assigneeResult.error.message });
    }

    const contractNumber = await nextContractNumber();

    const contract = await Contract.create({
      title: req.body.title,
      type: req.body.type,
      partyName: req.body.partyName,
      description: req.body.description,
      startDate: startRaw,
      endDate: endRaw,
      amount,
      currency: req.body.currency,
      // An absent assignee on creation stays unset; `null` and '' are only
      // meaningful as "clear" on update.
      assignedUser: assigneeResult.assignee || undefined,
      contractNumber,
      createdBy: req.user._id,
      status: 'Draft'
    });

    await logActivity(req.user._id, 'Contract Created', contract._id, `Created contract ${contract.contractNumber}`);
    res.status(201).json(contract);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', protect, async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignedUser', 'name email');
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    res.json(contract);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', protect, async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }

    // Archiving freezes the record. Every other write path on an archived
    // contract already says so - documents, obligations, milestones, renewals,
    // approval submissions and decisions, amendments - so this route was the one
    // remaining way to keep rewriting a contract that had been set aside, and it
    // did so behind nothing more specific than a generic "Contract Updated"
    // activity entry.
    //
    // Status is deliberately still allowed through, exactly as
    // utils/itemUpdate.js allows a status-only change on the work items of an
    // archived contract: moving a lapsed contract to Closed is the last
    // legitimate act on a contract nobody will work on again, and refusing it
    // would leave every archive permanently holding records in a non-terminal
    // state.
    if (contract.isArchived) {
      const detailRequested = CONTRACT_EDITABLE_FIELDS.some(
        (field) => req.body[field] !== undefined
      );
      if (detailRequested) {
        return res.status(400).json({ message: 'Archived contracts cannot be edited' });
      }
    }

    const isManagerial = isPrivileged(req.user);

    if (!isManagerial && req.body.status !== undefined) {
      return res.status(403).json({ message: 'Only administrators and managers can change contract status' });
    }

    if (req.body.status !== undefined) {
      if (!VALID_STATUSES.has(req.body.status)) {
        return res.status(400).json({ message: 'Invalid contract status' });
      }
      if (req.body.status !== contract.status && !canTransition(contract.status, req.body.status)) {
        return res.status(400).json({ message: `Contract status cannot change from '${contract.status}' to '${req.body.status}'` });
      }
    }

    // Same coercion guard as creation, and it matters more here: this route
    // writes onto an existing record, so `startDate: null` did not fail - it
    // silently replaced a real start date with 1970-01-01.
    const nextStart = req.body.startDate !== undefined
      ? parseContractDate(req.body.startDate)
      : contract.startDate;
    if (typeof nextStart === 'string') return res.status(400).json({ message: nextStart });

    const nextEnd = req.body.endDate !== undefined
      ? parseContractDate(req.body.endDate)
      : contract.endDate;
    if (typeof nextEnd === 'string') return res.status(400).json({ message: nextEnd });

    const dateError = validateContractDates(nextStart, nextEnd);
    if (dateError) return res.status(400).json({ message: dateError });

    if (req.body.currency !== undefined) {
      const currencyError = validateContractCurrency(req.body.currency);
      if (currencyError) return res.status(400).json({ message: currencyError });
    }

    let amount = contract.amount;
    if (req.body.amount !== undefined) {
      amount = validateContractAmount(req.body.amount);
      if (typeof amount === 'string') {
        return res.status(400).json({ message: amount });
      }
    }

    const updates = {};
    // The fields that need no coercion, so they are passed straight through.
    // startDate, endDate, amount and assignedUser are assigned individually
    // below because each is resolved and validated first; the union of both sets
    // is CONTRACT_EDITABLE_FIELDS, which is what the archived freeze tests.
    CONTRACT_EDITABLE_FIELDS
      .filter((field) => !['startDate', 'endDate', 'amount', 'assignedUser'].includes(field))
      .forEach((field) => {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      });
    if (req.body.startDate !== undefined) updates.startDate = nextStart;
    if (req.body.endDate !== undefined) updates.endDate = nextEnd;
    if (req.body.amount !== undefined) updates.amount = amount;
    if (req.body.status !== undefined && isManagerial) updates.status = req.body.status;

    // A contract number is generated, never supplied: honouring one from the
    // body would let a caller collide with an existing record or forge an
    // identifier outside the current year. `null` and '' clear the assignee.
    if (req.body.assignedUser !== undefined) {
      const assigneeResult = await resolveAssignee(req.body.assignedUser);
      if (assigneeResult.error) {
        return res.status(assigneeResult.error.status).json({ message: assigneeResult.error.message });
      }
      updates.assignedUser = assigneeResult.assignee;
    }

    // Edit-lock policy. Evaluated AFTER the values are resolved and validated,
    // so a locked field is compared against the real value it would take (an
    // ObjectId or null for the assignee, a Number for the amount, Date objects
    // for the dates). That is what lets a form resubmit the unchanged current
    // value - which the existing EditContract screen always does - and still be
    // accepted, so only a real change to a locked field is refused.
    const locked = evaluateContractEdit({ contract, proposed: updates });
    if (locked) {
      return res.status(locked.status).json({
        message: locked.message,
        lockedFields: locked.lockedFields,
        amendmentRequired: true,
        contractStatus: contract.status
      });
    }

    Object.assign(contract, updates);
    await contract.save();

    await logActivity(req.user._id, 'Contract Updated', contract._id, `Updated details for ${contract.contractNumber}`);
    res.json(contract);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/archive', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    contract.isArchived = true;
    await contract.save();

    await logActivity(req.user._id, 'Contract Archived', contract._id, `Archived contract ${contract.contractNumber}`);
    res.json({ message: 'Contract archived successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
