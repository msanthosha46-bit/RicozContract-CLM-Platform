// userRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

router.get('/', protect, authorize('Admin'), async (req, res) => {
  const users = await User.find({}).select('-password');
  res.json(users);
});

router.put('/:id/role', protect, authorize('Admin'), async (req, res) => {
  const { role, status } = req.body;
  const user = await User.findById(req.params.id);
  if (user) {
    user.role = role || user.role;
    user.status = status || user.status;
    await user.save();
    res.json({ message: 'User updated successfully' });
  } else {
    res.status(404).json({ message: 'User not found' });
  }
});

module.exports = router;