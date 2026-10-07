const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { USER_ROLES, USER_STATUSES } = User;
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { validatePassword } = require('../utils/passwordReset');

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
      const passwordError = validatePassword(req.body.newPassword);
      if (passwordError) {
        return res.status(400).json({ message: passwordError });
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
  const users = await User.find({}).select('name email role department status preferences createdAt');
  res.json(users);
}));

// Validates one closed value set from the request body.
//
// A mongoose `enum` is not sufficient on its own here, and this was a live
// hole: an enum only rejects a value that is present and not in the list, while
// `null` and `undefined` pass straight through it. Neither field is `required`,
// so `PUT /api/users/:id/role {"role": null}` saved a user whose role was null
// and answered 200. A null role then failed open through every scope predicate
// that asked "is this an Employee?", which handed that account the entire
// contract list, the whole dashboard, every obligation and milestone, and write
// access to all of them - while `canAccessContract` refused the same user on
// `GET /contracts/:id`. The type check closes the hole at the edge, so the
// invalid value is never stored; `typeof` alone rejects null, numbers, booleans
// and objects, and the list check rejects anything outside the schema.
const readEnumValue = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { error: `Role and status must be one of: ${label.join(', ')}` };
  }
  return { value };
};

router.put('/:id/role', protect, authorize('Admin'), asyncHandler(async (req, res) => {
  const { role, status } = req.body;

  if (role !== undefined) {
    const parsed = readEnumValue(role, USER_ROLES, USER_ROLES);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
  }
  if (status !== undefined) {
    const parsed = readEnumValue(status, USER_STATUSES, USER_STATUSES);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  // Guard the last active administrator. The two clauses are grouped
  // explicitly: `role !== undefined && role !== 'Admin'` (demotion) OR
  // `status === 'Inactive'` (deactivation). Written without the inner
  // parentheses the intent depends entirely on operator precedence and is easy
  // to "fix" into a different rule by accident.
  const demotes = role !== undefined && role !== 'Admin';
  const deactivates = status === 'Inactive';
  if (user.role === 'Admin' && (demotes || deactivates)) {
    const openAdminSlots = await User.countDocuments({
      role: 'Admin',
      status: 'Active',
      _id: { $ne: user._id }
    });
    if (openAdminSlots === 0) {
      return res.status(400).json({ message: 'Cannot demote or deactivate the only active administrator' });
    }
  }

  if (role !== undefined) user.role = role;
  if (status !== undefined) user.status = status;
  await user.save();
  res.json({ message: 'User updated successfully', user: publicUser(user) });
}));

module.exports = router;
