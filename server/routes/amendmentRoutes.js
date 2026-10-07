const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Contract = require('../models/Contract');
const ContractAmendment = require('../models/ContractAmendment');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract, employeeContractScope, isPrivileged } = require('../utils/access');
const { LOCKED_FIELDS, isEditableStatus, sameValue } = require('../utils/contractEditLock');
const {
  validateContractDates,
  validateContractAmount,
  validateContractCurrency,
  parseContractDate
} = require('../utils/contractValidation');

// The forward path for the changes `PUT /contracts/:id` now refuses with 409.
//
// Authorization deliberately mirrors routes/approvalRoutes.js rather than
// introducing a new rule:
//   * any user who can see the contract may REQUEST an amendment
//     (canAccessContract(req.user, contract)) - including an assigned Employee,
//     who is the person most likely to discover the wrong amount;
//   * only Admin and Manager may DECIDE one (authorize('Admin','Manager'));
//   * the requester may never decide their own request.
// A request is refused outright when the contract is in a state where a direct
// edit would be accepted anyway, so the workflow cannot be used to bypass the
// audit trail of a draft.

// Validates and normalises `proposed` against the contract's CURRENT values.
// Returns { proposed } with coerced types, or { error: { status, message } }.
const resolveProposal = async (contract, raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { status: 400, message: 'proposed must be an object of fields to change' } };
  }

  const keys = Object.keys(raw);
  const unknown = keys.filter((field) => !LOCKED_FIELDS.includes(field));
  if (unknown.length) {
    return {
      error: {
        status: 400,
        message: `Only ${LOCKED_FIELDS.join(', ')} may be amended. You can edit ${'title, type, partyName, description'} directly.`
      }
    };
  }
  if (keys.length === 0) {
    return { error: { status: 400, message: 'An amendment must propose at least one change' } };
  }

  const proposed = {};

  if (raw.amount !== undefined) {
    const amount = validateContractAmount(raw.amount);
    if (typeof amount === 'string') return { error: { status: 400, message: amount } };
    proposed.amount = amount;
  }

  // A currency the dashboard and the reports cannot format is refused here for
  // the same reason it is refused on a direct edit: approving the request would
  // otherwise persist it, and `Intl.NumberFormat` throws a RangeError on an
  // unknown code, taking the dashboard render down.
  if (raw.currency !== undefined) {
    const currencyError = validateContractCurrency(raw.currency);
    if (currencyError) return { error: { status: 400, message: currencyError } };
    // Assigned straight from the validated value. A `.trim()` here used to
    // throw a TypeError (and 500) on an explicit `null`, which the validator
    // had already been treating as "not supplied".
    proposed.currency = raw.currency;
  }

  // `new Date(null)` is 1970-01-01, so a proposal meant to clear a date was
  // stored as the epoch and, once approved, written onto the contract.
  for (const field of ['startDate', 'endDate']) {
    if (raw[field] === undefined) continue;
    const parsed = parseContractDate(raw[field]);
    if (typeof parsed === 'string') {
      return { error: { status: 400, message: parsed } };
    }
    proposed[field] = parsed;
  }

  if (raw.assignedUser !== undefined) {
    // null / '' clear the assignee, exactly as the direct-edit route does.
    if (raw.assignedUser === null || raw.assignedUser === '') {
      proposed.assignedUser = null;
    } else if (!mongoose.isValidObjectId(raw.assignedUser)) {
      return { error: { status: 400, message: 'Assigned user must be a valid identifier' } };
    } else {
      const assignee = await User.findById(raw.assignedUser).select('_id');
      if (!assignee) return { error: { status: 404, message: 'Assigned user not found' } };
      proposed.assignedUser = assignee._id;
    }
  }

  // The RESULTING date range must be valid, not just the two dates that were
  // supplied. Moving only the start date past the current end date is otherwise
  // accepted and would leave the contract in a shape the direct-edit route
  // refuses to save.
  if (proposed.startDate || proposed.endDate) {
    const start = proposed.startDate || contract.startDate;
    const end = proposed.endDate || contract.endDate;
    const dateError = validateContractDates(new Date(start), new Date(end));
    if (dateError) return { error: { status: 400, message: dateError } };
  }

  // Refuse a no-op. Otherwise the request would sit in the queue blocking any
  // other amendment (one open request per contract) while changing nothing.
  const noop = keys.filter((field) => sameValue(field, proposed[field], contract[field]));
  if (noop.length === keys.length) {
    return {
      error: {
        status: 400,
        message: `The proposed values already match the contract (${noop.join(', ')}). Nothing to amend.`
      }
    };
  }

  return { proposed };
};

