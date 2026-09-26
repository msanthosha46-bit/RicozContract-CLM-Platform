// Production stability and security regression tests. The Express app is
// mounted on an ephemeral port with no database connection started, so the
// health check, CORS policy, security headers and error handling are asserted
// exactly as they run in production. Uses only built-in modules, matching the
// rest of the suite.
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const createRateLimiter = require('../middleware/rateLimit');
const { protect } = require('../middleware/auth');
const { createApp, getAllowedOrigins, corsOriginDelegate, errorHandler, CORS_METHODS, CORS_ALLOWED_HEADERS } = require('../app');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_stability_test';
const JWT_SECRET = 'test-only-jwt-secret-not-for-production';
process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;

const ENV_KEYS = ['CLIENT_URL', 'NODE_ENV'];

const withEnv = async (env, fn) => {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const withServer = async (application, fn) => {
  const server = await new Promise((resolve) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseURL);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const call = async (baseURL, method, url, { body, headers = {}, raw } = {}) => {
  const response = await fetch(baseURL + url, {
    method,
    headers: raw ? headers : { 'content-type': 'application/json', ...headers },
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  return { status: response.status, headers: response.headers, body: data };
};

// ---------- rate limiter ----------

test('the limiter allows exactly max requests inside the window', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) {
    let code = 0;
    const res = {
      setHeader() {},
      status(value) { code = value; return this; },
      json() { return this; }
    };
    limiter({ ip: '10.0.0.1' }, res, () => outcomes.push('next'));
    if (code) outcomes.push(code);
  }
  assert.deepEqual(outcomes, ['next', 'next', 'next', 429, 429]);
});

test('the limiter isolates callers by the resolved key, not by a shared IP', () => {
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 1,
    keyResolver: (req) => (req.user && req.user._id) || null
  });
  const attempt = (req) => {
    let code = 0;
    const res = {
      setHeader() {},
      status(value) { code = value; return this; },
      json() { return this; }
    };
    limiter(req, res, () => {});
    return code || 'next';
  };

  assert.equal(attempt({ ip: '1.1.1.1', user: { _id: 'userA' } }), 'next');
  assert.equal(attempt({ ip: '1.1.1.1', user: { _id: 'userB' } }), 'next');
  assert.equal(attempt({ ip: '1.1.1.1', user: { _id: 'userA' } }), 429);
  // An unauthenticated request still falls back to the IP key.
  assert.equal(attempt({ ip: '1.1.1.1', user: null }), 'next');
});

test('a throwing key resolver falls back to the IP instead of crashing', () => {
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 5,
    keyResolver: () => { throw new Error('boom'); }
  });
  let code = 0;
  const res = { setHeader() {}, status(v) { code = v; return this; }, json() { return this; } };
  assert.doesNotThrow(() => limiter({ ip: '2.2.2.2' }, res, () => {}));
  assert.equal(code, 0);
});

test('a 429 response carries Retry-After and the configured message', () => {
  const limiter = createRateLimiter({ windowMs: 120000, max: 1, message: 'slow down' });
  const headers = {};
  const build = () => ({
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  });
  limiter({ ip: '3.3.3.3' }, build(), () => {});
  const second = build();
  limiter({ ip: '3.3.3.3' }, second, () => {});
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.message, 'slow down');
  assert.ok(Number(headers['Retry-After']) > 0);
});

// ---------- CORS ----------

test('allowed origins are parsed, trimmed and normalized', () => {
  const origins = withEnv({ CLIENT_URL: 'https://app.example.com/, https://admin.example.com ,' }, () =>
    getAllowedOrigins()
  );
  return origins.then((list) => {
    assert.deepEqual(list, ['https://app.example.com', 'https://admin.example.com']);
  });
});

const decide = (origin) => {
  let allowed;
  corsOriginDelegate(origin, (err, value) => { allowed = value; });
  return allowed;
};

test('an allow-listed origin is permitted, including with a trailing slash', async () => {
  await withEnv({ CLIENT_URL: 'https://app.example.com', NODE_ENV: 'production' }, () => {
    assert.equal(decide('https://app.example.com'), true);
    assert.equal(decide('https://app.example.com/'), true);
    assert.equal(decide('https://evil.example.com'), false);
  });
});

