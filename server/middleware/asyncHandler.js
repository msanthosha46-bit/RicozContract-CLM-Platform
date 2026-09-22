// Wraps an async route handler so rejections are forwarded to Express'
// central error handler instead of becoming unhandled rejections.
const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

module.exports = asyncHandler;