// POST /api/contract-amendments  - request an amendment
router.post('/', protect, async (req, res, next) => {
  try {
    const { contract: contractId, reason } = req.body;
    if (!mongoose.isValidObjectId(contractId)) {
      return res.status(400).json({ message: 'A valid contract identifier is required' });
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ message: 'A reason is required for an amendment' });
    }

    const contract = await Contract.findById(contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Archived contracts cannot be amended' });
    }
    if (isEditableStatus(contract.status)) {
      return res.status(400).json({
        message: `A contract in state '${contract.status}' is edited directly - no amendment is needed.`
      });
    }

    const { proposed, error } = await resolveProposal(contract, req.body.proposed);
    if (error) return res.status(error.status).json({ message: error.message });

    // The unique partial index on { contract, status: 'Pending' } is the real
    // guard against two competing requests. Catch the duplicate-key error to
    // turn it into a 409 with a useful message instead of a 500.
    let amendment;
    try {
      amendment = await ContractAmendment.create({
        contract: contract._id,
        requestedBy: req.user._id,
        proposed,
        reason: reason.trim(),
        before: {
          amount: contract.amount,
          currency: contract.currency,
          startDate: contract.startDate,
          endDate: contract.endDate,
          assignedUser: contract.assignedUser || null
        }
      });
    } catch (createError) {
      if (createError?.code === 11000) {
        return res.status(409).json({
          message: 'An amendment for this contract is already awaiting a decision'
        });
      }
      throw createError;
    }

    await logActivity(req.user._id, 'Amendment Requested', contract._id,
      `Amendment requested for ${contract.contractNumber}: ${Object.keys(proposed).join(', ')}`);
    // `Document.populate()` returns a Promise, so it has to be awaited here and
    // the document passed on. Serialising the promise itself sends `{}`, which
    // costs the client the `_id` it needs to follow the request and the
    // `before`/`proposed` pair the form echoes back. Only the display name is
    // attached; the requester's address is not needed to judge a request.
    await amendment.populate('requestedBy', 'name');
    res.status(201).json(await withAssigneeNames(amendment));
  } catch (error) {
    next(error);
  }
});

// GET /api/contract-amendments?status=Pending&contract=<id>&mine=true
router.get('/', protect, async (req, res, next) => {
  try {
    const filters = [];
    const { status, contract } = req.query;

    if (status !== undefined) {
      if (!['Pending', 'Approved', 'Rejected', 'Withdrawn'].includes(status)) {
        return res.status(400).json({ message: 'Invalid amendment status filter value' });
      }
      filters.push({ status });
    }
    if (contract !== undefined) {
      if (!mongoose.isValidObjectId(contract)) {
        return res.status(400).json({ message: 'Invalid contract identifier' });
      }
      filters.push({ contract });
    }
    if (req.query.mine === 'true') filters.push({ requestedBy: req.user._id });

    // An Employee has no business reading the company-wide amendment queue, and
    // neither does any other unprivileged caller. Scoping to the contracts the
    // user can access keeps the list consistent with the contract list instead
    // of exposing other teams' requests.
    //
    // The predicate is the allow-list from utils/access.js, matching
    // contractRoutes.js, reportRoutes.js and the work-item routes. It used to ask
    // the inverse question - `role === 'Employee'` - and answer "see
    // everything" for every other value, which is the fail-open shape
    // utils/access.js exists to prevent: a role that is merely not 'Employee'
    // (null, renamed, or a future role not yet added to the vocabulary) was
    // handed the amendment trail of contracts that canAccessContract refuses to
    // open for it, including the before/after amount, currency, dates and
    // assignee name. An unrecognised role is now scoped like an Employee, which
    // is what every other listing route already does for it.
    if (!isPrivileged(req.user)) {
      const visible = await Contract.find(employeeContractScope(req.user._id)).select('_id');
      filters.push({ contract: { $in: visible.map((c) => c._id) } });
    }

    const query = filters.length === 1 ? filters[0] : { $and: filters };
    const amendments = await ContractAmendment.find(query)
      .populate('contract', 'contractNumber title status')
      .populate('requestedBy', 'name')
      .populate('decidedBy', 'name')
      .sort({ createdAt: -1 });

    // One batch for the whole page rather than per amendment, so the queue costs
    // a single extra query however many rows it renders.
    const ids = [...new Set(amendments.flatMap(assigneeIdsIn))];
    const users = ids.length ? await User.find({ _id: { $in: ids } }).select('_id name') : [];
    const names = new Map(users.map((user) => [user._id.toString(), user.name]));

    res.json(amendments.map((amendment) => ({
      ...amendment.toObject(),
      ...assigneeNameFields(amendment, names)
    })));
  } catch (error) {
    next(error);
  }
});