test('production without CLIENT_URL rejects every browser origin', async () => {
  await withEnv({ CLIENT_URL: undefined, NODE_ENV: 'production' }, () => {
    assert.equal(decide('https://evil.example.com'), false, 'the allow-list must fail closed');
  });
});

test('development without CLIENT_URL keeps the permissive behaviour', async () => {
  await withEnv({ CLIENT_URL: undefined, NODE_ENV: 'development' }, () => {
    assert.equal(decide('http://localhost:3000'), true);
  });
});

test('a request without an Origin header is not granted CORS headers', async () => {
  await withEnv({ CLIENT_URL: 'https://app.example.com' }, () => {
    assert.equal(decide(undefined), false);
  });
});

// ---------- Google sign-in preflight ----------

// The origin the Vercel deployment serves the SPA from. The API service's
// CLIENT_URL has to contain exactly this value: when it does not, the browser
// refuses the OPTIONS preflight for /api/auth/google because the response
// carries no Access-Control-Allow-Origin header, and Google sign-in fails
// before a token is ever sent.
const PRODUCTION_WEB_ORIGIN = 'https://ricoz-contract-clm-platform.vercel.app';

// A preflight carries no body, so it is issued with fetch directly rather than
// through call(), which assumes a JSON payload.
const preflight = (baseURL, origin, { method = 'POST', requestHeaders = 'content-type' } = {}) =>
  fetch(`${baseURL}/api/auth/google`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': requestHeaders
    }
  });

const allowHeaders = (res) =>
  (res.headers.get('access-control-allow-headers') || '')
    .split(',')
    .map((value) => value.trim().toLowerCase());

test('the Google sign-in preflight is answered with the production web origin', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await preflight(baseURL, PRODUCTION_WEB_ORIGIN);
      assert.equal(res.status, 204, 'a preflight is answered by the CORS layer, not by the route');
      assert.equal(res.headers.get('access-control-allow-origin'), PRODUCTION_WEB_ORIGIN);
      assert.match(res.headers.get('access-control-allow-methods') || '', /\bPOST\b/);
      // Without Vary: Origin a shared cache could hand one origin's approval to
      // another.
      assert.match(res.headers.get('vary') || '', /Origin/i);
    })
  );
});

test('the preflight allows the Content-Type header Google sign-in sends', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await preflight(baseURL, PRODUCTION_WEB_ORIGIN, { requestHeaders: 'content-type' });
      assert.ok(allowHeaders(res).includes('content-type'), 'JSON sign-in must not be blocked');
    })
  );
});

test('the preflight allows the Authorization header every authenticated call sends', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await preflight(baseURL, PRODUCTION_WEB_ORIGIN, { requestHeaders: 'content-type, authorization' });
      assert.ok(allowHeaders(res).includes('authorization'), 'a bearer token must not be blocked at the preflight');
    })
  );
});

test('the allowed header and method sets are exactly what the client sends', async () => {
  assert.deepEqual(CORS_ALLOWED_HEADERS, ['Content-Type', 'Authorization']);
  assert.ok(CORS_METHODS.includes('POST'));
  assert.ok(CORS_METHODS.includes('GET'));
  assert.ok(CORS_METHODS.includes('PUT'));
  assert.ok(CORS_METHODS.includes('PATCH'));
  assert.ok(CORS_METHODS.includes('DELETE'));
  assert.equal(CORS_METHODS.includes('TRACE'), false, 'TRACE is never required and stays off');
});

test('a preflight from an origin outside CLIENT_URL carries no CORS headers', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await preflight(baseURL, 'https://evil.example');
      assert.equal(res.headers.get('access-control-allow-origin'), null, 'the browser must refuse the response');
    })
  );
});

test('look-alike origins are refused', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () => {
    for (const origin of [
      'https://ricoz-contract-clm-platform.vercel.app.evil.example',
      'https://evilricoz-contract-clm-platform.vercel.app',
      'https://ricoz-contract-clm-platform.vercel.app.evil.example',
      'http://ricoz-contract-clm-platform.vercel.app',
      'https://ricoz-contract-clm-platform.vercel.app:8443',
      '*'
    ]) {
      assert.equal(decide(origin), false, `${origin} must not be permitted`);
    }
  });
});

test('the allow-list stays an exact match rather than a wildcard', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () => {
    assert.deepEqual(getAllowedOrigins(), [PRODUCTION_WEB_ORIGIN]);
    assert.equal(getAllowedOrigins().includes('*'), false);
  });
});

