const express = require('express');
const router = express.Router();
const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const { protect, authorize } = require('../middleware/auth');
const logActivity = require('../utils/activityLogger');

// Get all contracts with search & filter
router.get('/', protect, async (req, res) => {
  try {
    const { search, status, type, sort } = req.query;
    let query = { isArchived: false };

    // Role filtering: Employee can only see assigned or created contracts
    if (req.user.role === 'Employee') {
      query.$or = [{ createdBy: req.user._id }, { assignedUser: req.user._id }];
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { contractNumber: { $regex: search, $options: 'i' } },
        { partyName: { $regex: search, $options: 'i' } }
      ];
    }

    if (status) query.status = status;
    if (type) query.type = type;

    let contracts = Contract.find(query).populate('createdBy', 'name email').populate('assignedUser', 'name email');
    if (sort === 'oldest') contracts = contracts.sort({ createdAt: 1 });
    else contracts = contracts.sort({ createdAt: -1 });

    const result = await contracts;
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create Contract
router.post('/', protect, async (req, res) => {
  try {
    const contractCount = await Contract.countDocuments();
    const contractNumber = `CNT-${new Date().getFullYear()}-${String(contractCount + 1).padStart(4, '0')}`;

    const contract = await Contract.create({
      ...req.body,
      contractNumber,
      createdBy: req.user._id
    });

    await logActivity(req.user._id, 'Contract Created', contract._id, `Created contract ${contract.contractNumber}`);
    res.status(201).json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get Single Contract
router.get('/:id', protect, async (req, res) => {
  try {
    const contract = await Contract.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('assignedUser', 'name email');
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    res.json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update Contract
router.put('/:id', protect, async (req, res) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    Object.assign(contract, req.body);
    await contract.save();

    await logActivity(req.user._id, 'Contract Updated', contract._id, `Updated details for ${contract.contractNumber}`);
    res.json(contract);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Archive Contract
router.patch('/:id/archive', protect, authorize('Admin'), async (req, res) => {
  try {
    const contract = await Contract.findById(req.params.id);
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    contract.isArchived = true;
    await contract.save();

    await logActivity(req.user._id, 'Contract Archived', contract._id, `Archived contract ${contract.contractNumber}`);
    res.json({ message: 'Contract archived successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;