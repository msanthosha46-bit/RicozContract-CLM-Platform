const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');

router.get('/summary', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const total = await Contract.countDocuments({ isArchived: false });
    const draft = await Contract.countDocuments({ status: 'Draft', isArchived: false });
    const pending = await Contract.countDocuments({ status: 'Pending Approval', isArchived: false });
    const active = await Contract.countDocuments({ status: 'Active', isArchived: false });
    const expired = await Contract.countDocuments({ status: 'Expired', isArchived: false });
    const completed = await Contract.countDocuments({ status: 'Closed', isArchived: false });
    const overdueObligations = await Obligation.countDocuments({ status: 'Overdue' });
    const overdueMilestones = await Milestone.countDocuments({ status: 'Overdue' });
    const renewals = await Renewal.countDocuments();

    const now = new Date();
    const in30Days = new Date();
    in30Days.setDate(now.getDate() + 30);
    const expiringSoon = await Contract.countDocuments({
      endDate: { $gte: now, $lte: in30Days },
      status: 'Active',
      isArchived: false
    });

    const statusBreakdown = await Contract.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const typeBreakdown = await Contract.aggregate([
      { $match: { isArchived: false } },
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    res.json({
      metrics: {
        total, draft, pending, active, expiringSoon, expired, completed,
        overdueObligations, overdueMilestones, renewals
      },
      statusBreakdown,
      typeBreakdown
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;