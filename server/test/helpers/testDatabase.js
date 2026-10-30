// Shared test database validation. Connection-producing focused suites must use
// readFocusedTestConfig(), which requires an explicit loopback replica-set URI,
// test JWT secret, and creates a fresh database name for that suite invocation.
// This module never reads the application's MONGO_URI.

const DISPOSABLE_DATABASE_NAME_POLICY = /test|check|smoke|verify|dummy|throwaway/i;
const DISPOSABLE_DATABASE_NAME_SOURCE = '/test|check|smoke|verify|dummy|throwaway/';

// Loopback only. A name that resolves anywhere else is a mistake, and the
// cheapest way to find out is to refuse before connecting rather than after
// dropping.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

class UnsafeTestDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeTestDatabaseError';
  }
}

const isDisposableTestDatabaseName = (name) =>
  typeof name === 'string' && DISPOSABLE_DATABASE_NAME_POLICY.test(name);

/**
 * The database part of a mongodb URI, or null if there is not one.
 * Accepts the three shapes that appear in this repository: `mongodb://host/db`,
 * `mongodb+srv://user:pass@host/db`, and a bare name.
 */
const databaseNameFrom = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^mongodb(\+srv)?:\/\//i.test(raw)) return raw;
  // Strip the scheme, then anything up to the first `/` that follows the
  // authority. Credentials may contain no `/`, so the last `/` before the
  // first `?` is the reliable separator.
  const withoutScheme = raw.replace(/^mongodb(\+srv)?:\/\//i, '');
  const authorityAndPath = withoutScheme.split('?')[0].split('#')[0];
  const lastSlash = authorityAndPath.lastIndexOf('/');
  if (lastSlash === -1) return null;
  const name = authorityAndPath.slice(lastSlash + 1);
  return name || null;
};

const hostFrom = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^mongodb(\+srv)?:\/\//i.test(raw)) return null;
  const withoutScheme = raw.replace(/^mongodb(\+srv)?:\/\//i, '');
  const authority = withoutScheme.split('?')[0].split('#')[0].split('/')[0];
  // Credentials, if any, are not part of the host.
  const hostOnly = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  // Drop the port, keeping IPv6 brackets intact.
  if (hostOnly.startsWith('[')) return hostOnly.slice(0, hostOnly.indexOf(']') + 1) || hostOnly;
  const colon = hostOnly.indexOf(':');
  return colon === -1 ? hostOnly : hostOnly.slice(0, colon);
};

/**
 * Throws unless `value` is a fully validated disposable test URI. Keeping this
 * legacy helper on the strict path prevents future callers from bypassing the
 * focused test URI policy with a bare database name or a different port.
 */
function assertDisposableTestDatabase(value, { label = 'test database' } = {}) {
  try {
    validateFocusedTestMongoUri(value);
  } catch {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: ${label} must use 127.0.0.1:27018, replica set ricozTestRS, ` +
      `and a disposable ricozcontract_* database matching ${DISPOSABLE_DATABASE_NAME_SOURCE}.`
    );
  }
  return databaseNameFrom(value);
}

module.exports = {
  DISPOSABLE_DATABASE_NAME_POLICY,
  DISPOSABLE_DATABASE_NAME_SOURCE,
  LOOPBACK_HOSTS,
  UnsafeTestDatabaseError,
  assertDisposableTestDatabase,
  databaseNameFrom,
  hostFrom,
  isDisposableTestDatabaseName
};

// The focused amendment suites use this stricter path. Unlike the legacy
// helper above, it has no generated URI or port fallback: callers must provide
// an explicit TEST_MONGO_URI and TEST_JWT_SECRET. The URI is validated before
// a test can call mongoose.connect().
const REQUIRED_TEST_DATABASE_PREFIX = 'ricozcontract_';
const REQUIRED_TEST_DATABASE_SUFFIX = /_(?:test|check|smoke|verify|dummy|throwaway)(?:_[a-z0-9_-]+)?$/i;
const REQUIRED_TEST_SECRET_LENGTH = 32;
const { randomBytes } = require('node:crypto');

class UnsafeFocusedTestConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeFocusedTestConfigError';
  }
}

function validateFocusedTestMongoUri(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new UnsafeFocusedTestConfigError('TEST_MONGO_URI is required.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsafeFocusedTestConfigError('TEST_MONGO_URI must be a valid MongoDB URI.');
  }

  const database = parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : '';
  const safeName = database.startsWith(REQUIRED_TEST_DATABASE_PREFIX)
    && REQUIRED_TEST_DATABASE_SUFFIX.test(database)
    && /^[a-z0-9_-]+$/i.test(database);
  const exactAuthority = value.startsWith('mongodb://127.0.0.1:27018/');
  const replicaSets = parsed.searchParams.getAll('replicaSet');
  const options = [...parsed.searchParams.keys()];

  if (parsed.protocol !== 'mongodb:'
      || !exactAuthority
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== '27018'
      || parsed.username
      || parsed.password
      || parsed.hash
      || !safeName
      || replicaSets.length !== 1
      || replicaSets[0] !== 'ricozTestRS'
      || options.length !== 1
      || options[0] !== 'replicaSet') {
    throw new UnsafeFocusedTestConfigError(
      'TEST_MONGO_URI must target 127.0.0.1:27018, replica set ricozTestRS, and a disposable ricozcontract_* database.'
    );
  }

  return value;
}

function readFocusedTestConfig(env = process.env, { suiteName } = {}) {
  const baseUri = validateFocusedTestMongoUri(env?.TEST_MONGO_URI);
  if (typeof suiteName !== 'string' || !/^[a-z0-9_-]+$/i.test(suiteName)) {
    throw new UnsafeFocusedTestConfigError('A fixed, safe suiteName is required for focused test isolation.');
  }

  const parsedUri = new URL(baseUri);
  const runId = randomBytes(8).toString('hex');
  parsedUri.pathname = `${parsedUri.pathname}_${suiteName}_${runId}`;
  const mongoUri = validateFocusedTestMongoUri(parsedUri.toString());
  const jwtSecret = env?.TEST_JWT_SECRET;
  if (typeof jwtSecret !== 'string' || jwtSecret.length < REQUIRED_TEST_SECRET_LENGTH) {
    throw new UnsafeFocusedTestConfigError(
      `TEST_JWT_SECRET must be explicitly set to at least ${REQUIRED_TEST_SECRET_LENGTH} characters.`
    );
  }
  return { mongoUri, jwtSecret };
}

module.exports.validateFocusedTestMongoUri = validateFocusedTestMongoUri;
module.exports.readFocusedTestConfig = readFocusedTestConfig;
module.exports.UnsafeFocusedTestConfigError = UnsafeFocusedTestConfigError;
