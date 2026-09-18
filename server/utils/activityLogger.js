const ActivityLog = require('../models/ActivityLog');

const logActivity = async (userId, action, contractId = null, details = '') => {
  try {
    await ActivityLog.create({
      user: userId,
      contract: contractId,
      action,
      details
    });
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
};

module.exports = logActivity;