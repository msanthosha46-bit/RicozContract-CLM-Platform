const ActivityLog = require('../models/ActivityLog');

// `extra` carries the optional structured fields of an entry: the recipient of a
// reassignment (`targetUser`), the assignee it was taken from (`previousUser`).
// It is merged into the stored document, so a caller can only ever add fields
// the schema declares.
const logActivity = async (userId, action, contractId = null, details = '', extra = {}) => {
  try {
    const entry = {
      user: userId,
      contract: contractId,
      action,
      details,
      ...extra
    };
    if (extra.operationId && contractId) {
      await ActivityLog.findOneAndUpdate(
        { operationId: extra.operationId },
        { $setOnInsert: entry },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      await ActivityLog.create(entry);
    }
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
};

module.exports = logActivity;
