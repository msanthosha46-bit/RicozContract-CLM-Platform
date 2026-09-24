const express = require('express');
const router = express.Router();
const Obligation = require('../models/Obligation');
const Contract = require('../models/Contract');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract } = require('../utils/access');

router.get('/', protect, async (req, res, next) => {
  try {
    let query = {};
    if (req.user.role === 'Employee') {
      query.assignedTo = req.user._id;
    }
    const obligations = await Obligation.find(query).populate('contract', 'title contractNumber').populate('assignedTo', 'name email');
    res.json(obligations);
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
      return res.status(400).json({ message: 'Cannot create obligations for an archived contract' });
    }

    const assignee = await User.findById(assignedTo);
    if (!assignee) return res.status(404).json({ message: 'Assigned user not found' });

    const obligation = await Obligation.create({
      title: String(title).trim(),
      description: description || undefined,
      contract: contract._id,
      assignedTo: assignee._id,
      dueDate: parsedDueDate,
      status: 'Pending'
    });
    await logActivity(req.user._id, 'Obligation Created', obligation.contract, `Obligation '${obligation.title}' created`);
    res.status(201).json(obligation);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', protect, async (req, res, next) => {
  try {
    const obligation = await Obligation.findById(req.params.id);
    if (!obligation) return res.status(404).json({ message: 'Obligation not found' });
    if (req.user.role === 'Employee' && obligation.assignedTo.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only update obligations assigned to you' });
    }

    const allowedStatuses = ['Pending', 'In Progress', 'Completed', 'Overdue'];
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ message: 'Invalid obligation status' });
    }

    obligation.status = req.body.status;
    await obligation.save();

    await logActivity(req.user._id, 'Obligation Status Updated', obligation.contract, `Updated status to ${obligation.status}`);
    res.json(obligation);
  } catch (error) {
    next(error);
  }
});

module.exports = router;