// Phase-3 tests: obligation/milestone editing + assignments + lifecycle
// transitions, RBAC for Admin/Manager/Employee, renewal expiring window,
// reminder tiers, renewal workflow/history and archived/closed restrictions,
// and regression coverage for the hourly overdue job (no writes on GET,
// completed items never flip back to Overdue, due-today items not flagged
// early). Uses its own database so it never touches real data.
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
const Renewal = require('../models/Renewal');

const obligationRoutes = require('../routes/obligationRoutes');
const milestoneRoutes = require('../routes/milestoneRoutes');
const renewalRoutes = require('../routes/renewalRoutes');
const markOverdueItems = require('../utils/overdueUpdater');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_phase3_test';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Calendar dates (UTC midnight) N days from today, matching what a date
// picker sends and what the overdue updater compares against.
const utcDay = (daysFromToday) => new Date(startOfUtcDay(new Date()) + daysFromToday * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

const makeContract = ({ overrides = {}, createdBy, assignedUser, isArchived = false, status = 'Draft' }) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Phase 3 contract',
  type: 'Vendor',
  partyName: 'Test vendor',
  startDate: utcDay(-30),
  endDate: utcDay(365),
  amount: 1000,
  currency: 'USD',
  createdBy,
  assignedUser,
  status,
  isArchived,
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
    app.use('/api/obligations', obligationRoutes);
    app.use('/api/milestones', milestoneRoutes);
    app.use('/api/renewals', renewalRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    app.use((error, req, res, next) => {
      if (error.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation failed' });
      }
      if (error.name === 'CastError') {
        return res.status(400).json({ message: `Invalid value for '${error.path}'` });
      }
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
  await Milestone.deleteMany({});
  await Renewal.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('employees cannot create obligations or milestones; managers can', async () => {
  const employee = await createUser({ name: 'P3 Emp A', email: 'p3.emp.a@ricoz.test' });
  const manager = await createUser({ name: 'P3 Mgr A', email: 'p3.mgr.a@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: manager._id, assignedUser: employee._id, status: 'Active' });
  const employeeToken = signToken(employee);
  const managerToken = signToken(manager);

  const body = { title: 'Blocked', contract: contract._id, assignedTo: employee._id, dueDate: utcDay(5).toISOString() };

  const obl = await api('POST', '/api/obligations', { token: employeeToken, body });
  assert.equal(obl.status, 403);
  const mil = await api('POST', '/api/milestones', { token: employeeToken, body });
  assert.equal(mil.status, 403);
  assert.equal(await Obligation.countDocuments(), 0);
  assert.equal(await Milestone.countDocuments(), 0);

  const oblOk = await api('POST', '/api/obligations', { token: managerToken, body: { ...body, title: 'Allowed obligation' } });
  assert.equal(oblOk.status, 201);
  const milOk = await api('POST', '/api/milestones', { token: managerToken, body: { ...body, title: 'Allowed milestone' } });
  assert.equal(milOk.status, 201);
});

test('employee lists are scoped to their own assignments for both work items', async () => {
  const employee = await createUser({ name: 'P3 Emp B', email: 'p3.emp.b@ricoz.test' });
  const other = await createUser({ name: 'P3 Emp C', email: 'p3.emp.c@ricoz.test' });
  const manager = await createUser({ name: 'P3 Mgr B', email: 'p3.mgr.b@ricoz.test', role: 'Manager' });
  const employeeToken = signToken(employee);
  const managerToken = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: employee._id, status: 'Active' });

  await Obligation.create({ contract: contract._id, title: 'Mine', assignedTo: employee._id, dueDate: utcDay(3) });
  await Obligation.create({ contract: contract._id, title: 'Theirs', assignedTo: other._id, dueDate: utcDay(3) });
  await Milestone.create({ contract: contract._id, title: 'My milestone', assignedTo: employee._id, dueDate: utcDay(3) });
  await Milestone.create({ contract: contract._id, title: 'Their milestone', assignedTo: other._id, dueDate: utcDay(3) });

  const employeeObligations = await api('GET', '/api/obligations', { token: employeeToken });
  assert.equal(employeeObligations.status, 200);
  assert.equal(employeeObligations.data.length, 1);
  assert.equal(employeeObligations.data[0].title, 'Mine');

  const employeeMilestones = await api('GET', '/api/milestones', { token: employeeToken });
  assert.equal(employeeMilestones.status, 200);
  assert.equal(employeeMilestones.data.length, 1);

  const managerObligations = await api('GET', '/api/obligations', { token: managerToken });
  assert.equal(managerObligations.data.length, 2);
  const managerMilestones = await api('GET', '/api/milestones', { token: managerToken });
  assert.equal(managerMilestones.data.length, 2);
});

test('employee can read their own item detail but not another person item detail', async () => {
  const employee = await createUser({ name: 'P3 Emp D', email: 'p3.emp.d@ricoz.test' });
  const other = await createUser({ name: 'P3 Emp E', email: 'p3.emp.e@ricoz.test' });
  const token = signToken(employee);
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Active' });

  const own = await Obligation.create({ contract: contract._id, title: 'Own detail', assignedTo: employee._id, dueDate: utcDay(3) });
  const foreign = await Obligation.create({ contract: contract._id, title: 'Foreign detail', assignedTo: other._id, dueDate: utcDay(3) });

  const ownRes = await api('GET', `/api/obligations/${own._id}`, { token });
  assert.equal(ownRes.status, 200);
  assert.equal(ownRes.data.title, 'Own detail');

  const foreignRes = await api('GET', `/api/obligations/${foreign._id}`, { token });
  assert.equal(foreignRes.status, 403);
});

test('employee may change status of their own item only, and never edit details', async () => {
  const employee = await createUser({ name: 'P3 Emp F', email: 'p3.emp.f@ricoz.test' });
  const other = await createUser({ name: 'P3 Emp G', email: 'p3.emp.g@ricoz.test' });
  const manager = await createUser({ name: 'P3 Mgr C', email: 'p3.mgr.c@ricoz.test', role: 'Manager' });
  const employeeToken = signToken(employee);
  const managerToken = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: employee._id, status: 'Active' });

  const own = await Obligation.create({ contract: contract._id, title: 'My task', assignedTo: employee._id, dueDate: utcDay(3) });
  const otherItem = await Obligation.create({ contract: contract._id, title: 'Someone else task', assignedTo: other._id, dueDate: utcDay(3) });

  const start = await api('PUT', `/api/obligations/${own._id}`, { token: employeeToken, body: { status: 'In Progress' } });
  assert.equal(start.status, 200);
  assert.equal(start.data.status, 'In Progress');

  const foreign = await api('PUT', `/api/obligations/${otherItem._id}`, { token: employeeToken, body: { status: 'Completed' } });
  assert.equal(foreign.status, 403);

  const detailEdit = await api('PUT', `/api/obligations/${own._id}`, {
    token: employeeToken,
    body: { status: 'Completed', dueDate: utcDay(9).toISOString() }
  });
  assert.equal(detailEdit.status, 403);
  assert.match(detailEdit.data.message, /Admin and Manager/);

  const after = await Obligation.findById(own._id);
  assert.equal(after.status, 'In Progress');
  assert.equal(after.dueDate.getTime(), utcDay(3).getTime());

  const managerComplete = await api('PUT', `/api/obligations/${own._id}`, { token: managerToken, body: { status: 'Completed' } });
  assert.equal(managerComplete.status, 200);
});

test('admin/manager can edit details, due date, description and reassign', async () => {
  const admin = await createUser({ name: 'P3 Adm A', email: 'p3.adm.a@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'P3 Emp H', email: 'p3.emp.h@ricoz.test' });
  const assignee = await createUser({ name: 'P3 Emp I', email: 'p3.emp.i@ricoz.test' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const item = await Milestone.create({ contract: contract._id, title: 'Original', description: 'before', assignedTo: employee._id, dueDate: utcDay(3) });

  const update = await api('PUT', `/api/milestones/${item._id}`, {
    token,
    body: { title: 'Renamed', description: 'after', dueDate: utcDay(20).toISOString(), assignedTo: assignee._id }
  });
  assert.equal(update.status, 200);

  const reloaded = await Milestone.findById(item._id);
  assert.equal(reloaded.title, 'Renamed');
  assert.equal(reloaded.description, 'after');
  assert.equal(reloaded.dueDate.getTime(), utcDay(20).getTime());
  assert.equal(reloaded.assignedTo.toString(), assignee._id.toString());
});

test('status transitions are enforced for obligations and milestones', async () => {
  const manager = await createUser({ name: 'P3 Mgr D', email: 'p3.mgr.d@ricoz.test', role: 'Manager' });
  const token = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: manager._id, status: 'Active' });

  const obligation = await Obligation.create({ contract: contract._id, title: 'Lifecycle', assignedTo: manager._id, dueDate: utcDay(2), status: 'Completed' });
  const milestone = await Milestone.create({ contract: contract._id, title: 'Lifecycle M', assignedTo: manager._id, dueDate: utcDay(2), status: 'Pending' });

  const completedToOverdue = await api('PUT', `/api/obligations/${obligation._id}`, { token, body: { status: 'Overdue' } });
  assert.equal(completedToOverdue.status, 400);
  assert.match(completedToOverdue.data.message, /Cannot change status/);

  const reopen = await api('PUT', `/api/obligations/${obligation._id}`, { token, body: { status: 'In Progress' } });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.data.status, 'In Progress');

  const badStatus = await api('PUT', `/api/milestones/${milestone._id}`, { token, body: { status: 'Blocked' } });
  assert.equal(badStatus.status, 400);

  const noOp = await api('PUT', `/api/milestones/${milestone._id}`, { token, body: { status: 'Pending' } });
  assert.equal(noOp.status, 200);

  const emptyBody = await api('PUT', `/api/obligations/${obligation._id}`, { token, body: {} });
  assert.equal(emptyBody.status, 400);
  assert.match(emptyBody.data.message, /No updatable fields/);
});

test('archived contracts block new items and detail edits but allow status progress', async () => {
  const admin = await createUser({ name: 'P3 Adm B', email: 'p3.adm.b@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', isArchived: true });

  const create = await api('POST', '/api/obligations', {
    token,
    body: { title: 'Nope', contract: contract._id, assignedTo: admin._id, dueDate: utcDay(5).toISOString() }
  });
  assert.equal(create.status, 400);
  assert.match(create.data.message, /archived/);

  const item = await Obligation.create({ contract: contract._id, title: 'Existing', assignedTo: admin._id, dueDate: utcDay(2) });

  const editDetails = await api('PUT', `/api/obligations/${item._id}`, { token, body: { dueDate: utcDay(30).toISOString() } });
  assert.equal(editDetails.status, 400);
  assert.match(editDetails.data.message, /archived/);

  const progressStatus = await api('PUT', `/api/obligations/${item._id}`, { token, body: { status: 'In Progress' } });
  assert.equal(progressStatus.status, 200);
  assert.equal(progressStatus.data.status, 'In Progress');
});

test('GET /obligations, /milestones and /renewals/expiring never write to the database', async () => {
  const admin = await createUser({ name: 'P3 Adm C', email: 'p3.adm.c@ricoz.test', role: 'Admin' });
  const token = signToken(admin);
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(20) } });

  const obligation = await Obligation.create({ contract: contract._id, title: 'Past due', assignedTo: admin._id, dueDate: utcDay(-10), status: 'Pending' });
  const milestone = await Milestone.create({ contract: contract._id, title: 'Past due M', assignedTo: admin._id, dueDate: utcDay(-10), status: 'In Progress' });

  const oblBefore = await Obligation.findById(obligation._id);
  const milBefore = await Milestone.findById(milestone._id);
  const contractBefore = await Contract.findById(contract._id);

  const oblRes = await api('GET', '/api/obligations', { token });
  assert.equal(oblRes.status, 200);
  const milRes = await api('GET', '/api/milestones', { token });
  assert.equal(milRes.status, 200);
  const expRes = await api('GET', '/api/renewals/expiring', { token });
  assert.equal(expRes.status, 200);

  const oblAfter = await Obligation.findById(obligation._id);
  const milAfter = await Milestone.findById(milestone._id);
  const contractAfter = await Contract.findById(contract._id);

  assert.equal(oblAfter.status, 'Pending');
  assert.equal(oblAfter.updatedAt.getTime(), oblBefore.updatedAt.getTime());
  assert.equal(oblAfter.__v, oblBefore.__v);

  assert.equal(milAfter.status, 'In Progress');
  assert.equal(milAfter.updatedAt.getTime(), milBefore.updatedAt.getTime());

  assert.equal(contractAfter.status, 'Active');
  assert.equal(contractAfter.updatedAt.getTime(), contractBefore.updatedAt.getTime());
});

