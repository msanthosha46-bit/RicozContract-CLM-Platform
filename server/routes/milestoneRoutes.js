const express = require('express');
const router = express.Router();
const Milestone = require('../models/Milestone');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const markOverdueItems = require('../utils/overdueUpdater');

router.get('/', protect, async (req, res, next) => {
  try {
    await markOverdueItems();
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
    const milestone = await Milestone.create(req.body);
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
