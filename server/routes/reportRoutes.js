const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');
const { employeeContractScope } = require('../utils/access');

router.get('/summary', protect, authorize('Admin', 'Manager'), async (req, res, next) => {
  try {
    const [total, draft, pending, active, expired, completed, overdueObligations, overdueMilestones, renewals, expiringSoon, statusBreakdown, typeBreakdown] = await Promise.all([
      Contract.countDocuments({ isArchived: false }),
      Contract.countDocuments({ status: 'Draft', isArchived: false }),
      Contract.countDocuments({ status: 'Pending Approval', isArchived: false }),
      Contract.countDocuments({ status: 'Active', isArchived: false }),
      Contract.countDocuments({ status: 'Expired', isArchived: false }),
      Contract.countDocuments({ status: 'Closed', isArchived: false }),
      Obligation.countDocuments({ status: 'Overdue' }),
      Milestone.countDocuments({ status: 'Overdue' }),
      Renewal.countDocuments(),
      (() => {
        const now = new Date();
        const in30Days = new Date();
        in30Days.setDate(now.getDate() + 30);
        return Contract.countDocuments({
          endDate: { $gte: now, $lte: in30Days },
          status: 'Active',
          isArchived: false
        });
      })(),
      Contract.aggregate([
        { $match: { isArchived: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Contract.aggregate([
        { $match: { isArchived: false } },
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ])
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

// Dashboard endpoint: single scoped aggregation available to every role so the
// values rendered on the Dashboard always match the Contracts page for the
// same user (Admin/Manager see the whole repository, Employees see only the
// contracts they created or are assigned to).
router.get('/dashboard', protect, async (req, res, next) => {
  try {
    const scope = req.user.role === 'Employee' ? employeeContractScope(req.user._id) : {};
    const baseFilter = { isArchived: false, ...scope };

    const [facet, expiringSoon, recentContracts] = await Promise.all([
      Contract.aggregate([
        { $match: baseFilter },
        {
          $facet: {
            statusCounts: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            valueByCurrency: [
              {
                $group: {
                  _id: '$currency',
                  total: { $sum: '$amount' },
                  active: {
                    $sum: { $cond: [{ $eq: ['$status', 'Active'] }, '$amount', 0] }
                  }
                }
              }
            ]
          }
        }
      ]),
      (() => {
        const now = new Date();
        const in30Days = new Date();
        in30Days.setDate(now.getDate() + 30);
        return Contract.countDocuments({
          endDate: { $gte: now, $lte: in30Days },
          status: 'Active',
          isArchived: false,
          ...scope
        });
      })(),
      Contract.find(baseFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .select('contractNumber title status amount currency partyName type endDate')
    ]);

    const bucket = facet[0] || {};
    const statusCounts = bucket.statusCounts || [];
    const valueByCurrency = (bucket.valueByCurrency || []).map((item) => ({
      currency: item._id,
      total: item.total,
      active: item.active
    }));

    const statusMap = new Map(statusCounts.map((item) => [item._id, item.count]));
    const total = statusCounts.reduce((sum, item) => sum + item.count, 0);

    res.json({
      metrics: {
        total,
        draft: statusMap.get('Draft') || 0,
        pending: statusMap.get('Pending Approval') || 0,
        active: statusMap.get('Active') || 0,
        expiringSoon,
        expired: statusMap.get('Expired') || 0,
        completed: statusMap.get('Closed') || 0
      },
      statusBreakdown: statusCounts,
      valueByCurrency,
      recentContracts
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;