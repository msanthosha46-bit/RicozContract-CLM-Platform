// Reports summary vs the archive freeze: the overdue-item figures must come
// from the same repository as every other figure on the page.
//
// The defect this exists for: `/api/reports/summary` answered every other
// figure (total, status/type breakdown, expiring soon) from `isArchived: false`
// contracts only - the Reports page copy at
// client/src/pages/Reports.js says "Counts are drawn from every non-archived
// contract" - but the `overdueObligations` and `overdueMilestones` counts were
// bare `{ status: 'Overdue' }` queries with no archive join. An obligation or
// milestone left overdue on a contract that was later archived therefore kept
// inflating the "Overdue Items" KPI on the Reports page, while the same
// contract vanished from the total, every breakdown and the Dashboard. The
// archived freeze is a withdrawal from the workspace, not a way to hide data.
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

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_report_archive_test';

let server;
let baseURL;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async (overrides = {}) => User.create({
  name: 'Archive Report Admin',
  email: `ar.${Date.now()}.${Math.floor(Math.random() * 1e6)}@ricoz.test`,
  password: 'Password123!',
  role: 'Admin',
  ...overrides
});

const makeContract = ({ createdBy, assignedUser = createdBy, ...overrides } = {}) => Contract.create({
  contractNumber: `ARC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Archive overdue test',
  type: 'Vendor',
  partyName: 'Test vendor',
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
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; });
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await Obligation.deleteMany({});
  await Milestone.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('overdue items on archived contracts do not inflate the Reports overdue figures', async () => {
  const admin = await createUser({});
  const token = signToken(admin);

  const live = await makeContract({ createdBy: admin._id, status: 'Active' });
  const archived = await makeContract({ createdBy: admin._id, status: 'Active', isArchived: true });

  await Obligation.create({
    contract: live._id,
    title: 'Live overdue obligation',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });
  await Milestone.create({
    contract: live._id,
    title: 'Live overdue milestone',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  // Frozen leftovers: the contract was archived with overdue work still open.
  await Obligation.create({
    contract: archived._id,
    title: 'Archived overdue obligation',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });
  await Milestone.create({
    contract: archived._id,
    title: 'Archived overdue milestone',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  const res = await api('GET', '/api/reports/summary', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.total, 1, 'the archived contract is out of the repository');
  assert.equal(res.data.metrics.overdueObligations, 1, 'overdue obligations must match the non-archived repository');
  assert.equal(res.data.metrics.overdueMilestones, 1, 'overdue milestones must match the non-archived repository');
});

test('overdue counts on entirely live repositories are unchanged', async () => {
  const admin = await createUser({});
  const token = signToken(admin);

  const contract = await makeContract({ createdBy: admin._id, status: 'Active' });
  await Obligation.create({
    contract: contract._id,
    title: 'Overdue obligation',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });
  await Milestone.create({
    contract: contract._id,
    title: 'Overdue milestone',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  const res = await api('GET', '/api/reports/summary', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.total, 1);
  assert.equal(res.data.metrics.overdueObligations, 1);
  assert.equal(res.data.metrics.overdueMilestones, 1);
});
