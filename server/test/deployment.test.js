// PHASE-5 pre-deployment guards: the document index utility must apply the
// timeout it is given (rather than a fixed default), and the seed script must
// never be able to build the unique (contract, version) index implicitly.
// Both checks are safe to run: they never touch production data and the only
// index any of them can create is created inside disposable test databases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');

const mongoose = require('mongoose');

const {
  TIMEOUT_CODE,
  DEFAULT_TIMEOUT_MS,
  readDocumentVersionIndexReport,
  syncDocumentVersionIndex
} = require('../utils/documentIndexes');

const SERVER_ROOT = path.join(__dirname, '..');
const SEED_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_seed_safety_test';
const DOCUMENT_INDEX_NAME = 'contract_1_version_1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The index utility only ever touches `model.collection`, so a plain object is
// enough to drive it. The collection answers after `delayMs`, which is how a
// slow or stalled database is simulated.
const fakeModel = (delayMs) => ({
  collection: {
    indexes: async () => {
      await sleep(delayMs);
      return [];
    },
    aggregate: () => ({
      toArray: async () => {
        await sleep(delayMs);
        return [];
      }
    })
  }
});

// Comfortably longer than the budgets under test, so a guard that ignores its
// configured value is caught, while the pending request keeps the event loop
// alive exactly as a real database round trip would.
const STALLED_RESPONSE_MS = 1200;

const runSeedScript = () =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(SERVER_ROOT, 'utils', 'seedData.js')],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, MONGO_URI: SEED_DB_URI, FORCE_SEED: '' },
        timeout: 60000
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    );
  });

test.after(async () => {
  const admin = mongoose.createConnection();
  await admin.openUri(SEED_DB_URI, { autoIndex: false });
  await admin.dropDatabase();
  await admin.close();
  if (mongoose.connection.readyState) await mongoose.disconnect();
});

test('the index check applies the timeout it is given instead of a fixed default', async () => {
  const stalled = fakeModel(STALLED_RESPONSE_MS);
  const startedAt = Date.now();

  await assert.rejects(
    readDocumentVersionIndexReport(stalled, { maxTimeMS: 60 }),
    (error) => {
      assert.equal(error.code, TIMEOUT_CODE);
      assert.match(error.message, /exceeded 60ms/, 'the reported budget is the configured one');
      return true;
    }
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < DEFAULT_TIMEOUT_MS / 2,
    `a 60ms budget must not wait for the ${DEFAULT_TIMEOUT_MS}ms default (waited ${elapsed}ms)`
  );
});

test('the index procedure applies the same configured timeout', async () => {
  const startedAt = Date.now();

  await assert.rejects(
    syncDocumentVersionIndex(fakeModel(STALLED_RESPONSE_MS), { maxTimeMS: 60 }),
    (error) => error.code === TIMEOUT_CODE
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < DEFAULT_TIMEOUT_MS / 2,
    `indexes:sync must honour its own 60ms budget (waited ${elapsed}ms)`
  );
});

test('a slow check still completes when the configured timeout is generous', async () => {
  const slow = fakeModel(150);
  const startedAt = Date.now();

  const report = await readDocumentVersionIndexReport(slow, { maxTimeMS: 5000 });

  assert.ok(Date.now() - startedAt >= 150, 'the scan was not cut short');
  assert.equal(report.indexPresent, false);
  assert.equal(report.duplicateGroups.length, 0);
  assert.equal(report.missingVersionGroups.length, 0);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.ready, false, 'a missing index is still reported as not ready');
});

test('a budget of 0 waits for the scan with no timeout at all', async () => {
  const report = await readDocumentVersionIndexReport(fakeModel(200), { maxTimeMS: 0 });
  assert.equal(report.blockers.length, 0);
  assert.equal(report.indexReady, false);
});

test('the seed script connects with autoIndex disabled', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'utils', 'seedData.js'), 'utf8');
  const connectCall = source.slice(source.indexOf('mongoose.connect'));
  assert.match(connectCall, /autoIndex:\s*false/, 'the seed must not build indexes implicitly');
});

test('running the seed script creates no document version index', async () => {
  const { error, stderr } = await runSeedScript();
  assert.equal(error, null, `the seed script failed: ${stderr}`);

  const connection = mongoose.createConnection();
  await connection.openUri(SEED_DB_URI, { autoIndex: false });
  try {
    const collections = await connection.db.listCollections({}, { nameOnly: true }).toArray();
    const documentIndexes = collections.some((entry) => entry.name === 'contractdocuments')
      ? await connection.db.collection('contractdocuments').indexes()
      : [];

    assert.equal(
      documentIndexes.some((index) => index.name === DOCUMENT_INDEX_NAME),
      false,
      'seeding must not create the unique (contract, version) index'
    );

    const users = await connection.db.collection('users').countDocuments();
    assert.ok(users > 0, 'the seed actually ran against the disposable database');
  } finally {
    await connection.close();
  }
});
