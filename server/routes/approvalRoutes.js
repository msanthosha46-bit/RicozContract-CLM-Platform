const express = require('express');
const router = express.Router();
const Approval = require('../models/Approval');
const Contract = require('../models/Contract');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');

// Submit contract for approval
router.post('/submit/:contractId', protect, async (req, res) => {
  try {
    const contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const pendingApproval = await Approval.findOne({ contract: contract._id, status: 'Pending' });
    if (pendingApproval) {
      return res.status(409).json({ message: 'This contract is already pending approval' });
    }

    contract.status = 'Pending Approval';
    await contract.save();

    const approval = await Approval.create({
      contract: contract._id,
      requestedBy: req.user._id,
      status: 'Pending'
    });

    await logActivity(req.user._id, 'Submitted for Approval', contract._id, `Contract ${contract.contractNumber} submitted for approval`);
    res.status(201).json(approval);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get pending approvals list
router.get('/pending', protect, authorize('Admin', 'Manager'), async (req, res) => {
  try {
    const pending = await Approval.find({ status: 'Pending' })
      .populate('contract')
      .populate('requestedBy', 'name email');
    res.json(pending);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Approve/Reject Contract
router.put('/:id/action', protect, authorize('Admin', 'Manager'), async (req, res) => {
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

    approval.status = action;
    approval.comments = comments;
    approval.approver = req.user._id;
    approval.decisionDate = new Date();
    await approval.save();

    const contract = await Contract.findById(approval.contract);
    if (contract) {
      contract.status = action === 'Approved' ? 'Active' : 'Rejected';
      await contract.save();
    }

    await logActivity(req.user._id, `Contract ${action}`, approval.contract, `Approval decision: ${action}. Comments: ${comments || 'None'}`);
    res.json(approval);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;