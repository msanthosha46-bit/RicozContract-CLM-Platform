const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  department: user.department,
  status: user.status,
  preferences: user.preferences
});

router.get('/me', protect, async (req, res) => {
  res.json(publicUser(req.user));
});

router.put('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.body.name) user.name = req.body.name;
    if (req.body.department !== undefined) user.department = req.body.department;
    if (req.body.preferences && typeof req.body.preferences === 'object') {
      user.preferences = { ...user.preferences.toObject?.() || user.preferences, ...req.body.preferences };
    }

    if (req.body.newPassword) {
      if (!req.body.currentPassword || !(await user.matchPassword(req.body.currentPassword))) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }
      if (req.body.newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters' });
      }
      user.password = req.body.newPassword;
    }

    await user.save();
    res.json(publicUser(user));
  } catch (error) {
    next(error);
  }
});

router.get('/directory', protect, authorize('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const users = await User.find({ status: 'Active' }).select('name email role department');
  res.json(users);
}));

router.get('/', protect, authorize('Admin'), asyncHandler(async (req, res) => {
  const users = await User.find({}).select('-password');
  res.json(users);
}));

router.put('/:id/role', protect, authorize('Admin'), asyncHandler(async (req, res) => {
  const { role, status } = req.body;
  const user = await User.findById(req.params.id);
  if (user) {
    if (role) user.role = role;
    if (status) user.status = status;
    await user.save();
    res.json({ message: 'User updated successfully', user: publicUser(user) });
  } else {
    res.status(404).json({ message: 'User not found' });
  }
}));

module.exports = router;
