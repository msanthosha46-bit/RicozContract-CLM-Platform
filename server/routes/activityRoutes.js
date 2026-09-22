// activityRoutes.js
const expressAct = require('express');
const routerAct = expressAct.Router();
const ActivityLog = require('../models/ActivityLog');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

routerAct.get('/', protect, authorize('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const logs = await ActivityLog.find()
    .populate('user', 'name email')
    .populate('contract', 'title contractNumber')
    .sort({ createdAt: -1 })
    .limit(50);
  res.json(logs);
}));

module.exports = routerAct;