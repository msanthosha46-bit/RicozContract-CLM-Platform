const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// Builds the Express application without starting it: no database connection,
// no timers and no process signals. server.js owns the lifecycle, so the
// middleware stack below can be mounted directly in tests.

const getAllowedOrigins = () =>
  (process.env.CLIENT_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const isProduction = () => process.env.NODE_ENV === 'production';

// Google sign-in posts JSON, and every authenticated request carries a bearer
// token (see client/src/services/api.js), so a browser preflight asks for both
// headers. They are listed explicitly rather than reflected from the request so
// the required set stays auditable: dropping Authorization here would break
// every protected endpoint at the preflight stage while login kept working.
const CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization'];

// Decides per request which origins may talk to the API.
// Origins are read on each call so a configuration change never needs a rebuild,
// and a missing CLIENT_URL fails closed in production instead of reflecting
// every caller's origin.
const corsOriginDelegate = (origin, callback) => {
  // A request without an Origin header is not a cross-origin request
  // (same-origin navigation, curl, or a server-to-server call).
  if (!origin) return callback(null, false);

  const normalized = origin.replace(/\/+$/, '');
  if (getAllowedOrigins().includes(normalized)) return callback(null, true);

  if (!getAllowedOrigins().length && !isProduction()) return callback(null, true);

  return callback(null, false);
};

// Baseline hardening headers. The API only ever returns JSON, so no CSP is
// needed, but the cheap protections below are still worth setting.
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.removeHeader('X-Powered-By');
  if (isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
};

// Health is reported from the real connection state so a platform health check
// restarts an instance whose database has gone away, instead of being told
// everything is fine by a process that can no longer serve a single query.
const healthHandler = (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'degraded',
    service: 'ricoz-contract-server',
    database: connected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.round(process.uptime())
  });
};

const createApp = () => {
  const app = express();

  // Render sits behind a reverse proxy; trust the first hop so req.ip (used by
  // rate limiting) reflects the client instead of the proxy address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  // CORS must stay mounted above every router. The cors package answers a
  // browser preflight itself and ends the response, so an OPTIONS never reaches
  // express.json, a rate limiter or the `protect` middleware, and a preflight
  // can never consume a rate-limit token. The origin allow-list is still
  // enforced per request by corsOriginDelegate.
  app.use(
    cors({
      origin: corsOriginDelegate,
      methods: CORS_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
      // Authentication is a bearer token, never a cookie, so credentials are
      // never attached and a wildcard origin is never needed.
      credentials: false,
      maxAge: 600,
      optionsSuccessStatus: 204
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', healthHandler);

  app.use('/api/auth', require('./routes/authRoutes'));
  app.use('/api/users', require('./routes/userRoutes'));
  app.use('/api/contracts', require('./routes/contractRoutes'));
  app.use('/api/approvals', require('./routes/approvalRoutes'));
  app.use('/api/obligations', require('./routes/obligationRoutes'));
  app.use('/api/milestones', require('./routes/milestoneRoutes'));
  app.use('/api/documents', require('./routes/documentRoutes'));
  app.use('/api/renewals', require('./routes/renewalRoutes'));
  app.use('/api/reports', require('./routes/reportRoutes'));
  app.use('/api/activities', require('./routes/activityRoutes'));
  app.use('/api/notifications', require('./routes/notificationRoutes'));

  app.use((req, res) => {
    res.status(404).json({ message: 'API route not found' });
  });

  app.use(errorHandler);

  return app;
};

// Central error handler: map known errors to correct status codes and never
// expose raw internal error messages to clients.
function errorHandler(error, req, res, next) {
  if (error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'File exceeds the 10 MiB upload limit.' });
  }
  if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
    return res.status(400).json({ message: error.message });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ message: 'Invalid JSON payload' });
  }
  if (error.status >= 400 && error.status < 500 && error.expose) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error.name === 'ValidationError') {
    const details = Object.values(error.errors || {}).map((detail) => detail.message);
    return res.status(400).json({ message: 'Validation failed', details });
  }
  if (error.name === 'CastError') {
    return res.status(400).json({ message: `Invalid value for '${error.path}'` });
  }
  if (error.code === 11000) {
    return res.status(409).json({ message: 'A record with the same unique value already exists' });
  }

  // Log a curated summary rather than the raw error object: some libraries
  // attach request details and upstream payloads to the error, which must
  // never reach the log sink wholesale.
  console.error('Unhandled server error', {
    method: req.method,
    path: req.path,
    name: error.name,
    code: error.code,
    status: error.status,
    message: error.message,
    stack: error.stack
  });
  return res.status(500).json({ message: 'Internal server error' });
}

module.exports = {
  createApp,
  getAllowedOrigins,
  corsOriginDelegate,
  healthHandler,
  isProduction,
  errorHandler,
  CORS_METHODS,
  CORS_ALLOWED_HEADERS
};
