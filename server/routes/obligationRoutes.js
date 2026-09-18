const express = require('express');
const router = express.Router();
const Obligation = require('../models/Obligation');
const { protect } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');

router.get('/', protect, async (req, res) => {
  try {
    let query = {};
    if (req.user.role === 'Employee') {
      query.assignedTo = req.user._id;
    }
    const obligations = await Obligation.find(query).populate('contract', 'title contractNumber').populate('assignedTo', 'name email');
    res.json(obligations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/', protect, async (req, res) => {
  try {
    const obligation = await Obligation.create(req.body);
    await logActivity(req.user._id, 'Obligation Created', obligation.contract, `Obligation '${obligation.title}' created`);
    res.status(201).json(obligation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/:id', protect, async (req, res) => {
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
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;