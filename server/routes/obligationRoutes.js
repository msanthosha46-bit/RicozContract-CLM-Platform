const express = require('express');
const router = express.Router();
const Obligation = require('../models/Obligation');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const markOverdueItems = require('../utils/overdueUpdater');

router.get('/', protect, async (req, res, next) => {
  try {
    await markOverdueItems();
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
    const obligation = await Obligation.create(req.body);
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