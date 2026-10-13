// Issue-38 regression tests: the Reports summary and Dashboard currency totals
// must be drawn from the same non-archived repository, and an unknown or future
// role must fail closed on the admin/manager-only summary endpoint.
//
// These promote the assertions that previously lived only in the untracked
// diagnostic probe server/test/probe38.js into the committed suite, so the
// behaviour cannot silently regress once the probe is gone.
//
// Uses its own database and never touches real data.
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
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

const reportRoutes = require('../routes/reportRoutes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_issue38_test';

let server;
let baseURL;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async (overrides = {}) => User.create({
  name: 'Issue 38 User',
  email: `issue38.${Date.now()}.${Math.floor(Math.random() * 1e6)}@ricoz.test`,
  password: 'Password123!',
  role: 'Admin',
  ...overrides
});

// The HTTP API enum-rejects a role outside the allow-list, but a bad migration,
// a renamed role or another writer can still leave one in the database. Write
// it directly (the same trick authorizationScope.test.js uses) to prove the
// read paths fail closed rather than open.
const forceRole = async (user, role) => {
  await User.collection.updateOne({ _id: user._id }, { $set: { role } });
  return User.findById(user._id);
};

const makeContract = ({ createdBy, assignedUser = createdBy, ...overrides } = {}) => Contract.create({
  contractNumber: `I38-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Issue 38 contract',
  type: 'Vendor',
  partyName: 'Issue 38 vendor',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-12-31'),
  amount: 1000,
  currency: 'USD',
  createdBy,
  assignedUser,
  ...overrides
});

const api = async (method, url, { token } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseURL + url, { method, headers });
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { status: response.status, data };
};

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/reports', reportRoutes);
  app.use((error, req, res, next) => res.status(500).json({ message: 'Internal server error' }));
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; });
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await Obligation.deleteMany({});
  await Milestone.deleteMany({});
  await User.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('dashboard valueByCurrency excludes archived contracts and totals only the eligible amounts', async () => {
  const admin = await createUser({ role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, status: 'Active', amount: 5000, currency: 'USD' });
  await makeContract({ createdBy: admin._id, status: 'Draft', amount: 2500, currency: 'USD' });
  await makeContract({ createdBy: admin._id, status: 'Active', amount: 7000, currency: 'EUR' });
  // Archived contracts are out of the repository, so their amounts must not
  // appear in any total.
  await makeContract({ createdBy: admin._id, status: 'Active', amount: 9999, currency: 'USD', isArchived: true });
  await makeContract({ createdBy: admin._id, status: 'Active', amount: 1234, currency: 'EUR', isArchived: true });

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.total, 3, 'the archived contracts are not counted at all');

  const byCurrency = Object.fromEntries(res.data.valueByCurrency.map((item) => [item.currency, item]));
  assert.equal(byCurrency.USD.total, 7500, 'the archived USD contract must not inflate the USD total');
  assert.equal(byCurrency.USD.active, 5000, 'active USD excludes both the archived contract and the Draft one');
  assert.equal(byCurrency.EUR.total, 7000, 'the archived EUR contract must not inflate the EUR total');
  assert.equal(byCurrency.EUR.active, 7000);
});

test('dashboard groups each currency into its own bucket without folding it into the USD total', async () => {
  const admin = await createUser({ role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, status: 'Active', amount: 100, currency: 'USD' });
  await makeContract({ createdBy: admin._id, status: 'Active', amount: 200, currency: 'EUR' });
  await makeContract({ createdBy: admin._id, status: 'Active', amount: 300, currency: 'GBP' });

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);

  const usdBuckets = res.data.valueByCurrency.filter((item) => item.currency === 'USD');
  assert.equal(usdBuckets.length, 1, 'there must be exactly one USD bucket');
  assert.equal(usdBuckets[0].total, 100, 'only USD amounts are summed into the USD total');

  assert.equal(res.data.valueByCurrency.length, 3, 'every currency keeps its own bucket');
  const grandTotal = res.data.valueByCurrency.reduce((sum, item) => sum + item.total, 0);
  assert.equal(grandTotal, 600, 'the EUR and GBP amounts must not be merged into the USD total');
});

test('overdue figures include eligible live-contract items but exclude archived contracts', async () => {
  const admin = await createUser({ role: 'Admin' });
  const token = signToken(admin);

  const live = await makeContract({ createdBy: admin._id, status: 'Active' });
  const archived = await makeContract({ createdBy: admin._id, status: 'Active', isArchived: true });

  // Eligible: overdue work on a live contract.
  await Obligation.create({
    contract: live._id, title: 'Eligible overdue obligation', assignedTo: admin._id,
    dueDate: new Date('2020-01-01'), status: 'Overdue'
  });
  await Milestone.create({
    contract: live._id, title: 'Eligible overdue milestone', assignedTo: admin._id,
    dueDate: new Date('2020-01-01'), status: 'Overdue'
  });
  // Not overdue, so not counted even though it is in the repository.
  await Obligation.create({
    contract: live._id, title: 'Future obligation', assignedTo: admin._id,
    dueDate: new Date('2030-01-01'), status: 'Pending'
  });
  // Frozen leftovers on an archived contract must not inflate the figure.
  await Obligation.create({
    contract: archived._id, title: 'Frozen overdue obligation', assignedTo: admin._id,
    dueDate: new Date('2020-01-01'), status: 'Overdue'
  });
  await Milestone.create({
    contract: archived._id, title: 'Frozen overdue milestone', assignedTo: admin._id,
    dueDate: new Date('2020-01-01'), status: 'Overdue'
  });

  const res = await api('GET', '/api/reports/summary', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.total, 1, 'the archived contract is out of the repository');
  assert.equal(res.data.metrics.overdueObligations, 1, 'only the eligible live-contract obligation is counted');
  assert.equal(res.data.metrics.overdueMilestones, 1, 'only the eligible live-contract milestone is counted');
});

test('an unknown or future role fails closed on the summary endpoint', async () => {
  const admin = await createUser({ role: 'Admin' });
  const employee = await createUser({ role: 'Employee' });

  await makeContract({ createdBy: admin._id, status: 'Active' });

  // Baseline authorization: the summary is Admin/Manager only.
  assert.equal((await api('GET', '/api/reports/summary')).status, 401, 'an unauthenticated caller is refused');
  assert.equal(
    (await api('GET', '/api/reports/summary', { token: signToken(employee) })).status,
    403,
    'an Employee is refused'
  );
  assert.equal(
    (await api('GET', '/api/reports/summary', { token: signToken(admin) })).status,
    200,
    'an Admin is allowed'
  );

  // A role left behind by a migration or another writer must not be treated as
  // privileged by the allow-list, on the summary or anywhere else.
  const future = await forceRole(employee, 'SuperAdmin');
  const refused = await api('GET', '/api/reports/summary', { token: signToken(future) });
  assert.equal(refused.status, 403, 'an unknown role is not authorized for the summary');

  const dashboard = await api('GET', '/api/reports/dashboard', { token: signToken(future) });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.metrics.total, 0, 'an unknown role must not see the whole repository');
});

test('a role claim in the token cannot escalate the summary endpoint', async () => {
  const employee = await createUser({ role: 'Employee' });

  // The middleware reads the role from the database, so a forged privilege
  // claim in the token must not change the outcome.
  const forged = jwt.sign(
    { id: employee._id.toString(), role: 'Admin', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const res = await api('GET', '/api/reports/summary', { token: forged });
  assert.equal(res.status, 403, 'the role is read from the database, not the token claim');
});
