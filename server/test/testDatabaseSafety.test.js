const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DISPOSABLE_DATABASE_NAME_SOURCE,
  UnsafeTestDatabaseError,
  assertDisposableTestDatabase,
  databaseNameFrom,
  disposableTestDatabaseUri,
  hostFrom,
  isDisposableTestDatabaseName
} = require('./helpers/testDatabase');

const TEST_DIR = __dirname;
const SUITE_FILES = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js'));
const APP_DB_NAME = 'ricozcontract';

// Removes comments before scanning source, so the explanatory comments this
// codebase carries around a hazard are not mistaken for the hazard.
//
// Line comments are only stripped when the `//` starts the trimmed line, and
// block comments are removed first. A naive `//` strip would eat the `//` in
// every `mongodb://` string in the file and truncate the very URIs under test.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*)/.test(line))
  .join('\n');

const readSuite = (name) => stripComments(fs.readFileSync(path.join(TEST_DIR, name), 'utf8'));

// Only URIs in a position where they are actually handed to something that could
// connect: a declaration, or an argument to connect/openUri. A URI that appears
// as, say, the text of a synthetic Error is a test fixture and connects to
// nothing - stability.test.js carries a fake cluster URI precisely to check that
// the error handler redacts a connection string, and it must keep being allowed
// to.
const CONNECTION_POSITION = /(?:=\s*|\b(?:connect|openUri|uri)\s*\(\s*)['"`]?(mongodb(?:\+srv)?:\/\/[^'"`\s)]+)/g;
const connectionUrisIn = (source) => [...source.matchAll(CONNECTION_POSITION)].map((m) => m[1]);

// This file is excluded from the source scans below: proving the refusals work
// requires naming the development database and a remote host, so the scanner
// would otherwise always find its own hostile fixtures.
const SCANNED_SUITES = SUITE_FILES.filter((name) => name !== 'testDatabaseSafety.test.js');

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

test('the development database is not a disposable database', () => {
  // The single assertion the whole phase turns on. If this ever passes, every
  // destructive suite in this directory becomes capable of wiping local data.
  assert.equal(isDisposableTestDatabaseName(APP_DB_NAME), false);
  assert.throws(
    () => assertDisposableTestDatabase(APP_DB_NAME),
    (error) => {
      assert.equal(error.name, 'UnsafeTestDatabaseError');
      assert.match(error.message, /ricozcontract/);
      return true;
    },
    'the development database must be refused by name'
  );
});

test('TEST_MONGO_DB cannot be used to select the development database', () => {
  // Every way someone might try to point a suite back at real data.
  for (const attempt of [
    'ricozcontract',
    'RicozContract',
    '  ricozcontract  ',
    'mongodb://127.0.0.1:27017/ricozcontract',
    'mongodb+srv://user:pass@cluster0.example.mongodb.net/ricozcontract'
  ]) {
    assert.throws(
      () => disposableTestDatabaseUri(`${APP_DB_NAME}_fallback`, { env: { TEST_MONGO_DB: attempt } }),
      UnsafeTestDatabaseError,
      `TEST_MONGO_DB='${attempt}' must be refused`
    );
  }
});

test('a non-loopback host is refused even with a disposable-looking name', () => {
  // The name check alone is not enough: a test database on a shared or
  // production host is still someone else's data.
  assert.throws(
    () => disposableTestDatabaseUri('unused', {
      env: { TEST_MONGO_DB: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/ricozcontract_prod_test' }
    }),
    (error) => {
      assert.match(error.message, /not loopback/);
      return true;
    }
  );
});

test('disposable loopback databases are accepted', () => {
  for (const name of [
    'ricozcontract_amendment_test',
    'ricozcontract_editlock_test',
    'ricozcontract_seed_safety_test',
    'ricozcontract_releaseverify_dummy',
    'ricozcontract_health_check',
    'ricozcontract_smoke',
    'ricozcontract_stability_test'
  ]) {
    assert.equal(assertDisposableTestDatabase(name), name, `${name} should be accepted`);
  }
  assert.equal(
    disposableTestDatabaseUri('ricozcontract_amendment_test', { env: {} }),
    'mongodb://127.0.0.1:27017/ricozcontract_amendment_test'
  );
  // A full loopback URI passes through unchanged.
  assert.equal(
    disposableTestDatabaseUri('unused', { env: { TEST_MONGO_DB: 'mongodb://localhost:27017/other_test' } }),
    'mongodb://localhost:27017/other_test'
  );
});

test('the suite default is validated too, not just the override', () => {
  // Otherwise a suite could be written with an unsafe default and rely on nobody
  // ever setting the environment variable.
  assert.throws(() => disposableTestDatabaseUri(APP_DB_NAME, { env: {} }), UnsafeTestDatabaseError);
});

test('the documented policy and the enforced policy are the same regex', () => {
  // The phase specifies /test|check|smoke|verify|dummy|throwaway/; if the code
  // drifts from the documented rule the rule is no longer being enforced.
  const source = fs.readFileSync(path.join(TEST_DIR, 'helpers', 'testDatabase.js'), 'utf8');
  assert.match(
    source,
    /const DISPOSABLE_DATABASE_NAME_POLICY = \/test\|check\|smoke\|verify\|dummy\|throwaway\/i;/,
    'the enforced policy no longer matches the documented one'
  );
  assert.equal(DISPOSABLE_DATABASE_NAME_SOURCE, '/test|check|smoke|verify|dummy|throwaway/');
});

test('a URI is parsed into host and database, credentials included', () => {
  // The helpers do the parsing the assertions above depend on; a bug here would
  // quietly weaken every guard, so the parsing is pinned directly.
  assert.equal(hostFrom('mongodb+srv://user:p%40ss@cluster0.example.mongodb.net/db_test'), 'cluster0.example.mongodb.net');
  assert.equal(databaseNameFrom('mongodb+srv://user:p%40ss@cluster0.example.mongodb.net/db_test'), 'db_test');
  assert.equal(hostFrom('mongodb://127.0.0.1:27017/db_test'), '127.0.0.1');
  assert.equal(databaseNameFrom('mongodb://127.0.0.1:27017/db_test'), 'db_test');
  // A query string is not part of the name.
  assert.equal(databaseNameFrom('mongodb://127.0.0.1:27017/db_test?retryWrites=true'), 'db_test');
  // Credentials containing a slash must not be mistaken for a path.
  assert.equal(databaseNameFrom('mongodb://user:p/w@127.0.0.1:27017/db_test'), 'db_test');
  // A bare name has no host to check, which is why a bare name is only half the
  // guard - the caller supplies loopback.
  assert.equal(hostFrom('db_test'), null);
  assert.equal(databaseNameFrom('db_test'), 'db_test');
});

// ---------------------------------------------------------------------------
// The suites themselves
// ---------------------------------------------------------------------------

test('no suite in this directory can reach the application connection string', () => {
  // This is the regression guard for the data loss itself. `process.env.MONGO_URI`
  // is the application's connection string in server/.env, and reading it from a
  // suite is how a `||` fallback silently stops being a fallback.
  //
  // Assignment as a child-process key (`env: { ...process.env, MONGO_URI: X }`)
  // is fine and is not a read, so only the read form is forbidden.
  const offenders = SUITE_FILES.filter((name) => /process\.env\.MONGO_URI|process\.env\[['"`]MONGO_URI/.test(readSuite(name)));
  assert.deepEqual(offenders, [], `these suites read the application MONGO_URI: ${offenders.join(', ')}`);
});

test('every database a suite connects to is a disposable loopback database', () => {
  const failures = [];
  for (const name of SCANNED_SUITES) {
    for (const uri of connectionUrisIn(readSuite(name))) {
      const dbName = databaseNameFrom(uri);
      const host = hostFrom(uri);
      if (!isDisposableTestDatabaseName(dbName)) {
        failures.push(`${name}: '${dbName}' is not disposable`);
      }
      if (host && !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(host)) {
        failures.push(`${name}: host '${host}' is not loopback`);
      }
    }
  }
  assert.deepEqual(failures, [], `unsafe connection targets:\n  ${failures.join('\n  ')}`);
});

test('no suite connects to the development database', () => {
  // Belt and braces against the specific database that was lost, whichever way
  // the URI is assembled.
  const offenders = SCANNED_SUITES.filter((name) =>
    connectionUrisIn(readSuite(name)).some((uri) => databaseNameFrom(uri) === APP_DB_NAME)
  );
  assert.deepEqual(offenders, [], `these suites target ${APP_DB_NAME}: ${offenders.join(', ')}`);
});

test('every destructive suite declares its database through the shared helper or a literal name', () => {
  // A suite that calls dropDatabase() has to have declared where it is pointed.
  // Anything else is a suite whose target is decided somewhere further away.
  const unresolved = [];
  for (const name of SUITE_FILES) {
    const source = readSuite(name);
    if (!source.includes('dropDatabase()')) continue;
    const declared =
      source.includes('disposableTestDatabaseUri') ||
      /const\s+\w*DB_URI\s*=\s*'mongodb:\/\//.test(source) ||
      /const\s+\w*DB_URI\s*=\s*`mongodb:\/\//.test(source);
    if (!declared) unresolved.push(name);
  }
  assert.deepEqual(unresolved, [], `destructive suites with no declared test database: ${unresolved.join(', ')}`);
});

test('the shared helper is what the two Phase 13/14 suites actually use', () => {
  // If a suite keeps a private copy of the rule, the policy stops being one rule.
  for (const name of ['amendments.test.js', 'contractEditLock.test.js']) {
    const source = fs.readFileSync(path.join(TEST_DIR, name), 'utf8');
    assert.match(source, /require\('\.\/helpers\/testDatabase'\)/, `${name} does not use the shared helper`);
  }
});

test('the helper itself never reads the application connection string', () => {
  const source = readSuite(path.join('helpers', 'testDatabase.js'));
  assert.doesNotMatch(source, /process\.env\.MONGO_URI/);
});
