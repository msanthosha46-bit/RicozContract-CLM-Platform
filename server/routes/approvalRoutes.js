const express = require('express');
const router = express.Router();
const Approval = require('../models/Approval');
const Contract = require('../models/Contract');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');
const { canSubmitForApproval } = require('../utils/contractTransitions');
const { compareAndSetContract } = require('../utils/contractRevision');

const reportCompensationFailure = (res, { recordType, recordId, contractId, action }, error) => {
  console.error(`${recordType} decision compensation failed`, {
    recordId: String(recordId),
    contractId: String(contractId),
    action,
    errorName: error?.name || 'ConditionalRestoreMiss',
    errorCode: error?.code
  });
  res.status(500).json({
    code: 'DECISION_COMPENSATION_FAILED',
    message: 'The contract update did not complete and the related decision could not be restored. Operator reconciliation is required.',
    decisionRestored: false
  });
};

router.post('/submit/:contractId', protect, async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Archived contracts cannot be submitted for approval' });
    }
    if (!canSubmitForApproval(contract.status)) {
      return res.status(400).json({ message: `Contract in state '${contract.status}' cannot be submitted for approval` });
    }

    const pendingApproval = await Approval.findOne({ contract: contract._id, status: 'Pending' });
    if (pendingApproval) {
      return res.status(409).json({ message: 'This contract is already pending approval' });
    }

    const submitted = await compareAndSetContract({
      contractId: contract._id,
      expectedRevision: contract.revision === undefined ? 0 : contract.revision,
      expectedStatus: contract.status,
      requireUnarchived: true,
      set: { status: 'Pending Approval' }
    });
    if (!submitted) {
      return res.status(409).json({ message: 'Contract was updated by another request. Refresh and try again.' });
    }

    let approval;
    try {
      approval = await Approval.create({
        contract: contract._id,
        requestedBy: req.user._id,
        status: 'Pending'
      });
    } catch (error) {
      try {
        const restored = await compareAndSetContract({
          contractId: contract._id,
          expectedRevision: submitted.revision,
          expectedStatus: 'Pending Approval',
          requireUnarchived: true,
          set: { status: contract.status }
        });
        if (!restored) {
          reportCompensationFailure(res, {
            recordType: 'Approval submission',
            recordId: contract._id,
            contractId: contract._id,
            action: 'create'
          });
          return;
        }
      } catch (restoreError) {
        reportCompensationFailure(res, {
          recordType: 'Approval submission',
          recordId: contract._id,
          contractId: contract._id,
          action: 'create'
        }, restoreError);
        return;
      }
      throw error;
    }

    await logActivity(req.user._id, 'Submitted for Approval', contract._id, `Contract ${contract.contractNumber} submitted for approval`);
    res.status(201).json(approval);
  } catch (error) {
    next(error);
  }
});

// Get pending approvals list. Only approvals whose contract is still in
// 'Pending Approval' (and not archived) are listed, because those are the only
// ones the decision route can act on. A contract whose status was changed away
// from 'Pending Approval' (e.g. back to Draft) can no longer be decided, so its
// stale Pending record must not clutter the queue forever.
router.get('/pending', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const decidableContracts = await Contract.find({ status: 'Pending Approval', isArchived: false }).select('_id');
    const pending = await Approval.find({ status: 'Pending', contract: { $in: decidableContracts.map((c) => c._id) } })
      .populate('contract')
      .populate('requestedBy', 'name email');
    res.json(pending);
  } catch (error) {
    next(error);
  }
});

// Approve/Reject Contract
router.put('/:id/action', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { action, comments } = req.body; // action = 'Approved' | 'Rejected'
    if (!['Approved', 'Rejected'].includes(action)) {
      return res.status(400).json({ message: 'Action must be Approved or Rejected' });
    }

    const approval = await Approval.findById(req.params.id);
    if (!approval) return res.status(404).json({ message: 'Approval request not found' });
    if (approval.status !== 'Pending') {
      return res.status(409).json({ message: 'This approval request has already been decided' });
    }

    const requesterId = approval.requestedBy?._id || approval.requestedBy;
    if (requesterId && requesterId.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot approve or reject your own contract request' });
    }

    const contract = await Contract.findById(approval.contract);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Archived contracts cannot be approved or rejected' });
    }
    if (contract.status !== 'Pending Approval') {
      return res.status(409).json({ message: `This contract cannot be decided in state '${contract.status}' (must be Pending Approval)` });
    }

    // The decision is written as a single compare-and-set, repeating
    // `status: 'Pending'` in the write filter - the same claim amendmentRoutes.js
    // and expiryUpdater.js use, and for the same reason. Every rule above is a
    // READ, so a plain read-then-write leaves a window between them: two
    // approvers (or one double-submitting) both read Pending, both pass the
    // checks, both write, and the contract is decided twice - one decision
    // overwriting the other and both "Contract Approved"/"Contract Rejected"
    // entries landing in the audit trail for a single request. Matching on
    // `status: 'Pending'` inside the atomic write makes the second caller match
    // nothing, so exactly one decision can ever be recorded.
    const decided = await Approval.findOneAndUpdate(
      { _id: approval._id, status: 'Pending' },
      {
        $set: {
          status: action,
          comments,
          approver: req.user._id,
          decisionDate: new Date()
        }
      },
      { new: true }
    );
    if (!decided) {
      return res.status(409).json({ message: 'This approval request has already been decided' });
    }

    // The approval is claimed first so only one caller decides it. If the
    // contract revision changed since it was read, restore the claim to Pending
    // and let the approver refresh rather than applying a stale decision.
    let updatedContract;
    const restoreApprovalClaim = async () => {
      try {
        const result = await Approval.updateOne(
          { _id: decided._id, status: action, approver: req.user._id },
          { $set: { status: 'Pending' }, $unset: { approver: 1, comments: 1, decisionDate: 1 } }
        );
        if (result?.matchedCount !== 1) {
          reportCompensationFailure(res, {
            recordType: 'Approval',
            recordId: decided._id,
            contractId: contract._id,
            action
          });
          return false;
        }
        return true;
      } catch (restoreError) {
        reportCompensationFailure(res, {
          recordType: 'Approval',
          recordId: decided._id,
          contractId: contract._id,
          action
        }, restoreError);
        return false;
      }
    };

    try {
      updatedContract = await compareAndSetContract({
        contractId: contract._id,
        expectedRevision: contract.revision === undefined ? 0 : contract.revision,
        expectedStatus: 'Pending Approval',
        requireUnarchived: true,
        set: { status: action === 'Approved' ? 'Active' : 'Rejected' }
      });
    } catch (error) {
      if (!await restoreApprovalClaim()) return;
      throw error;
    }
    if (!updatedContract) {
      if (!await restoreApprovalClaim()) return;
      return res.status(409).json({
        message: 'Contract was updated by another request. The approval remains pending; refresh and try again.'
      });
    }

    await logActivity(req.user._id, `Contract ${action}`, approval.contract, `Approval decision: ${action}. Comments: ${comments || 'None'}`);
    res.json(decided);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
