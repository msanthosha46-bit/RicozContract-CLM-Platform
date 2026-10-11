// Issue-14 regression tests: the renewal date floor is a server rule, not just
// a date-picker attribute.
//
// The bug: POST /renewals/renew/:contractId only required the new end date to
// be *after the current end date*. For a lapsed (Expired) contract the current
// end date is already in the past, so a new date that is also in the past -- but
// still later than the old one -- satisfied the check. The route then set
// status: 'Active' and stored an endDate before today's UTC midnight, which the
// hourly expiry job (utils/expiryUpdater.js) flips straight back to 'Expired'.
// The caller is told "renewed" and the contract silently lapses again.
//
// RenewalManagement.js already floors a lapsed contract at tomorrow
// (client utils/date.js renewalFloorDate), and renewalReachableDom.test.js
// asserts that floor. The server is the write-side authority, so it must reject
// a date the workflow's own floor rejects -- otherwise the UI's guard is the
// only thing standing between the API and a contradictory state.
//
// This suite drives the real route over HTTP against its own disposable
// database; no production or development data is read or written.

const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const Renewal = require('../models/Renewal');
const renewalRoutes = require('../routes/renewalRoutes');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_renewaldate_test');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
let server;
let baseURL;
let seq = 0;

/** Today at UTC midnight, the shape a date picker stores. */
const todayUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const daysFromTodayUtc = (days) => new Date(todayUtc().getTime() + days * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const makeAdmin = () => User.create({
  name: 'Renewal Date Admin',
  email: `renewal.${Date.now()}.${seq += 1}@ricoz.test`,
  password: 'Password123!',
  role: 'Admin',
  status: 'Active'
});

const makeContract = (createdBy, { status, endDate }) => Contract.create({
  contractNumber: `RD-${Date.now()}-${seq += 1}`,
  title: 'Renewal floor contract',
  type: 'Vendor',
  partyName: 'Acme Ltd',
  startDate: daysFromTodayUtc(-400),
  endDate,
  amount: 1000,
  currency: 'USD',
  createdBy,
  assignedUser: createdBy,
  status
});

const api = async (method, url, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseURL + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { status: response.status, data };
};

const renew = (contractId, newEndDate, token) =>
  api('POST', `/api/renewals/renew/${contractId}`, { token, body: { newEndDate: newEndDate.toISOString() } });

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/renewals', renewalRoutes);
  app.use((error, req, res, next) => res.status(500).json({ message: 'Internal server error' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await Renewal.deleteMany({});
  await User.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

/* ---------------- the defect ---------------- */

test('a lapsed contract cannot be renewed into a date that is already past', async () => {
  const admin = await makeAdmin();
  const token = signToken(admin);
  const oldEnd = daysFromTodayUtc(-5);
  const contract = await makeContract(admin._id, { status: 'Expired', endDate: oldEnd });

  // Two days ago: strictly after the current (past) end date, so the old check
  // accepted it, and strictly before today, so the contract would lapse again.
  const res = await renew(contract._id, daysFromTodayUtc(-2), token);
  assert.equal(res.status, 400, 'a past renewal date must be refused');
  assert.match(res.data.message, /in the future/i);

  const stored = await Contract.findById(contract._id);
  assert.equal(stored.status, 'Expired', 'the failed renewal must not revive the contract');
  assert.equal(stored.endDate.getTime(), oldEnd.getTime(), 'the end date must be untouched');
  assert.equal(await Renewal.countDocuments({ contract: contract._id }), 0, 'no renewal record on a refused attempt');
});

test('a lapsed contract cannot be renewed to today either', async () => {
  const admin = await makeAdmin();
  const token = signToken(admin);
  const contract = await makeContract(admin._id, { status: 'Expired', endDate: daysFromTodayUtc(-30) });

  const res = await renew(contract._id, todayUtc(), token);
  assert.equal(res.status, 400, 'today is not in the future and must be refused');
  assert.match(res.data.message, /in the future/i);
  assert.equal(await Renewal.countDocuments({ contract: contract._id }), 0);
});

test('a lapsed contract renews cleanly from tomorrow onwards', async () => {
  const admin = await makeAdmin();
  const token = signToken(admin);
  const contract = await makeContract(admin._id, { status: 'Expired', endDate: daysFromTodayUtc(-30) });
  const nextEnd = daysFromTodayUtc(1);

  const res = await renew(contract._id, nextEnd, token);
  assert.equal(res.status, 201);

  const stored = await Contract.findById(contract._id);
  assert.equal(stored.status, 'Active');
  assert.equal(stored.endDate.getTime(), nextEnd.getTime());
  assert.equal(await Renewal.countDocuments({ contract: contract._id }), 1);
});

/* ---------------- existing behaviour is unchanged ---------------- */

test('a running contract is still renewed by any date after its current end date', async () => {
  const admin = await makeAdmin();
  const token = signToken(admin);
  const contract = await makeContract(admin._id, { status: 'Active', endDate: daysFromTodayUtc(100) });
  const nextEnd = daysFromTodayUtc(200);

  const res = await renew(contract._id, nextEnd, token);
  assert.equal(res.status, 201);
  assert.equal((await Contract.findById(contract._id)).endDate.getTime(), nextEnd.getTime());
});

test('a running contract still rejects a date at or before its current end date', async () => {
  const admin = await makeAdmin();
  const token = signToken(admin);
  const contract = await makeContract(admin._id, { status: 'Active', endDate: daysFromTodayUtc(100) });

  // In the future, so it clears the new floor, but not past the current end date.
  const res = await renew(contract._id, daysFromTodayUtc(50), token);
  assert.equal(res.status, 400);
  assert.match(res.data.message, /after the current end date/i);
  assert.equal(await Renewal.countDocuments({ contract: contract._id }), 0);
});