// PUT /api/contract-amendments/:id/action  - approve or reject
// Mirrors routes/approvalRoutes.js `PUT /:id/action`.
router.put('/:id/action', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { action, comments } = req.body; // action = 'Approved' | 'Rejected'
    if (!['Approved', 'Rejected'].includes(action)) {
      return res.status(400).json({ message: 'Action must be Approved or Rejected' });
    }

    const amendment = await ContractAmendment.findById(req.params.id);
    if (!amendment) return res.status(404).json({ message: 'Amendment request not found' });
    if (amendment.status !== 'Pending') {
      return res.status(409).json({ message: 'This amendment has already been decided' });
    }

    const requesterId = amendment.requestedBy?._id || amendment.requestedBy;
    if (requesterId && requesterId.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot approve or reject your own amendment' });
    }

    const contract = await Contract.findById(amendment.contract);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Archived contracts cannot be amended' });
    }
    if (isEditableStatus(contract.status)) {
      return res.status(409).json({
        message: `The contract is now in state '${contract.status}' and is edited directly, so this amendment no longer applies`
      });
    }

    const changed = Object.keys(amendment.proposed);

    if (action === 'Approved') {
      // Re-validate at decision time. The contract may have been renewed since
      // the request was made, which moves endDate - approving a stale endDate
      // would silently undo the renewal.
      const start = amendment.proposed.startDate || contract.startDate;
      const end = amendment.proposed.endDate || contract.endDate;
      const dateError = validateContractDates(new Date(start), new Date(end));
      if (dateError) return res.status(409).json({ message: `Cannot apply amendment: ${dateError}` });

      const amountError = amendment.proposed.amount !== undefined
        ? validateContractAmount(amendment.proposed.amount)
        : null;
      if (typeof amountError === 'string') {
        return res.status(409).json({ message: `Cannot apply amendment: ${amountError}` });
      }

      // Staleness. The request was written against the values captured in
      // `before`. If any field the amendment touches has moved since then, the
      // approver is being shown a change that was calculated against terms that
      // are no longer in force, and applying it would silently discard the
      // intervening change - a renewal is the realistic case, since it moves
      // endDate without going through this route. Compare against `before`,
      // not against the proposed value: "proposed != current" is true for every
      // genuine amendment and would refuse all of them.
      const stale = changed.filter((field) => !sameValue(field, contract[field], amendment.before[field]));
      if (stale.length) {
        return res.status(409).json({
          message: `Cannot apply amendment: ${stale.join(', ')} changed after this request was made. ` +
            `Review and resubmit the amendment against the current contract.`
        });
      }

      // Defence in depth: the proposed value already holds, so applying it would
      // record an approval for a no-op.
      //
      // UNDER THE CURRENT RULES THIS BRANCH CANNOT BE REACHED, and the comment
      // that used to sit here ("the request-time check cannot catch this: the
      // value may have been changed by a later approved amendment") was wrong on
      // both counts. The staleness check above catches exactly that case, with a
      // different message. The proof, with `before` the snapshot taken in the
      // same request that stored `proposed`:
      //
      //   * Request time refuses a proposal that matches the contract as it stood
      //     (the noop check in resolveProposal), so for any stored amendment at
      //     least one field has proposed[f] !== before[f].
      //   * `redundant` = { f : proposed[f] === contract_now[f] } and
      //     `stale`     = { f : contract_now[f] !== before[f] }.
      //     If contract_now[f] === before[f] AND f is redundant, then
      //     proposed[f] === before[f] as sameValue is an equivalence per field.
      //     So "every field redundant" forces "every field also stale", which the
      //     branch above has already returned on.
      //
      // Retained rather than deleted: it costs one array pass, and if the
      // staleness rule is ever relaxed or the request-time no-op check removed,
      // this is the guard that stops an approval being recorded for a change
      // that was never made. The reachable behaviour - a request whose value has
      // since been applied elsewhere is refused as stale, and stays open - is
      // pinned by server/test/amendments.test.js.
      const redundant = changed.filter((field) => sameValue(field, amendment.proposed[field], contract[field]));
      if (redundant.length === changed.length) {
        return res.status(409).json({
          message: `Cannot apply amendment: ${redundant.join(', ')} already matches the current contract`
        });
      }
    }

    // Every rule above is a READ. The decision itself is then written as a
    // single compare-and-set, repeating `status: 'Pending'` in the write filter
    // - the same pattern expiryUpdater.js uses for the expiry flip, and for the
    // same reason.
    //
    // A plain read-then-write leaves a window between the two awaits above: two
    // approvers pressing Approve at the same moment both read Pending, both
    // pass the staleness check against the same `before`, and both write. The
    // contract would be updated twice and two "Amendment Approved" entries
    // would be logged for one request. Matching on `status: 'Pending'` inside
    // the atomic write makes the second caller match nothing, so exactly one
    // decision can ever be recorded and the loser is told the request is already
    // decided. There is no transaction here - the connection may be a standalone
    // mongod, which cannot start one - so the claim is the whole guarantee.
    const decided = await ContractAmendment.findOneAndUpdate(
      { _id: amendment._id, status: 'Pending' },
      {
        $set: {
          status: action,
          decidedBy: req.user._id,
          decisionComments: typeof comments === 'string' && comments.trim() ? comments.trim() : null,
          decidedAt: new Date()
        }
      },
      { new: true }
    );
    if (!decided) {
      return res.status(409).json({ message: 'This amendment has already been decided' });
    }

    // The contract is written only after the request has been claimed, so a
    // losing concurrent caller never touches it.
    if (action === 'Approved') {
      Object.assign(contract, amendment.proposed);
      await contract.save();
    }

    const summary = action === 'Approved'
      ? `Amendment approved and applied: ${changed.join(', ')}`
      : `Amendment rejected${decided.decisionComments ? `: ${decided.decisionComments}` : ''}`;

    await logActivity(req.user._id, `Amendment ${action}`, contract._id,
      `${summary} for ${contract.contractNumber}`);
    res.json(await withAssigneeNames(decided));
  } catch (error) {
    next(error);
  }
});

