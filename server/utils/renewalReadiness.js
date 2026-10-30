let renewalOperationsReady = false;

const setRenewalOperationsReady = (ready) => {
  renewalOperationsReady = ready === true;
  return renewalOperationsReady;
};

const areRenewalOperationsReady = () => renewalOperationsReady;

const requireRenewalOperationsReady = (req, res, next) => {
  if (!renewalOperationsReady) {
    return res.status(503).json({
      message: 'Renewal operations are temporarily unavailable until required database indexes are verified.',
      code: 'RENEWAL_INDEXES_NOT_READY'
    });
  }
  return next();
};

module.exports = {
  setRenewalOperationsReady,
  areRenewalOperationsReady,
  requireRenewalOperationsReady
};
