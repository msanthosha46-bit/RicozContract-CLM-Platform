const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const Renewal = require('../models/Renewal');
const { protect, authorize } = require('../middleware/auth');
const { employeeContractScope, isPrivileged } = require('../utils/access');
const { VALID_STATUSES } = require('../utils/contractTransitions');
const { expiringWindow, EXPIRING_STATUSES } = require('../utils/dateWindow');

// `$group` output order is whatever the server feels like, which made the
// dashboard bar chart and the two Reports tables reshuffle between requests
// for identical data. Statuses are sorted into lifecycle order (the same order
// as VALID_STATUSES) and types by descending count, then alphabetically.
const LIFECYCLE_ORDER = new Map([...VALID_STATUSES].map((status, index) => [status, index]));

const sortByStatus = (rows) =>
  [...rows].sort((a, b) => {
    const aIndex = LIFECYCLE_ORDER.has(a._id) ? LIFECYCLE_ORDER.get(a._id) : LIFECYCLE_ORDER.size;
    const bIndex = LIFECYCLE_ORDER.has(b._id) ? LIFECYCLE_ORDER.get(b._id) : LIFECYCLE_ORDER.size;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return String(a._id).localeCompare(String(b._id));
  });

const sortByCount = (rows) =>
  [...rows].sort((a, b) => (b.count - a.count) || String(a._id).localeCompare(String(b._id)));

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
      // Same population the renewal screen lists: Active and Approved
      // contracts inside a 30-day UTC calendar window. Counting only Active
      // contracts here made the dashboard's "Expiring soon" lower than the
      // renewal list it links to.
      Contract.countDocuments({
        endDate: expiringWindow(30),
        status: { $in: EXPIRING_STATUSES },
        isArchived: false
      }),
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
      statusBreakdown: sortByStatus(statusBreakdown),
      typeBreakdown: sortByCount(typeBreakdown)
    });
  } catch (error) {
    next(error);
  }
});

// Dashboard endpoint: single scoped aggregation available to every role so the
// values rendered on the Dashboard always match the Contracts page for the
// same user (Admin/Manager see the whole repository, Employees see only the
// contracts they created or are assigned to). `expiringSoon` uses the same
// window and status set as GET /renewals/expiring (see utils/dateWindow) so
// the figure agrees with the renewal screen it links to.
router.get('/dashboard', protect, async (req, res, next) => {
  try {
    const scope = isPrivileged(req.user) ? {} : employeeContractScope(req.user._id);
    const baseFilter = { isArchived: false, ...scope };

    const [facet, expiringSoon, recentContracts] = await Promise.all([
      Contract.aggregate([
        { $match: baseFilter },
        {
          $facet: {
            // Counted from the matched documents rather than summed from
            // statusCounts, so the dashboard total is identical to the
            // Contracts page total by construction. Summing the groups could
            // not drift on its own, but the two came from separate queries
            // and any future status bucket outside the lifecycle map would
            // have been counted twice rather than once.
            total: [{ $count: 'value' }],
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
      Contract.countDocuments({
        endDate: expiringWindow(30),
        status: { $in: EXPIRING_STATUSES },
        isArchived: false,
        ...scope
      }),
      Contract.find(baseFilter)
        // _id is the tiebreaker: contracts created inside the same
        // millisecond (a seed run, a bulk import) otherwise came back in an
        // arbitrary order, so "recent" was not reproducible.
        .sort({ createdAt: -1, _id: -1 })
        .limit(5)
        .select('contractNumber title status amount currency partyName type endDate')
    ]);

    const bucket = facet[0] || {};
    const statusCounts = bucket.statusCounts || [];
    const valueByCurrency = (bucket.valueByCurrency || []).map((item) => ({
      // A contract saved before `currency` existed has no value here, which
      // rendered as a blank label on the dashboard. Match the schema default.
      currency: item._id || 'USD',
      total: item.total,
      active: item.active
    }));

    const statusMap = new Map(statusCounts.map((item) => [item._id, item.count]));
    const total = (bucket.total || [])[0]?.value || 0;

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
      statusBreakdown: sortByStatus(statusCounts),
      valueByCurrency,
      recentContracts
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;