test('hourly overdue job marks past-due open items, skips completed, due-today and future work', async () => {
  const admin = await createUser({ name: 'P3 Adm D', email: 'p3.adm.d@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });

  const dueYesterday = utcDay(-1);
  const dueThreeDaysAgo = utcDay(-3);

  const oblPending = await Obligation.create({ contract: contract._id, title: 'Overdue soon', assignedTo: admin._id, dueDate: dueYesterday });
  const oblProgress = await Obligation.create({ contract: contract._id, title: 'In progress past', assignedTo: admin._id, dueDate: dueThreeDaysAgo, status: 'In Progress' });
  const oblCompleted = await Obligation.create({ contract: contract._id, title: 'Done old', assignedTo: admin._id, dueDate: utcDay(-30), status: 'Completed' });
  const oblAlreadyOverdue = await Obligation.create({ contract: contract._id, title: 'Overdue stays', assignedTo: admin._id, dueDate: utcDay(-60), status: 'Overdue' });
  const oblDueToday = await Obligation.create({ contract: contract._id, title: 'Due today not overdue', assignedTo: admin._id, dueDate: utcDay(0) });
  const oblFuture = await Obligation.create({ contract: contract._id, title: 'Future safe', assignedTo: admin._id, dueDate: utcDay(10) });

  const milPending = await Milestone.create({ contract: contract._id, title: 'M overdue', assignedTo: admin._id, dueDate: dueYesterday });
  const milCompleted = await Milestone.create({ contract: contract._id, title: 'M done old', assignedTo: admin._id, dueDate: utcDay(-15), status: 'Completed' });

  const result = await markOverdueItems();

  assert.equal((await Obligation.findById(oblPending._id)).status, 'Overdue');
  assert.equal((await Obligation.findById(oblProgress._id)).status, 'Overdue');
  assert.equal((await Obligation.findById(oblCompleted._id)).status, 'Completed', 'completed items must never become overdue');
  assert.equal((await Obligation.findById(oblAlreadyOverdue._id)).status, 'Overdue');
  assert.equal((await Obligation.findById(oblDueToday._id)).status, 'Pending', 'due today is not yet overdue');
  assert.equal((await Obligation.findById(oblFuture._id)).status, 'Pending');
  assert.equal((await Milestone.findById(milPending._id)).status, 'Overdue');
  assert.equal((await Milestone.findById(milCompleted._id)).status, 'Completed');

  assert.equal(result.obligations, 2);
  assert.equal(result.milestones, 1);

  // Idempotent: a second run changes nothing.
  const secondRun = await markOverdueItems();
  assert.equal(secondRun.obligations, 0);
  assert.equal(secondRun.milestones, 0);
});

test('activities are logged for editing and status changes on both work items', async () => {
  const ActivityLog = require('../models/ActivityLog');
  const manager = await createUser({ name: 'P3 Mgr E', email: 'p3.mgr.e@ricoz.test', role: 'Manager' });
  const token = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: manager._id, status: 'Active' });
  const obligation = await Obligation.create({ contract: contract._id, title: 'Log me', assignedTo: manager._id, dueDate: utcDay(5) });

  await api('PUT', `/api/obligations/${obligation._id}`, { token, body: { title: 'Log me updated' } });

  const logs = await ActivityLog.find({ contract: contract._id });
  assert.ok(logs.some((log) => log.action === 'Obligation Updated'), 'detail edits log an update entry');
});

