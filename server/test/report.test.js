// Phase-2 tests: dashboard aggregation scoping and totals, report summary
// shape, contract list pagination/projection, and removal of write-on-read
// overdue marking. Uses its own database so it never touches real data.
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

const reportRoutes = require('../routes/reportRoutes');
const contractRoutes = require('../routes/contractRoutes');
const obligationRoutes = require('../routes/obligationRoutes');
const milestoneRoutes = require('../routes/milestoneRoutes');
const notificationRoutes = require('../routes/notificationRoutes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_report_test';

let server;
let baseURL;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

const makeContract = ({ overrides = {}, createdBy, assignedUser }) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Report test contract',
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

const startTestApp = () =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/contracts', contractRoutes);
    app.use('/api/reports', reportRoutes);
    app.use('/api/obligations', obligationRoutes);
    app.use('/api/milestones', milestoneRoutes);
    app.use('/api/notifications', notificationRoutes);
    app.use((error, req, res, next) => {
      console.error(error);
      return res.status(500).json({ message: 'Internal server error' });
    });
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

test.before(async () => {
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  await startTestApp();
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await Obligation.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('dashboard endpoint is scoped: employee sees only their own contracts', async () => {
  const admin = await createUser({ name: 'Dash Admin', email: 'dash.admin@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Dash Employee', email: 'dash.employee@ricoz.test', role: 'Employee' });
  const adminToken = signToken(admin);
  const employeeToken = signToken(employee);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  await makeContract({ createdBy: employee._id, assignedUser: employee._id });

  const adminRes = await api('GET', '/api/reports/dashboard', { token: adminToken });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.data.metrics.total, 3, 'admin sees the full repository');

  const employeeRes = await api('GET', '/api/reports/dashboard', { token: employeeToken });
  assert.equal(employeeRes.status, 200);
  assert.equal(employeeRes.data.metrics.total, 1, 'employee scope excludes unrelated contracts');
  assert.equal(employeeRes.data.recentContracts.length, 1);
});

test('dashboard value totals reflect the full dataset and are grouped per currency', async () => {
  const admin = await createUser({ name: 'Val Admin', email: 'val.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 5000, currency: 'USD', status: 'Active' } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 2500, currency: 'USD', status: 'Draft' } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 7000, currency: 'EUR', status: 'Active' } });

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.total, 3);

  const byCurrency = Object.fromEntries(res.data.valueByCurrency.map((item) => [item.currency, item]));
  assert.equal(byCurrency.USD.total, 7500, 'USD totals include every USD contract, not just the newest 5');
  assert.equal(byCurrency.USD.active, 5000);
  assert.equal(byCurrency.EUR.total, 7000);
  assert.equal(byCurrency.EUR.active, 7000);
});

test('dashboard recent contracts are limited to the 5 newest', async () => {
  const admin = await createUser({ name: 'Recent Admin', email: 'recent.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  for (let i = 0; i < 8; i += 1) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, title: `Recent ${i}` });
  }

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.recentContracts.length, 5);
  assert.equal(res.data.metrics.total, 8);
});

test('report summary keeps its response shape and is admin/manager-only', async () => {
  const admin = await createUser({ name: 'Sum Admin', email: 'sum.admin@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Sum Employee', email: 'sum.employee@ricoz.test', role: 'Employee' });
  const adminToken = signToken(admin);
  const employeeToken = signToken(employee);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  const employeeRes = await api('GET', '/api/reports/summary', { token: employeeToken });
  assert.equal(employeeRes.status, 403);

  const adminRes = await api('GET', '/api/reports/summary', { token: adminToken });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.data.metrics.total, 1);
  assert.ok(Array.isArray(adminRes.data.statusBreakdown));
  assert.ok(Array.isArray(adminRes.data.typeBreakdown));
});

test('contract list pagination returns totals and only the requested page', async () => {
  const admin = await createUser({ name: 'Page Admin', email: 'page.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  for (let i = 0; i < 7; i += 1) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  }

  const pageRes = await api('GET', '/api/contracts?page=1&limit=3', { token });
  assert.equal(pageRes.status, 200);
  assert.ok(Array.isArray(pageRes.data.contracts));
  assert.equal(pageRes.data.contracts.length, 3);
  assert.equal(pageRes.data.total, 7);
  assert.equal(pageRes.data.totalPages, 3);

  const plainRes = await api('GET', '/api/contracts', { token });
  assert.equal(plainRes.status, 200);
  assert.ok(Array.isArray(plainRes.data), 'no pagination params keeps the plain array response');

  const invalidLimit = await api('GET', '/api/contracts?limit=500', { token });
  assert.equal(invalidLimit.status, 400);
});

test('contract list supports a fields projection to trim response size', async () => {
  const admin = await createUser({ name: 'Field Admin', email: 'field.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, title: 'Projection target' });

  const res = await api('GET', '/api/contracts?fields=contractNumber,title', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data));
  assert.ok(res.data[0].title);
  assert.ok(res.data[0].contractNumber);
  assert.equal(res.data[0].description, undefined, 'unrequested fields are omitted');
});

test('GET /obligations no longer performs a write (overdue state is not mutated on read)', async () => {
  const admin = await createUser({ name: 'Over Admin', email: 'over.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  const obligation = await Obligation.create({
    contract: contract._id,
    title: 'Past-due obligation',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Pending'
  });

  const res = await api('GET', '/api/obligations', { token });
  assert.equal(res.status, 200);
  const after = await Obligation.findById(obligation._id);
  assert.equal(after.status, 'Pending', 'read must not silently flip overdue status');
});