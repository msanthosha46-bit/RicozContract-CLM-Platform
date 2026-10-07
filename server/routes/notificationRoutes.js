const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const ContractAmendment = require('../models/ContractAmendment');
const { protect } = require('../middleware/auth');
const { employeeContractScope, isPrivileged } = require('../utils/access');
const { expiringWindow, formatUtcDate } = require('../utils/dateWindow');

router.get('/', protect, async (req, res, next) => {
  try {
    const items = [];

    // The same UTC calendar-day window reports and renewals use. Local-time
    // `setDate` arithmetic here would silently drop contracts expiring today
    // and shift the boundary by the server's offset, so this feed could
    // disagree with the renewal list it points at.
    const window = expiringWindow(30);

    // Scoped unless the user is in the privileged allow-list, so the feed can
    // never disclose a contract the same user is refused by GET /contracts/:id.
    const scoped = !isPrivileged(req.user);

    const contractQuery = scoped
      ? { isArchived: false, ...employeeContractScope(req.user._id), endDate: window, status: { $in: ['Active', 'Approved'] } }
      : { isArchived: false, endDate: window, status: { $in: ['Active', 'Approved'] } };

    const expiring = await Contract.find(contractQuery).select('title contractNumber endDate').limit(8);
    expiring.forEach((contract) => {
      items.push({
        id: `expiring-${contract._id}`,
        type: 'expiry',
        title: `${contract.contractNumber} expires soon`,
        // UTC, because the contract was selected by a UTC window: formatting
        // the same instant with a bare toLocaleDateString() rendered it in the
        // host timezone and announced the wrong day on any server behind UTC.
        detail: `${contract.title} · ${formatUtcDate(contract.endDate)}`,
        href: `/contracts/${contract._id}`
      });
    });

    const obligationQuery = scoped
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

    const milestoneQuery = scoped
      ? { assignedTo: req.user._id, status: 'Overdue' }
      : { status: 'Overdue' };
    const overdueMilestones = await Milestone.find(milestoneQuery).populate('contract', 'contractNumber').limit(8);
    overdueMilestones.forEach((item) => {
      items.push({
        id: `milestone-${item._id}`,
        type: 'overdue',
        title: `Overdue: ${item.title}`,
        detail: item.contract?.contractNumber || 'Milestone',
        href: '/milestones'
      });
    });

    if (isPrivileged(req.user)) {
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

      // The amendment queue is gated authorize('Admin','Manager') on the write
      // side, exactly like the approval queue, so only a privileged user is
      // told there is something to decide. Same derived-feed approach and the
      // same `limit(8)` cap per source: nothing is persisted, and the id is the
      // amendment's own _id, so it is stable across requests and unique per
      // source (`amendment-` never collides with `approval-`).
      //
      // Only Pending requests are listed. A decided amendment is no longer
      // actionable, so re-announcing it would leave a permanent unread badge
      // with no queue row behind it.
      const amendments = await ContractAmendment.find({ status: 'Pending' })
        .populate('contract', 'contractNumber')
        .populate('requestedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(8);
      amendments.forEach((amendment) => {
        items.push({
          id: `amendment-${amendment._id}`,
          type: 'amendment',
          title: 'Amendment awaiting decision',
          // Who asked, and for which contract. No proposed values: this string
          // is rendered in a 20rem panel and the values belong on the queue.
          detail: `${amendment.contract?.contractNumber || 'Contract'}${amendment.requestedBy?.name ? ` · ${amendment.requestedBy.name}` : ''}`,
          // Straight to the row for this request, not just the top of the queue.
          href: `/amendments?focus=${amendment._id}`
        });
      });
    }

    // An amendment the current user raised is worth telling them about once it
    // has been decided, and only to them - this is the requester's own outcome,
    // and no other role is watching a request they did not make. Read off the
    // same documents, so there is still no stored notification.
    const decidedMine = await ContractAmendment.find({
      requestedBy: req.user._id,
      status: { $in: ['Approved', 'Rejected'] }
    })
      .populate('contract', 'contractNumber')
      .populate('decidedBy', 'name')
      .sort({ decidedAt: -1 })
      .limit(5);
    decidedMine.forEach((amendment) => {
      items.push({
        id: `amendment-decision-${amendment._id}`,
        type: 'amendment-decision',
        title: `Amendment ${amendment.status.toLowerCase()}`,
        detail: `${amendment.contract?.contractNumber || 'Contract'}${amendment.decidedBy?.name ? ` · by ${amendment.decidedBy.name}` : ''}`,
        href: `/contracts/${amendment.contract?._id || ''}`
      });
    });

    // The feed is deliberately capped per source (8 each) but is otherwise
    // returned in full. Truncating the combined list at an arbitrary 12 left
    // `count` above `items.length`, so the client's unread badge (derived from
    // the items it received) under-reported and some unread notifications were
    // never visible and never marked seen. Because the per-source caps already
    // bound the response, sending everything keeps count and items consistent
    // and every unread item reachable.
    res.json({ count: items.length, items });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
