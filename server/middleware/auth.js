const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    let decoded;
    try {
      token = req.headers.authorization.split(' ')[1];
      // Pin the algorithm so a token can never select a different family.
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }

    // Lookup failures are server-side problems, not authentication problems, so
    // they are passed to the central handler instead of being reported as 401.
    try {
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
      next(error);
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