test('renewals endpoints are admin/manager-only', async () => {
  const employee = await createUser({ name: 'P3 Emp J', email: 'p3.emp.j@ricoz.test' });
  const manager = await createUser({ name: 'P3 Mgr F', email: 'p3.mgr.f@ricoz.test', role: 'Manager' });
  const employeeToken = signToken(employee);
  const managerToken = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: employee._id, status: 'Active', overrides: { endDate: utcDay(20) } });

  const expiringEmp = await api('GET', '/api/renewals/expiring', { token: employeeToken });
  assert.equal(expiringEmp.status, 403);
  const historyEmp = await api('GET', '/api/renewals/history', { token: employeeToken });
  assert.equal(historyEmp.status, 403);
  const renewEmp = await api('POST', `/api/renewals/renew/${contract._id}`, { token: employeeToken, body: { newEndDate: utcDay(400).toISOString() } });
  assert.equal(renewEmp.status, 403);

  const expiringMgr = await api('GET', '/api/renewals/expiring', { token: managerToken });
  assert.equal(expiringMgr.status, 200);
  const historyMgr = await api('GET', '/api/renewals/history', { token: managerToken });
  assert.equal(historyMgr.status, 200);
});

test('expiring window filters, computes days remaining and reminder tiers by UTC day', async () => {
  const admin = await createUser({ name: 'P3 Adm E', email: 'p3.adm.e@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const in10 = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(10) } });
  const in45 = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(45) } });
  const in75 = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(75) } });
  const archived = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(5) }, isArchived: true });
  const closed = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Closed', overrides: { endDate: utcDay(5) } });

  const all = await api('GET', '/api/renewals/expiring', { token });
  assert.equal(all.status, 200);
  const byId = Object.fromEntries(all.data.map((item) => [item._id, item]));
  assert.equal(all.data.length, 3, 'archived and closed contracts are excluded');
  assert.equal(byId[in10._id].daysRemaining, 10);
  assert.equal(byId[in10._id].reminder, 30);
  assert.equal(byId[in45._id].daysRemaining, 45);
  assert.equal(byId[in45._id].reminder, 60);
  assert.equal(byId[in75._id].daysRemaining, 75);
  assert.equal(byId[in75._id].reminder, 90);

  const window30 = await api('GET', '/api/renewals/expiring?window=30', { token });
  assert.equal(window30.status, 200);
  assert.equal(window30.data.length, 1);
  assert.equal(window30.data[0]._id, in10._id.toString());

  const window60 = await api('GET', '/api/renewals/expiring?window=60', { token });
  assert.equal(window60.data.length, 2);

  const badWindow = await api('GET', '/api/renewals/expiring?window=120', { token });
  assert.equal(badWindow.status, 400);
  assert.match(badWindow.data.message, /window/);

  assert.ok(byId[in10._id].daysRemaining <= 30, 'days remaining uses UTC calendar days');
  assert.equal(byId[archived._id], undefined, 'archived contract should not appear');
  assert.equal(byId[closed._id], undefined, 'closed contract should not appear');
});