test('a preflight is answered before authentication and rate limiting', async () => {
  await withEnv({ CLIENT_URL: PRODUCTION_WEB_ORIGIN, NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      // More preflights than the Google sign-in limiter allows (20). A preflight
      // that reached the router would be rate limited long before this finished,
      // and it would still need no token to be answered.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const res = await preflight(baseURL, PRODUCTION_WEB_ORIGIN);
        assert.equal(res.status, 204);
      }
      const res = await call(baseURL, 'POST', '/api/auth/google', { body: { credential: 'not.a.token' } });
      assert.notEqual(res.status, 429, 'preflights must not consume rate-limit tokens');
      assert.equal(res.status, 401, 'a bogus Google token is rejected by the route');
    })
  );
});

// ---------- security headers ----------

test('responses carry the baseline hardening headers', async () => {
  await withEnv({ NODE_ENV: 'production' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await call(baseURL, 'GET', '/api/health');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(res.headers.get('strict-transport-security'), 'HSTS is expected in production');
    })
  );
});

test('HSTS is not sent outside production so local http keeps working', async () => {
  await withEnv({ NODE_ENV: 'development' }, () =>
    withServer(createApp(), async (baseURL) => {
      const res = await call(baseURL, 'GET', '/api/health');
      assert.equal(res.headers.get('strict-transport-security'), null);
    })
  );
});

test('the framework fingerprint header is not advertised', async () => {
  await withServer(createApp(), async (baseURL) => {
    const res = await call(baseURL, 'GET', '/api/health');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

// ---------- health check ----------

test('health reports ok while the database is connected', async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });
  try {
    await withServer(createApp(), async (baseURL) => {
      const res = await call(baseURL, 'GET', '/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.database, 'connected');
      assert.equal(res.body.service, 'ricoz-contract-server');
      assert.equal(typeof res.body.uptimeSeconds, 'number');
    });
  } finally {
    await mongoose.disconnect();
  }
});

test('health returns 503 when the database is not connected', async () => {
  // Swap in a disconnected readyState without permanently changing the
  // property, so mongoose can still assign to it later in the process.
  const original = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', {
    value: 0,
    writable: true,
    configurable: true,
    enumerable: true
  });
  try {
    await withServer(createApp(), async (baseURL) => {
      const res = await call(baseURL, 'GET', '/api/health');
      assert.equal(res.status, 503, 'a platform health check must fail when the database is gone');
      assert.equal(res.body.status, 'degraded');
      assert.equal(res.body.database, 'disconnected');
    });
  } finally {
    delete mongoose.connection.readyState;
    if (original) Object.defineProperty(mongoose.connection, 'readyState', original);
  }
});

