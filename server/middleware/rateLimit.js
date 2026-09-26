// Lightweight in-memory fixed-window rate limiter.
// The project has no rate-limiting dependency, so this provides a small,
// dependency-free protection suitable for the auth endpoints.
// Note: state is per-process. Behind a load balancer or on serverless,
// each instance keeps its own counters.

const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 5,
  message = 'Too many requests. Please try again later.',
  // Optional per-caller key (for example the authenticated user id) so one
  // noisy tenant cannot exhaust the allowance of everyone behind the same IP.
  keyResolver = null
} = {}) => {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now - entry.start >= windowMs) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  // Named so the middleware is identifiable in stack traces and route stacks.
  return function rateLimit(req, res, next) {
    let key;
    if (typeof keyResolver === 'function') {
      try {
        key = keyResolver(req);
      } catch (error) {
        key = null;
      }
    }
    if (!key) {
      key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    }
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ message });
    }
    return next();
  };
};

module.exports = createRateLimiter;
