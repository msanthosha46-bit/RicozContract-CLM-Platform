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
const Milestone = require('../models/Milestone');

const reportRoutes = require('../routes/reportRoutes');
const contractRoutes = require('../routes/contractRoutes');
const obligationRoutes = require('../routes/obligationRoutes');
const milestoneRoutes = require('../routes/milestoneRoutes');
const notificationRoutes = require('../routes/notificationRoutes');
const { startOfUtcDay, MS_PER_DAY, formatUtcDate } = require('../utils/dateWindow');

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

test('GET /notifications includes overdue milestones', async () => {
  const admin = await createUser({ name: 'Notif Admin', email: 'notif.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  await Milestone.create({
    contract: contract._id,
    title: 'Overdue milestone',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  const res = await api('GET', '/api/notifications', { token });
  assert.equal(res.status, 200);
  assert.ok(res.data.items.some((item) => item.id.startsWith('milestone-') && item.type === 'overdue'));
});

test('GET /notifications scopes milestones to employee assignments', async () => {
  const admin = await createUser({ name: 'Notif Admin2', email: 'notif.admin2@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Notif Employee', email: 'notif.employee@ricoz.test', role: 'Employee' });
  const adminToken = signToken(admin);
  const employeeToken = signToken(employee);

  const adminContract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  const employeeContract = await makeContract({ createdBy: employee._id, assignedUser: employee._id });

  await Milestone.create({
    contract: adminContract._id,
    title: 'Admin overdue milestone',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });
  await Milestone.create({
    contract: employeeContract._id,
    title: 'Employee overdue milestone',
    assignedTo: employee._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  const adminRes = await api('GET', '/api/notifications', { token: adminToken });
  assert.equal(adminRes.status, 200);
  const adminMilestones = adminRes.data.items.filter((item) => item.id.startsWith('milestone-'));
  assert.ok(adminMilestones.length >= 1, 'admin sees all overdue milestones');

  const employeeRes = await api('GET', '/api/notifications', { token: employeeToken });
  assert.equal(employeeRes.status, 200);
  const employeeMilestones = employeeRes.data.items.filter((item) => item.id.startsWith('milestone-'));
  assert.equal(employeeMilestones.length, 1, 'employee sees only their own overdue milestones');
  assert.match(employeeMilestones[0].title, /Employee overdue milestone/);
});

test('GET /notifications includes all notification types', async () => {
  const admin = await createUser({ name: 'Notif Admin3', email: 'notif.admin3@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  await Contract.findByIdAndUpdate(contract._id, { status: 'Active', endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });
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

  const res = await api('GET', '/api/notifications', { token });
  assert.equal(res.status, 200);
  const types = res.data.items.map((item) => item.type);
  assert.ok(types.includes('expiry'), 'includes expiry notifications');
  assert.ok(types.includes('overdue'), 'includes overdue notifications');
  assert.ok(res.data.count >= 3, 'count reflects multiple notification types');
});

test('GET /notifications sends a working navigation target for every source', async () => {
  const admin = await createUser({ name: 'Nav Admin', email: 'nav.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  await Contract.findByIdAndUpdate(contract._id, { status: 'Active', endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });
  const obligation = await Obligation.create({
    contract: contract._id,
    title: 'Overdue obligation nav',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });
  const milestone = await Milestone.create({
    contract: contract._id,
    title: 'Overdue milestone nav',
    assignedTo: admin._id,
    dueDate: new Date('2020-01-01'),
    status: 'Overdue'
  });

  const res = await api('GET', '/api/notifications', { token });
  assert.equal(res.status, 200);

  const findBy = (predicate) => res.data.items.find(predicate);
  const expiry = findBy((item) => item.id.startsWith('expiring-') && item.href.includes(contract._id.toString()));
  assert.ok(expiry, 'an expiring-contract notification is present');
  assert.equal(expiry.href, `/contracts/${contract._id}`, 'expiry navigates to the contract details');

  const obligationItem = findBy((item) => item.id === `obligation-${obligation._id}`);
  assert.equal(obligationItem.href, '/obligations', 'overdue obligations navigate to the obligations list');

  const milestoneItem = findBy((item) => item.id === `milestone-${milestone._id}`);
  assert.equal(milestoneItem.href, '/milestones', 'overdue milestones navigate to the milestones list');
});

test('GET /notifications returns the full feed: count always matches items', async () => {
  const admin = await createUser({ name: 'Full Feed Admin', email: 'notif.fullfeed@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  // 8 expiring contracts (the per-source cap).
  for (let i = 0; i < 8; i += 1) {
    const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id });
    await Contract.findByIdAndUpdate(contract._id, { status: 'Active', endDate: inFiveDays });
  }

  // 8 overdue obligations (the per-source cap).
  for (let i = 0; i < 8; i += 1) {
    await Obligation.create({
      contract: (await Contract.findOne({}))._id,
      title: `Overdue obligation ${i}`,
      assignedTo: admin._id,
      dueDate: new Date('2020-01-01'),
      status: 'Overdue'
    });
  }

  // 8 overdue milestones (the per-source cap). Milestones are not wiped in
  // beforeEach, so the feed's 8-cap keeps this group deterministic.
  for (let i = 0; i < 8; i += 1) {
    await Milestone.create({
      contract: (await Contract.findOne({}))._id,
      title: `Overdue milestone ${i}`,
      assignedTo: admin._id,
      dueDate: new Date('2020-01-01'),
      status: 'Overdue'
    });
  }

  const res = await api('GET', '/api/notifications', { token });
  assert.equal(res.status, 200);

  // The whole feed is delivered; beforehand the combined list was silently
  // sliced to 12 while count kept rising, leaving unread items invisible.
  assert.equal(res.data.count, res.data.items.length, 'count matches the delivered items');
  assert.ok(res.data.items.length > 12, 'the feed is not truncated at 12');
  assert.equal(res.data.items.filter((item) => item.id.startsWith('expiring-')).length, 8, 'all 8 expiring contracts are present');
  assert.equal(res.data.items.filter((item) => item.id.startsWith('obligation-')).length, 8, 'all 8 overdue obligations are present');
  assert.equal(res.data.items.filter((item) => item.id.startsWith('milestone-')).length, 8, 'the 8-cap of overdue milestones is delivered');
});

test('GET /notifications uses the same UTC expiry window as reports and renewals', async () => {
  const admin = await createUser({ name: 'UTC Notif Admin', email: 'notif.utc@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const start = new Date('2020-01-01');
  const today = startOfUtcDay(new Date());
  const yesterday = today - MS_PER_DAY;

  const expiresToday = await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  await Contract.findByIdAndUpdate(expiresToday._id, { status: 'Active', startDate: start, endDate: new Date(today) });

  const expiredYesterday = await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  await Contract.findByIdAndUpdate(expiredYesterday._id, { status: 'Active', startDate: start, endDate: new Date(yesterday) });

  const res = await api('GET', '/api/notifications', { token });
  assert.equal(res.status, 200);
  const ids = res.data.items.map((item) => item.id);
  assert.ok(ids.includes(`expiring-${expiresToday._id}`), 'a contract expiring today is in the notifications feed');
  assert.ok(!ids.includes(`expiring-${expiredYesterday._id}`), 'a contract that already expired is outside the feed');
});

test('the expiry notification shows the end date in UTC, not the host timezone', async () => {
  // This is the one place a user is shown an actual upcoming expiry date, and it
  // is the only date the API formats itself (every other date is returned raw
  // and formatted by client/src/utils/date.js). It used to be rendered with a
  // bare `toLocaleDateString()`, which formats in the *host* timezone: on a
  // server at UTC-5 a contract ending 2026-10-09T00:00:00Z was announced as the
  // 8th, contradicting the UTC window that had just selected it and the
  // `Oct 9, 2026` the rest of the app shows. Nothing pins TZ in vercel.json or
  // docker-compose.yml, so the wrong day was reachable in any non-UTC
  // deployment.
  const admin = await createUser({ name: 'TZ Notif Admin', email: 'notif.tz@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const start = new Date('2020-01-01');
  const endDate = new Date(startOfUtcDay(new Date()) + 5 * MS_PER_DAY);

  const expiring = await makeContract({ createdBy: admin._id, assignedUser: admin._id });
  await Contract.findByIdAndUpdate(expiring._id, { status: 'Active', startDate: start, endDate });

  // What the date really is, in calendar terms. Derived, not hard-coded, so the
  // test keeps working tomorrow: the fixture is always 5 days ahead.
  const truth = endDate.toLocaleDateString('en-US', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
  });
  const originalTZ = process.env.TZ;
  let detail;
  let localTruth;
  try {
    // Behind UTC, which is where the mis-render appeared.
    process.env.TZ = 'America/New_York';
    // The host-local rendering of the same instant, which is what the feed used
    // to publish. Under a timezone behind UTC a UTC-midnight calendar date is
    // always the previous day, so this can always tell the two apart.
    localTruth = endDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
    assert.notEqual(truth, localTruth, 'the fixture cannot distinguish UTC from local in America/New_York');
    const res = await api('GET', '/api/notifications', { token });
    assert.equal(res.status, 200);
    const item = res.data.items.map((i) => i.id).includes(`expiring-${expiring._id}`)
      ? res.data.items.find((i) => i.id === `expiring-${expiring._id}`)
      : null;
    assert.ok(item, 'the expiring contract is in the feed');
    detail = item.detail;
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }

  assert.equal(
    detail,
    `Report test contract · ${truth}`,
    'the expiry notification must announce the UTC calendar end date, whatever the host timezone'
  );
  assert.doesNotMatch(detail, /\d+\/\d+\/\d+/, 'a locale-dependent numeric date came back');
});

test('formatUtcDate is UTC-anchored and total over bad input', () => {
  const utc = new Date('2026-10-09T00:00:00.000Z');
  const originalTZ = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      assert.equal(formatUtcDate(utc), 'Oct 9, 2026', `formatUtcDate drifted in ${tz}`);
    }
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
  // Same contract as client/src/utils/date.js formatDate, which returns an em
  // dash rather than "Invalid Date" for input it cannot read.
  assert.equal(formatUtcDate(undefined), '—');
  assert.equal(formatUtcDate(null), '—');
  assert.equal(formatUtcDate(''), '—');
  assert.equal(formatUtcDate('not-a-date'), '—');
});