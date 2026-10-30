const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const router = express.Router();
const Contract = require('../models/Contract');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canRenewContract, RENEWABLE_FROM } = require('../utils/contractTransitions');
const { expiringWindow, daysRemainingBetween, EXPIRING_STATUSES, startOfUtcDay } = require('../utils/dateWindow');
const { compareAndSetContract } = require('../utils/contractRevision');
const { requireRenewalOperationsReady } = require('../utils/renewalReadiness');

const WINDOWS = ['30', '60', '90'];
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

// Tightest reminder tier a contract falls into: a contract expiring in 45 days
// is a 60-day reminder, in 12 days a 30-day reminder.
const reminderFor = (daysRemaining) => {
  if (daysRemaining <= 30) return 30;
  if (daysRemaining <= 60) return 60;
  return 90;
};

// Contract end dates are calendar dates (UTC midnight when set from a date
// picker). All windowing and day arithmetic is done in UTC calendar days so a
// contract that expires "today" is never reported as -1 or missing by users in
// negative-UTC timezones. The helpers live in utils/dateWindow.js because the
// report endpoints count the same population and must not drift from it.

router.get('/expiring', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const windowParam = req.query.window === undefined ? '90' : String(req.query.window);
    if (!WINDOWS.includes(windowParam)) {
      return res.status(400).json({ message: 'window must be one of 30, 60 or 90' });
    }
    const windowDays = Number(windowParam);

    const contracts = await Contract.find({
      isArchived: false,
      endDate: expiringWindow(windowDays),
      status: { $in: EXPIRING_STATUSES }
    }).sort({ endDate: 1, _id: 1 });

    const payload = contracts.map((contract) => {
      const daysRemaining = daysRemainingBetween(new Date(), contract.endDate);
      return {
        ...contract.toObject(),
        daysRemaining,
        reminder: reminderFor(daysRemaining)
      };
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// The complete eligibility queue: every contract the renewal route would
// actually accept, regardless of when it ends.
//
// `/expiring` answers "what needs a reminder soon", so it is necessarily a
// forward-looking window over Active/Approved. That made two states the
// business rules permit unreachable: `Expired` (its end date is by definition
// in the past, so it can never match a forward window) and `Renewed` (a
// future end date, but a status the expiring list does not select). Since
// expireEligibleContracts() flips Active -> Expired every hour, contracts
// landed in `Expired` on a timer and could then never be renewed through the
// UI even though canRenewContract('Expired') is true and POST /renew/:id
// accepts them.
//
// This endpoint is the safety net that closes that loop: it selects on
// eligibility rather than on proximity, so the union of it and `/expiring`
// covers every state canRenewContract permits. Same guards as the rest of the
// renewal surface, and `lapsed` is derived rather than trusted from the client
// so the two lists partition cleanly on endDate.
router.get('/renewable', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const contracts = await Contract.find({
      isArchived: false,
      status: { $in: [...RENEWABLE_FROM] }
    }).sort({ endDate: 1, _id: 1 });

    const payload = contracts.map((contract) => {
      const daysRemaining = daysRemainingBetween(new Date(), contract.endDate);
      return {
        ...contract.toObject(),
        daysRemaining,
        lapsed: daysRemaining < 0,
        reminder: reminderFor(daysRemaining)
      };
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get('/history', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const query = {};
    if (req.query.contractId !== undefined) {
      if (!mongoose.isValidObjectId(req.query.contractId)) {
        return res.status(400).json({ message: 'contractId must be a valid identifier' });
      }
      query.contract = req.query.contractId;
    }
    const renewals = await Renewal.find(query)
      .populate('contract', 'contractNumber title status endDate isArchived')
      .populate('renewedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(renewals);
  } catch (error) {
    next(error);
  }
});

const sameDate = (left, right) => new Date(left).getTime() === new Date(right).getTime();
const sameId = (left, right) => String(left) === String(right);
const normalizedNotes = (notes) => (typeof notes === 'string' && notes.trim() ? notes.trim() : null);
const sameRenewalHistory = (entry, payload) => entry
  && sameId(entry.contract, payload.contract)
  && sameDate(entry.oldEndDate, payload.oldEndDate)
  && sameDate(entry.newEndDate, payload.newEndDate)
  && sameId(entry.renewedBy, payload.renewedBy)
  && (entry.notes || null) === (payload.notes || null)
  && entry.operationId === payload.operationId;

const getOperationId = (req, { generate = true } = {}) => {
  const headerId = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  const bodyId = req.body?.operationId;
  if (headerId && bodyId && headerId !== bodyId) return { error: 'Idempotency key values must match' };
  const operationId = headerId || bodyId || (generate ? randomUUID() : null);
  if (!operationId && !generate) return { error: 'An operationId is required' };
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    return { error: 'A valid operationId is required' };
  }
  return { operationId };
};

const conflict = (res, message = 'This renewal operation conflicts with the current contract state.') =>
  res.status(409).json({ message, code: 'RENEWAL_OPERATION_CONFLICT' });

const ensureHistory = async (payload) => {
  let entry;
  try {
    entry = await Renewal.findOneAndUpdate(
      { operationId: payload.operationId },
      { $setOnInsert: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    entry = await Renewal.findOne({ operationId: payload.operationId });
  }
  if (!entry) entry = await Renewal.findOne({ operationId: payload.operationId });
  if (!sameRenewalHistory(entry, payload)) {
    const error = new Error('Renewal operation identifier is already bound to different history');
    error.code = 'RENEWAL_HISTORY_CONFLICT';
    throw error;
  }
  return entry;
};

const contractMatchesRenewalMarker = (contract, marker) => {
  const payload = marker?.renewal;
  return Boolean(payload
    && marker.operationType === 'Renewal'
    && (contract.isArchived === false || contract.isArchived === null || contract.isArchived === undefined)
    && contract.status === 'Active'
    && sameDate(contract.endDate, payload.newEndDate)
    && contract.revision === payload.committedRevision);
};

const clearRenewalMarker = async (contract, marker) => {
  const plainMarker = {
    operationId: marker.operationId,
    operationType: marker.operationType,
    ...(marker.renewal ? {
      renewal: {
        oldEndDate: marker.renewal.oldEndDate,
        newEndDate: marker.renewal.newEndDate,
        renewedBy: marker.renewal.renewedBy,
        notes: marker.renewal.notes ?? null,
        committedRevision: marker.renewal.committedRevision
      }
    } : {})
  };
  return compareAndSetContract({
    contractId: contract._id,
    expectedRevision: contract.revision,
    expectedStatus: 'Active',
    requireUnarchived: true,
    clearOperationMarker: plainMarker
  });
};

const finishMarkedRenewal = async (contract, marker) => {
  if (!contractMatchesRenewalMarker(contract, marker)) {
    const error = new Error('Renewal marker no longer matches the current contract');
    error.code = 'RENEWAL_MARKER_STALE';
    throw error;
  }
  const payload = {
    contract: contract._id,
    operationId: marker.operationId,
    oldEndDate: marker.renewal.oldEndDate,
    newEndDate: marker.renewal.newEndDate,
    renewedBy: marker.renewal.renewedBy,
    notes: marker.renewal.notes || undefined
  };
  const entry = await ensureHistory(payload);
  await logActivity(
    payload.renewedBy,
    'Contract Renewed',
    payload.contract,
    `Renewed until ${new Date(payload.newEndDate).toISOString().slice(0, 10)}`,
    { operationId: payload.operationId }
  );
  let cleared;
  try {
    cleared = await clearRenewalMarker(contract, marker);
    if (!cleared) {
      const current = await Contract.findById(contract._id);
      if (current?.operationMarker) {
        const error = new Error('Renewal history is durable but its operation marker could not be cleared');
        error.code = 'RENEWAL_MARKER_CLEAR_FAILED';
        throw error;
      }
    }
  } catch (clearError) {
    clearError.code = 'RENEWAL_MARKER_CLEAR_FAILED';
    throw clearError;
  }
  return entry;
};

const sameRequestAsMarker = (marker, { operationId, newEndDate, renewedBy, notes }) => {
  const payload = marker?.renewal;
  return marker?.operationId === operationId
    && marker.operationType === 'Renewal'
    && payload
    && sameDate(payload.newEndDate, newEndDate)
    && sameId(payload.renewedBy, renewedBy)
    && (payload.notes || null) === (notes || null);
};

const completeExistingOperation = async (entry, { contractId, operationId, newEndDate, renewedBy, notes }) => {
  if (!sameRenewalHistory(entry, {
    contract: contractId,
    operationId,
    oldEndDate: entry.oldEndDate,
    newEndDate,
    renewedBy,
    notes: notes || undefined
  })) return null;

  const current = await Contract.findById(contractId);
  if (current?.operationMarker?.operationId === operationId
      && current.operationMarker.operationType === 'Renewal'
      && contractMatchesRenewalMarker(current, current.operationMarker)) {
    await finishMarkedRenewal(current, current.operationMarker);
  } else {
    await logActivity(renewedBy, 'Contract Renewed', contractId,
      `Renewed until ${new Date(newEndDate).toISOString().slice(0, 10)}`, { operationId });
  }
  return entry;
};

const sendHistoryPending = (res, operationId) => res.status(503).json({
  message: 'The contract renewal was applied, but its history is still pending. Retry with the same operation ID or ask an administrator to recover it.',
  code: 'RENEWAL_HISTORY_PENDING',
  operationId,
  recoverable: true
});

const sendFinalizationPending = (res, operationId) => res.status(503).json({
  message: 'The renewal and its history are durable, but finalization is incomplete. Retry with the same operation ID or ask an administrator to recover it.',
  code: 'RENEWAL_FINALIZATION_PENDING',
  operationId,
  recoverable: true
});

router.post('/renew/:contractId', protect, authorize('Admin', 'Manager'), requireRenewalOperationsReady, async (req, res, next) => {
  try {
    const { newEndDate } = req.body || {};
    const parsedEndDate = new Date(newEndDate);
    if (!newEndDate || Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ message: 'A valid new end date is required' });
    }
    const operation = getOperationId(req);
    if (operation.error) return res.status(400).json({ message: operation.error });
    const operationId = operation.operationId;
    const request = {
      operationId,
      newEndDate: parsedEndDate,
      renewedBy: req.user._id,
      notes: normalizedNotes(req.body?.notes)
    };

    let existing = await Renewal.findOne({ operationId });
    if (existing) {
      let completed;
      try {
        completed = await completeExistingOperation(existing, {
          contractId: req.params.contractId, operationId, newEndDate: request.newEndDate,
          renewedBy: req.user._id, notes: request.notes
        });
      } catch (error) {
        if (error.code === 'RENEWAL_HISTORY_CONFLICT') return conflict(res, 'The operation ID is already bound to different renewal history.');
        console.error('Renewal finalization retry failed', { contractId: req.params.contractId, operationId, errorCode: error.code });
        return sendFinalizationPending(res, operationId);
      }
      if (!completed) return conflict(res, 'This operation ID was already used with a different request or actor.');
      return res.status(201).json(existing);
    }

    let contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.operationMarker) {
      if (!sameRequestAsMarker(contract.operationMarker, { ...request, renewedBy: req.user._id })) {
        return conflict(res, 'Another contract operation is pending recovery.');
      }
      try {
        const renewal = await finishMarkedRenewal(contract, contract.operationMarker);
        return res.status(201).json(renewal);
      } catch (error) {
        if (error.code === 'RENEWAL_MARKER_STALE') return conflict(res, 'The marked renewal no longer matches the contract; operator review is required.');
        if (error.code === 'RENEWAL_HISTORY_CONFLICT') return conflict(res, 'The operation ID is already bound to different renewal history.');
        console.error('Renewal history completion failed', { contractId: String(contract._id), operationId, errorCode: error.code });
        if (error.code === 'RENEWAL_MARKER_CLEAR_FAILED') return sendFinalizationPending(res, operationId);
        return sendHistoryPending(res, operationId);
      }
    }

    if (contract.isArchived) return res.status(400).json({ message: 'Archived contracts cannot be renewed' });
    if (contract.status === 'Closed') return res.status(400).json({ message: 'Closed contracts cannot be renewed' });
    if (!canRenewContract(contract.status)) {
      return res.status(400).json({ message: `Contract in state '${contract.status}' cannot be renewed` });
    }
    if (parsedEndDate <= contract.endDate) {
      return res.status(400).json({ message: 'The renewal date must be after the current end date' });
    }
    // Keep the existing server-side floor for lapsed contracts.
    if (parsedEndDate <= startOfUtcDay(new Date())) {
      return res.status(400).json({ message: 'The renewal date must be in the future' });
    }

    const expectedRevision = contract.revision === undefined ? 0 : contract.revision;
    // This workflow performs both a renewal CAS and a marker-clear CAS, and
    // each increments revision. Keep enough headroom for both writes.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER - 1) {
      return conflict(res, 'This contract revision cannot safely record another renewal.');
    }
    const marker = {
      operationId,
      operationType: 'Renewal',
      renewal: {
        oldEndDate: contract.endDate,
        newEndDate: parsedEndDate,
        renewedBy: req.user._id,
        notes: request.notes,
        committedRevision: expectedRevision + 1
      }
    };
    let renewedContract;
    try {
      renewedContract = await compareAndSetContract({
        contractId: contract._id,
        expectedRevision,
        expectedStatus: contract.status,
        requireUnarchived: true,
        set: { endDate: parsedEndDate, status: 'Active' },
        operationMarker: marker
      });
    } catch (error) {
      // The partial unique marker index also prevents the same live operation
      // ID from being claimed on a different contract.
      if (error?.code === 11000) return conflict(res, 'This operation ID is already in use.');
      throw error;
    }
    if (!renewedContract) {
      // A competing request with this same operation ID may have won the CAS.
      existing = await Renewal.findOne({ operationId });
      if (existing) {
        let completed;
        try {
          completed = await completeExistingOperation(existing, {
            contractId: contract._id, operationId, newEndDate: parsedEndDate,
            renewedBy: req.user._id, notes: request.notes
          });
        } catch (error) {
          if (error.code === 'RENEWAL_HISTORY_CONFLICT') return conflict(res, 'The operation ID is already bound to different renewal history.');
          console.error('Renewal finalization retry failed', { contractId: String(contract._id), operationId, errorCode: error.code });
          return sendFinalizationPending(res, operationId);
        }
        if (completed) return res.status(201).json(existing);
      }
      contract = await Contract.findById(contract._id);
      if (contract?.operationMarker && sameRequestAsMarker(contract.operationMarker, request)) {
        try {
          const renewal = await finishMarkedRenewal(contract, contract.operationMarker);
          return res.status(201).json(renewal);
        } catch (error) {
          console.error('Renewal history completion failed', { contractId: String(contract._id), operationId, errorCode: error.code });
          if (error.code === 'RENEWAL_MARKER_CLEAR_FAILED') return sendFinalizationPending(res, operationId);
          return sendHistoryPending(res, operationId);
        }
      }
      return res.status(409).json({ message: 'Contract was updated by another request. Refresh and try again.' });
    }

    try {
      const renewal = await finishMarkedRenewal(renewedContract, marker);
      return res.status(201).json(renewal);
    } catch (error) {
      if (error.code === 'RENEWAL_MARKER_STALE') return conflict(res, 'The marked renewal no longer matches the contract; operator review is required.');
      if (error.code === 'RENEWAL_HISTORY_CONFLICT') return conflict(res, 'The operation ID is already bound to different renewal history.');
      console.error('Renewal history completion failed', { contractId: String(contract._id), operationId, errorCode: error.code });
      if (error.code === 'RENEWAL_MARKER_CLEAR_FAILED') return sendFinalizationPending(res, operationId);
      return sendHistoryPending(res, operationId);
    }
  } catch (error) {
    next(error);
  }
});

// Explicit recovery is restricted to Admins and is never run at startup.
router.post('/recover/:contractId', protect, authorize('Admin'), requireRenewalOperationsReady, async (req, res, next) => {
  try {
    const operation = getOperationId(req, { generate: false });
    if (operation.error && operation.error !== 'An operationId is required') {
      return res.status(400).json({ message: operation.error });
    }
    const contract = await Contract.findById(req.params.contractId);
    const marker = contract?.operationMarker;
    if (!contract || !marker
        || (operation.operationId && marker.operationId !== operation.operationId)
        || marker.operationType !== 'Renewal'
        || !contractMatchesRenewalMarker(contract, marker)) {
      return conflict(res, 'No matching recoverable renewal operation exists for this contract.');
    }

    try {
      const renewal = await finishMarkedRenewal(contract, marker);
      return res.status(201).json(renewal);
    } catch (error) {
      if (error.code === 'RENEWAL_HISTORY_CONFLICT' || error.code === 'RENEWAL_MARKER_STALE') {
        return conflict(res, 'The renewal marker or history is stale and requires operator review.');
      }
      console.error('Operator renewal recovery failed', {
        contractId: String(contract._id), operationId: marker.operationId, errorCode: error.code
      });
      if (error.code === 'RENEWAL_MARKER_CLEAR_FAILED') return sendFinalizationPending(res, marker.operationId);
      return sendHistoryPending(res, marker.operationId);
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
