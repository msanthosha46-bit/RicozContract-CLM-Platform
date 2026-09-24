const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const Obligation = require('../models/Obligation');
const { protect } = require('../middleware/auth');
const { employeeContractScope } = require('../utils/access');

router.get('/', protect, async (req, res, next) => {
  try {
    const items = [];
    const now = new Date();
    const in30Days = new Date();
    in30Days.setDate(now.getDate() + 30);

    const contractQuery = req.user.role === 'Employee'
      ? { isArchived: false, ...employeeContractScope(req.user._id), endDate: { $gte: now, $lte: in30Days }, status: { $in: ['Active', 'Approved'] } }
      : { isArchived: false, endDate: { $gte: now, $lte: in30Days }, status: { $in: ['Active', 'Approved'] } };

    const expiring = await Contract.find(contractQuery).select('title contractNumber endDate').limit(8);
    expiring.forEach((contract) => {
      items.push({
        id: `expiring-${contract._id}`,
        type: 'expiry',
        title: `${contract.contractNumber} expires soon`,
        detail: `${contract.title} · ${new Date(contract.endDate).toLocaleDateString()}`,
        href: `/contracts/${contract._id}`
      });
    });

    const obligationQuery = req.user.role === 'Employee'
      ? { assignedTo: req.user._id, status: 'Overdue' }
      : { status: 'Overdue' };
    const overdue = await Obligation.find(obligationQuery).populate('contract', 'contractNumber').limit(8);
    overdue.forEach((item) => {
      items.push({
        id: `obligation-${item._id}`,
        type: 'overdue',
        title: `Overdue: ${item.title}`,
        detail: item.contract?.contractNumber || 'Obligation',
        href: '/obligations'
      });
    });

    if (['Admin', 'Manager'].includes(req.user.role)) {
      const pending = await Approval.find({ status: 'Pending' }).populate('contract', 'title contractNumber').limit(8);
      pending.forEach((approval) => {
        items.push({
          id: `approval-${approval._id}`,
          type: 'approval',
          title: 'Approval waiting',
          detail: approval.contract?.contractNumber || approval.contract?.title || 'Contract',
          href: '/approvals'
        });
      });
    }

    res.json({ count: items.length, items: items.slice(0, 12) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
