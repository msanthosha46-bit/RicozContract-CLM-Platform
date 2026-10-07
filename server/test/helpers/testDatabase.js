// Single source of truth for which database a test suite is allowed to destroy.
//
// BACKGROUND - this module exists because of a real data loss. Two suites
// resolved their connection as `process.env.MONGO_URI || '..._test'` and also
// called `dotenv.config()` on `server/.env` first, which always sets
// `MONGO_URI`. The application database (`ricozcontract`) therefore won the
// `||` every time, and the `dropDatabase()` calls in the `before`/`after` hooks
// wiped it. Local development data was lost with no dump.
//
// The fix is not "be careful". It is a rule that cannot be forgotten, applied in
// one place, plus a test (testDatabaseSafety.test.js) that fails if any suite in
// this directory grows a way around it.
//
// Two independent conditions, both mandatory:
//
//   1. The host must be loopback. A remote or replica-set host is refused
//      outright, so no suite can reach a production or staging MongoDB no matter
//      what it is called. This is what makes "never connect to production"
//      structural rather than a review step.
//   2. The database name must look disposable - it has to match
//      /test|check|smoke|verify|dummy|throwaway/. `ricozcontract` does not match,
//      so the development database cannot be selected by name.
//
// `process.env.MONGO_URI` is deliberately never read here. Reading it at all is
// the original defect: it is the application's connection string, and a test has
// no business inheriting it. The only override honoured is `TEST_MONGO_DB`, and
// only after it has passed both checks.

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
 * Throws unless `value` names a loopback database that looks disposable.
 * Accepts a bare name or a full URI so callers can hand it either.
 */
function assertDisposableTestDatabase(value, { label = 'test database' } = {}) {
  const name = databaseNameFrom(value);
  if (!name) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: no database name could be read from ${label} '${value}'. ` +
      `Expected a disposable database matching ${DISPOSABLE_DATABASE_NAME_SOURCE}.`
    );
  }
  if (!isDisposableTestDatabaseName(name)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: ${label} '${name}' does not look like a disposable test database. ` +
      `Test suites drop the database they connect to, so the name must match ` +
      `${DISPOSABLE_DATABASE_NAME_SOURCE}. The development database 'ricozcontract' ` +
      'does not match and cannot be selected.'
    );
  }
  // A bare name has no host to check; a URI does.
  const host = hostFrom(value);
  if (host !== null && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run: ${label} '${value}' points at host '${host}', which is not loopback. ` +
      'Test suites may only connect to 127.0.0.1 or localhost.'
    );
  }
  return name;
}

/**
 * The connection string a suite should use.
 *
 * `defaultName` is this suite's own disposable database. `TEST_MONGO_DB` may
 * override it, as a bare name or a full URI, and is validated before it is used.
 * `process.env.MONGO_URI` is never consulted.
 */
function disposableTestDatabaseUri(defaultName, { env = process.env, label = 'TEST_MONGO_DB' } = {}) {
  const override = env && env.TEST_MONGO_DB ? String(env.TEST_MONGO_DB).trim() : '';
  const requested = override || defaultName;
  const name = assertDisposableTestDatabase(requested, { label: override ? label : 'the suite default' });
  if (/^mongodb(\+srv)?:\/\//i.test(requested)) return requested;
  return `mongodb://127.0.0.1:27017/${name}`;
}

module.exports = {
  DISPOSABLE_DATABASE_NAME_POLICY,
  DISPOSABLE_DATABASE_NAME_SOURCE,
  LOOPBACK_HOSTS,
  UnsafeTestDatabaseError,
  assertDisposableTestDatabase,
  databaseNameFrom,
  disposableTestDatabaseUri,
  hostFrom,
  isDisposableTestDatabaseName
};