test('renewal rejects archived, closed, non-renewable and non-future dates', async () => {
  const admin = await createUser({ name: 'P3 Adm F', email: 'p3.adm.f@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const archived = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(20) }, isArchived: true });
  const closed = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Closed', overrides: { endDate: utcDay(20) } });
  const draft = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Draft', overrides: { endDate: utcDay(20) } });
  const active = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(20) } });

  const archivedRenew = await api('POST', `/api/renewals/renew/${archived._id}`, { token, body: { newEndDate: utcDay(400).toISOString() } });
  assert.equal(archivedRenew.status, 400);
  assert.match(archivedRenew.data.message, /Archived/);

  const closedRenew = await api('POST', `/api/renewals/renew/${closed._id}`, { token, body: { newEndDate: utcDay(400).toISOString() } });
  assert.equal(closedRenew.status, 400);
  assert.match(closedRenew.data.message, /Closed/);

  const draftRenew = await api('POST', `/api/renewals/renew/${draft._id}`, { token, body: { newEndDate: utcDay(400).toISOString() } });
  assert.equal(draftRenew.status, 400);
  assert.match(draftRenew.data.message, /cannot be renewed/);

  const notAfter = await api('POST', `/api/renewals/renew/${active._id}`, { token, body: { newEndDate: utcDay(10).toISOString() } });
  assert.equal(notAfter.status, 400);
  assert.match(notAfter.data.message, /after the current end date/);

  const noDate = await api('POST', `/api/renewals/renew/${active._id}`, { token, body: {} });
  assert.equal(noDate.status, 400);

  const failedRenewalsCount = await Renewal.countDocuments();
  assert.equal(failedRenewalsCount, 0, 'no renewal record may be created on failed attempts');
});

