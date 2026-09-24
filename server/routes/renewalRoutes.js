const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Contract = require('../models/Contract');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canRenewContract } = require('../utils/contractTransitions');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOWS = ['30', '60', '90'];

// Contract end dates are calendar dates (UTC midnight when set from a date
// picker). All windowing and day arithmetic is done in UTC calendar days so a
// contract that expires "today" is never reported as -1 or missing by users in
// negative-UTC timezones.
const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const daysRemainingBetween = (fromValue, toValue) =>
  Math.round((startOfUtcDay(toValue) - startOfUtcDay(fromValue)) / MS_PER_DAY);

// Tightest reminder tier a contract falls into: a contract expiring in 45 days
// is a 60-day reminder, in 12 days a 30-day reminder.
const reminderFor = (daysRemaining) => {
  if (daysRemaining <= 30) return 30;
  if (daysRemaining <= 60) return 60;
  return 90;
};

router.get('/expiring', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const windowParam = req.query.window === undefined ? '90' : String(req.query.window);
    if (!WINDOWS.includes(windowParam)) {
      return res.status(400).json({ message: 'window must be one of 30, 60 or 90' });
    }
    const windowDays = Number(windowParam);

    const today = new Date(startOfUtcDay(new Date()));
    // Include contracts expiring on the current UTC day (daysRemaining 0) and
    // everything through the end of today + window; the upper bound is
    // exclusive so date-only (UTC-midnight) end dates land in the right tier.
    const windowStart = today;
    const windowEnd = new Date(today.getTime() + (windowDays + 1) * MS_PER_DAY);

    const contracts = await Contract.find({
      isArchived: false,
      endDate: { $gte: windowStart, $lt: windowEnd },
      status: { $in: ['Active', 'Approved'] }
    }).sort({ endDate: 1 });

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

router.post('/renew/:contractId', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { newEndDate, notes } = req.body;
    const parsedEndDate = new Date(newEndDate);
    if (!newEndDate || Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ message: 'A valid new end date is required' });
    }

    const contract = await Contract.findById(req.params.contractId);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.isArchived) {
      return res.status(400).json({ message: 'Archived contracts cannot be renewed' });
    }
    if (contract.status === 'Closed') {
      return res.status(400).json({ message: 'Closed contracts cannot be renewed' });
    }
    if (!canRenewContract(contract.status)) {
      return res.status(400).json({ message: `Contract in state '${contract.status}' cannot be renewed` });
    }
    if (parsedEndDate <= contract.endDate) {
      return res.status(400).json({ message: 'The renewal date must be after the current end date' });
    }

    const oldEndDate = contract.endDate;
    contract.endDate = parsedEndDate;
    contract.status = 'Active';
    await contract.save();

    const renewal = await Renewal.create({
      contract: contract._id,
      oldEndDate,
      newEndDate: contract.endDate,
      renewedBy: req.user._id,
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : undefined
    });

    await logActivity(req.user._id, 'Contract Renewed', contract._id, `Renewed until ${parsedEndDate.toISOString().slice(0, 10)}`);
    res.status(201).json(renewal);
  } catch (error) {
    next(error);
  }
});

module.exports = router;