test('the health response is unauthenticated so a platform can reach it', async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });
  try {
    await withServer(createApp(), async (baseURL) => {
      const res = await call(baseURL, 'GET', '/api/health');
      assert.equal(res.status, 200, 'no Authorization header is sent here');
    });
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- routing and error handling ----------

test('an unknown API route returns a JSON 404', async () => {
  await withServer(createApp(), async (baseURL) => {
    const res = await call(baseURL, 'GET', '/api/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'API route not found');
  });
});

test('malformed JSON is rejected with 400 and no parser detail', async () => {
  await withServer(createApp(), async (baseURL) => {
    const res = await call(baseURL, 'POST', '/api/auth/login', {
      raw: '{"email": broken',
      headers: { 'content-type': 'application/json' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Invalid JSON payload');
  });
});

test('an unexpected failure returns a generic 500 and never leaks the cause', () => {
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);

  let sent;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { sent = body; return this; }
  };
  const error = new Error('mongodb://user:hunter2@cluster.internal/admin failed');
  error.sensitiveDetail = 'super-secret-token';

  try {
    errorHandler(error, { method: 'GET', path: '/boom' }, res, () => {});
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 500);
  assert.deepEqual(sent, { message: 'Internal server error' });
  assert.ok(!JSON.stringify(sent).includes('hunter2'));
  assert.ok(!JSON.stringify(sent).includes('super-secret-token'));

  // The log entry is curated: it keeps the diagnostic fields but must not
  // serialise arbitrary properties hung off the error object.
  const logged = logs
    .filter((args) => args[0] === 'Unhandled server error')
    .map((args) => args[1])[0];
  assert.ok(logged, 'the failure must still be logged');
  assert.equal(logged.sensitiveDetail, undefined, 'arbitrary error properties must not be logged');
  assert.equal(logged.message, error.message);
  assert.equal(logged.method, 'GET');
  assert.equal(logged.path, '/boom');
});

test('the error handler still maps the known client errors', () => {
  const send = (error) => {
    let sent;
    let code;
    const res = {
      status(value) { code = value; return this; },
      json(body) { sent = body; return this; }
    };
    errorHandler(error, { method: 'GET', path: '/x' }, res, () => {});
    return { code, sent };
  };

  const tooLarge = new Error('File too large');
  tooLarge.name = 'MulterError';
  tooLarge.code = 'LIMIT_FILE_SIZE';
  assert.equal(send(tooLarge).code, 413);

  const duplicate = new Error('E11000 duplicate key');
  duplicate.code = 11000;
  assert.equal(send(duplicate).code, 409);

  const badCast = new Error('Cast to ObjectId failed');
  badCast.name = 'CastError';
  badCast.path = '_id';
  assert.equal(send(badCast).code, 400);
});

// ---------- authentication ----------

test('a token signed with alg:none is refused', async () => {
  const noneToken = jwt.sign({ id: '507f1f77bcf86cd799439011' }, '', { algorithm: 'none' });
  const harness = express();
  harness.get('/x', protect, (req, res) => res.json({ ok: true }));

  await withServer(harness, async (baseURL) => {
    const res = await call(baseURL, 'GET', '/x', { headers: { authorization: `Bearer ${noneToken}` } });
    assert.equal(res.status, 401, 'alg:none must never be accepted');
  });
});

test('a missing or malformed Authorization header is refused', async () => {
  const harness = express();
  harness.get('/x', protect, (req, res) => res.json({ ok: true }));

  await withServer(harness, async (baseURL) => {
    assert.equal((await call(baseURL, 'GET', '/x')).status, 401);
    assert.equal((await call(baseURL, 'GET', '/x', { headers: { authorization: 'Token abc' } })).status, 401);
    assert.equal((await call(baseURL, 'GET', '/x', { headers: { authorization: 'Bearer not-a-jwt' } })).status, 401);
  });
});

test('a database failure during authentication is a 500, not a 401', async () => {
  const User = require('../models/User');
  const original = User.findById;
  User.findById = () => ({ select: () => Promise.reject(new Error('connection lost')) });

  const validToken = jwt.sign({ id: '507f1f77bcf86cd799439011' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const harness = express();
  harness.get('/x', protect, (req, res) => res.json({ ok: true }));
  // Absorb the failure here so the suite output stays clean; the assertion
  // below is about the status code reaching the client.
  harness.use((error, req, res, next) => res.status(500).json({ message: 'Internal server error' }));
  const originalError = console.error;
  console.error = () => {};

  try {
    await withServer(harness, async (baseURL) => {
      const res = await call(baseURL, 'GET', '/x', { headers: { authorization: `Bearer ${validToken}` } });
      assert.equal(res.status, 500, 'an outage must not be reported as an authentication failure');
    });
  } finally {
    User.findById = original;
    console.error = originalError;
  }
});

test('the public auth endpoints are all throttled', () => {
  const authRoutes = require('../routes/authRoutes');
  const routes = new Map();
  for (const layer of authRoutes.stack) {
    if (layer.route) routes.set(layer.route.path, layer.route.stack.map((l) => l.name));
  }
  for (const path of ['/register', '/login', '/google', '/forgot-password', '/reset-password']) {
    assert.ok(routes.has(path), `${path} route is missing`);
    assert.ok(
      routes.get(path).includes('rateLimit'),
      `${path} has no rate limiter (found: ${routes.get(path).join(', ')})`
    );
  }
});

test('the document upload route stays protected and is now throttled', () => {
  const documentRoutes = require('../routes/documentRoutes');
  const layer = documentRoutes.stack.find((l) => l.route && l.route.path === '/upload/:contractId');
  assert.ok(layer, 'the upload route is missing');
  const names = layer.route.stack.map((l) => l.name);
  assert.ok(names.includes('protect'), 'upload must require authentication');
  assert.ok(names.includes('rateLimit'), `upload must be rate limited (found: ${names.join(', ')})`);
  assert.ok(
    names.indexOf('protect') < names.indexOf('rateLimit'),
    'the limiter must run after authentication so it can key on the user'
  );
});
