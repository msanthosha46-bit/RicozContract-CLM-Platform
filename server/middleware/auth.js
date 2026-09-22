const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password');
      if (!req.user || req.user.status === 'Inactive') {
        return res.status(401).json({ message: 'Unauthorized access or user inactive.' });
      }
      // Revoke sessions issued before a password reset. Tokens minted before
      // token versioning existed have no claim and count as version 0.
      if ((decoded.tokenVersion || 0) !== (req.user.tokenVersion || 0)) {
        return res.status(401).json({ message: 'Session expired. Please sign in again.' });
      }
      next();
    } catch (error) {
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  } else {
    return res.status(401).json({ message: 'Not authorized, no token provided' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Role '${req.user.role}' is not authorized to perform this action` });
    }
    next();
  };
};

module.exports = { protect, authorize };