// `before` and `proposed` are Mixed, so mongoose cannot populate the
// `assignedUser` inside them and a populated amendment would carry two bare
// ObjectIds where the UI needs "who was it, who should it be". A raw id is
// neither readable in a table nor something to hand an approver to judge.
//
// The ids are resolved here instead of in a second model, and only the NAME is
// attached - never the email, never the role. That is the same disclosure
// `GET /contracts/:id` already makes: it returns the populated assignee
// including their name, and an amendment is only ever listed for contracts the
// caller can already read.

// Both display helpers below are referenced from the route handlers above, which
// is safe: they run per request, long after this module has finished evaluating.
//
// `proposed.assignedUser === null` is a proposed change (clear the assignee),
// so its name is attached whenever the field is present at all rather than only
// when it is truthy; `undefined` keeps meaning "not proposed", untouched.
const assigneeNameFields = (amendment, names) => ({
  ...(amendment.proposed?.assignedUser !== undefined
    ? { proposedAssignee: names.get(String(amendment.proposed.assignedUser)) || null }
    : {}),
  ...(amendment.before?.assignedUser
    ? { beforeAssignee: names.get(String(amendment.before.assignedUser)) || null }
    : {})
});

// The ids `before` and `proposed` actually reference. Anything that is not a
// valid id is dropped rather than queried, so a malformed Mixed value cannot
// turn into a CastError on a read path.
const assigneeIdsIn = (amendment) => [amendment.before?.assignedUser, amendment.proposed?.assignedUser]
  .map((value) => (value && typeof value === 'object' && value._id ? value._id : value))
  .filter((value) => value && mongoose.isValidObjectId(String(value)))
  .map(String);

// Resolves the names for one amendment. Used by the single-document responses.
//
// The result is a PLAIN object, not the mongoose document: `toJSON` serialises
// only the declared schema paths, so a display field assigned onto a document
// is silently dropped on the way out. The batched GET below therefore builds its
// objects the same way, and both are pinned by server/test/amendments.test.js.
const withAssigneeNames = async (amendment) => {
  const ids = [...new Set(assigneeIdsIn(amendment))];
  if (!ids.length) return amendment.toObject();
  const users = await User.find({ _id: { $in: ids } }).select('_id name');
  const names = new Map(users.map((user) => [user._id.toString(), user.name]));
  return { ...amendment.toObject(), ...assigneeNameFields(amendment, names) };
};

module.exports = router;
