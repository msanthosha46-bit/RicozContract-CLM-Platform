const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');
const { canAccessContract, employeeContractScope } = require('../utils/access');
const { canTransition, VALID_STATUSES } = require('../utils/contractTransitions');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nextContractNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `CNT-${year}-`;
  const latest = await Contract.findOne({ contractNumber: new RegExp(`^${prefix}`) })
    .sort({ contractNumber: -1 })
    .select('contractNumber');

  let seq = 1;
  if (latest?.contractNumber) {
    const parsed = Number(latest.contractNumber.slice(prefix.length));
    if (!Number.isNaN(parsed)) seq = parsed + 1;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const contractNumber = `${prefix}${String(seq + attempt).padStart(4, '0')}`;
    const exists = await Contract.exists({ contractNumber });
    if (!exists) return contractNumber;
  }

  return `${prefix}${Date.now().toString().slice(-8)}`;
};

const buildListQuery = (req) => {
  const { search, status, type } = req.query;
  const filters = [{ isArchived: false }];

  if (req.user.role === 'Employee') {
    filters.push(employeeContractScope(req.user._id));
  }

  if (search) {
    const safe = escapeRegExp(String(search).slice(0, 100));
    filters.push({
      $or: [
        { title: { $regex: safe, $options: 'i' } },
        { contractNumber: { $regex: safe, $options: 'i' } },
        { partyName: { $regex: safe, $options: 'i' } }
      ]
    });
  }

  if (status) filters.push({ status });
  if (type) filters.push({ type });

  return filters.length === 1 ? filters[0] : { $and: filters };
};

router.get('/', protect, async (req, res, next) => {
  try {
    if (req.query.status && !VALID_STATUSES.has(req.query.status)) {
      return res.status(400).json({ message: 'Invalid status filter value' });
    }

    const query = buildListQuery(req);
    let contracts = Contract.find(query).populate('createdBy', 'name email').populate('assignedUser', 'name email');
    if (req.query.sort === 'oldest') contracts = contracts.sort({ createdAt: 1 });
    else contracts = contracts.sort({ createdAt: -1 });

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 0;
    if (req.query.page !== undefined && (!Number.isInteger(page) || page < 1)) {
      return res.status(400).json({ message: 'Invalid page value' });
    }
    if (req.query.limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return res.status(400).json({ message: 'Invalid limit value (must be 1-100)' });
    }

    if (req.query.fields) {
      const fields = String(req.query.fields).split(',').map((field) => field.trim()).filter(Boolean);
      if (fields.length) contracts = contracts.select(fields.join(' '));
    }

    if (limit) {
      const total = await Contract.countDocuments(query);
      const result = await contracts.skip((page - 1) * limit).limit(limit);
      res.json({ contracts: result, total, page, totalPages: Math.ceil(total / limit) });
    } else {
      const result = await contracts;
      res.json(result);
    }
  } catch (error) {
    next(error);
  }
});

router.post('/', protect, async (req, res, next) => {
  try {
    const contractNumber = await nextContractNumber();

    const contract = await Contract.create({
      title: req.body.title,
      type: req.body.type,
      partyName: req.body.partyName,
      description: req.body.description,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      amount: req.body.amount,
      currency: req.body.currency,
      assignedUser: req.body.assignedUser,
      contractNumber,
      createdBy: req.user._id,
      status: 'Draft'
    });

    await logActivity(req.user._id, 'Contract Created', contract._id, `Created contract ${contract.contractNumber}`);
    res.status(201).json(contract);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', protect, async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignedUser', 'name email');
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }
    res.json(contract);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', protect, async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!canAccessContract(req.user, contract)) {
      return res.status(403).json({ message: 'You do not have access to this contract' });
    }

    const isManagerial = ['Admin', 'Manager'].includes(req.user.role);

    if (!isManagerial && req.body.status !== undefined) {
      return res.status(403).json({ message: 'Only administrators and managers can change contract status' });
    }

    if (req.body.status !== undefined) {
      if (!VALID_STATUSES.has(req.body.status)) {
        return res.status(400).json({ message: 'Invalid contract status' });
      }
      if (req.body.status !== contract.status && !canTransition(contract.status, req.body.status)) {
        return res.status(400).json({ message: `Contract status cannot change from '${contract.status}' to '${req.body.status}'` });
      }
    }

    const nextStart = req.body.startDate !== undefined ? new Date(req.body.startDate) : contract.startDate;
    const nextEnd = req.body.endDate !== undefined ? new Date(req.body.endDate) : contract.endDate;
    if (Number.isNaN(nextStart.getTime()) || Number.isNaN(nextEnd.getTime())) {
      return res.status(400).json({ message: 'A valid start date and end date are required' });
    }
    if (nextEnd < nextStart) {
      return res.status(400).json({ message: 'The end date must be on or after the start date' });
    }

    let amount = contract.amount;
    if (req.body.amount !== undefined) {
      amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ message: 'Amount must be a non-negative number' });
      }
    }

    const updates = {};
    const allowed = ['title', 'type', 'partyName', 'description', 'currency', 'assignedUser'];
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });
    if (req.body.startDate !== undefined) updates.startDate = nextStart;
    if (req.body.endDate !== undefined) updates.endDate = nextEnd;
    if (req.body.amount !== undefined) updates.amount = amount;
    if (req.body.status !== undefined && isManagerial) updates.status = req.body.status;

    Object.assign(contract, updates);
    await contract.save();

    await logActivity(req.user._id, 'Contract Updated', contract._id, `Updated details for ${contract.contractNumber}`);
    res.json(contract);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/archive', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    contract.isArchived = true;
    await contract.save();

    await logActivity(req.user._id, 'Contract Archived', contract._id, `Archived contract ${contract.contractNumber}`);
    res.json({ message: 'Contract archived successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