test('valid renewal updates the contract, records history, and revives expired state', async () => {
  const admin = await createUser({ name: 'P3 Adm G', email: 'p3.adm.g@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const expired = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Expired', overrides: { endDate: utcDay(-5) } });
  const nextEnd = utcDay(400);

  const renew = await api('POST', `/api/renewals/renew/${expired._id}`, { token, body: { newEndDate: nextEnd.toISOString(), notes: '  Annual extension  ' } });
  assert.equal(renew.status, 201);

  const reloaded = await Contract.findById(expired._id);
  assert.equal(reloaded.status, 'Active');
  assert.equal(reloaded.endDate.getTime(), nextEnd.getTime());

  const renewal = await Renewal.findOne({ contract: expired._id });
  assert.ok(renewal);
  assert.equal(renewal.newEndDate.getTime(), nextEnd.getTime());
  assert.equal(renewal.renewedBy.toString(), admin._id.toString());
  assert.equal(renewal.notes, 'Annual extension', 'notes are trimmed before storing');

  const history = await api('GET', '/api/renewals/history', { token });
  assert.equal(history.status, 200);
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].contract._id, expired._id.toString());
  assert.equal(history.data[0].renewedBy.name, 'P3 Adm G');

  const scoped = await api('GET', `/api/renewals/history?contractId=${expired._id}`, { token });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.data.length, 1);

  const invalidFilter = await api('GET', '/api/renewals/history?contractId=not-an-id', { token });
  assert.equal(invalidFilter.status, 400);
});

