const express = require('express');
const router = express.Router();
const Milestone = require('../models/Milestone');
const Contract = require('../models/Contract');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');

router.get('/', protect, async (req, res, next) => {
  try {
    const query = req.user.role === 'Employee' ? { assignedTo: req.user._id } : {};
    const milestones = await Milestone.find(query)
      .populate('contract', 'title contractNumber')
      .populate('assignedTo', 'name email')
      .sort({ dueDate: 1 });
    res.json(milestones);
  } catch (error) {
    next(error);
  }
});

router.post('/', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { title, description, contract: contractId, assignedTo, dueDate } = req.body;

    if (!title || !contractId || !assignedTo || !dueDate) {
      return res.status(400).json({ message: 'Title, contract, assignee and due date are required' });
    }
    const parsedDueDate = new Date(dueDate);
    if (Number.isNaN(parsedDueDate.getTime())) {
      return res.status(400).json({ message: 'A valid due date is required' });
    }

    const contract = await Contract.findById(contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Cannot create milestones for an archived contract' });
    }

    const assignee = await User.findById(assignedTo);
    if (!assignee) return res.status(404).json({ message: 'Assigned user not found' });

    const milestone = await Milestone.create({
      title: String(title).trim(),
      description: description || undefined,
      contract: contract._id,
      assignedTo: assignee._id,
      dueDate: parsedDueDate,
      status: 'Pending'
    });
    await logActivity(req.user._id, 'Milestone Created', milestone.contract, `Milestone '${milestone.title}' created`);
    res.status(201).json(milestone);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', protect, async (req, res, next) => {
  try {
    const milestone = await Milestone.findById(req.params.id);
    if (!milestone) return res.status(404).json({ message: 'Milestone not found' });
    if (req.user.role === 'Employee' && milestone.assignedTo.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only update milestones assigned to you' });
    }

    const allowedStatuses = ['Pending', 'In Progress', 'Completed', 'Overdue'];
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ message: 'Invalid milestone status' });
    }

    milestone.status = req.body.status;
    await milestone.save();
    await logActivity(req.user._id, 'Milestone Status Updated', milestone.contract, `Updated status to ${milestone.status}`);
    res.json(milestone);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
