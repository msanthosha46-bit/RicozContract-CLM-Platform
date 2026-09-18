const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');

router.get('/expiring', protect, async (req, res) => {
  try {
    const now = new Date();
    const future90Days = new Date();
    future90Days.setDate(now.getDate() + 90);

    const contracts = await Contract.find({
      endDate: { $gte: now, $lte: future90Days },
      status: { $in: ['Active', 'Approved'] }
    });

    res.json(contracts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/renew/:contractId', protect, authorize('Admin', 'Manager'), async (req, res) => {
  try {
    const { newEndDate, notes } = req.body;
    const parsedEndDate = new Date(newEndDate);
    if (!newEndDate || Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ message: 'A valid new end date is required' });
    }

    const contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (parsedEndDate <= contract.endDate) {
      return res.status(400).json({ message: 'The renewal date must be after the current end date' });
    }

    const oldEndDate = contract.endDate;
    contract.endDate = parsedEndDate;
    contract.status = 'Renewed';
    await contract.save();

    const renewal = await Renewal.create({
      contract: contract._id,
      oldEndDate,
      newEndDate: contract.endDate,
      renewedBy: req.user._id,
      notes
    });

    await logActivity(req.user._id, 'Contract Renewed', contract._id, `Renewed until ${newEndDate}`);
    res.status(201).json(renewal);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;