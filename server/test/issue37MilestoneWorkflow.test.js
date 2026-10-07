'use strict';

// Issue 37 - Milestones workflow regressions (server side).
//
// No new server defect was found: the milestone routes share
// `server/utils/itemUpdate.js` and `server/utils/itemTransitions.js` with the
// obligations routes Issue 36 audited, and the milestone POST path was already
// covered there. What was NOT covered is the milestone PUT path - Issue 36 only
// proved the due-date guard on POST for milestones - and the audit trail the
// Milestones page leans on for "who changed this and when".
//
// This file therefore pins the milestone half of the shared workflow:
//
//   * both create and update refuse a coerced due date, and a rejected reschedule
//     leaves the stored date untouched;
//   * the transition matrix is enforced end to end on milestones, not just the
//     two cases phase3 exercised;
//   * the assignee may advance their own milestone and nothing else;
//   * creating, status-changing and detail-editing each leave an ActivityLog row
//     naming the actor and the contract, which is the only completion history the
//     product has today.

const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';

const express = require('express');

const User = require('../models/User');
const Contract = require('../models/Contract');
const Milestone = require('../models/Milestone');
const ActivityLog = require('../models/ActivityLog');
const milestoneRoutes = require('../routes/milestoneRoutes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_i37milestones_test';

let server;
let baseURL;

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const utcDay = (offset) => startOfUtcDay(new Date()) + offset * 24 * 60 * 60 * 1000;

const signToken = (user, extra = {}) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0, ...extra },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

let seq = 0;
const createUser = async (overrides = {}) => User.create({
  name: 'Probe User',
  email: `i37-${Date.now()}-${(seq += 1)}@ricoz.test`,
  password: 'Password123!',
  role: 'Employee',
  status: 'Active',
  ...overrides
});

const createContract = async (overrides = {}) => Contract.create({
  contractNumber: `I37-${Date.now()}-${(seq += 1)}`,
  title: 'Probe contract',
  type: 'Vendor',
  partyName: 'Vendor',
  startDate: new Date(utcDay(-10)),
  endDate: new Date(utcDay(300)),
  amount: 1000,
  currency: 'USD',
  createdBy: new mongoose.Types.ObjectId(),
  status: 'Active',
  isArchived: false,
  ...overrides
});

const api = async (method, url, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(baseURL + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};

test.before(async () => {
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();

  server = await new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/milestones', milestoneRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    app.use((error, req, res, next) => {
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          message: 'Validation failed',
          details: Object.values(error.errors || {}).map((d) => d.message)
        });
      }
      if (error.name === 'CastError') {
        return res.status(400).json({ message: `Invalid value for '${error.path}'` });
      }
      if (error.code === 11000) {
        return res.status(409).json({ message: 'Duplicate value' });
      }
      return res.status(500).json({ message: 'Internal server error' });
    });
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await ActivityLog.deleteMany({});
});

test.after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (server) server.close();
});

/* ------------------------------------------------------------------ *
 * Due dates on BOTH paths (Issue 36 covered POST for milestones)
 * ------------------------------------------------------------------ */

test('editing a milestone with a coerced due date is refused', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/milestones', {
    token, body: { title: 'Reschedule me', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(created.status, 201);

  for (const bad of [true, [2026, 10, 30], {}, 'not-a-date', null]) {
    const res = await api('PUT', `/api/milestones/${created.data._id}`, { token, body: { dueDate: bad } });
    assert.equal(res.status, 400, `dueDate ${JSON.stringify(bad)} must be refused on PUT`);
    assert.match(res.data.message, /valid due date/i);
  }

  const stored = await Milestone.findById(created.data._id);
  assert.equal(
    stored.dueDate.toISOString(),
    '2026-11-30T00:00:00.000Z',
    'the original due date must survive every rejected attempt'
  );

  const good = await api('PUT', `/api/milestones/${created.data._id}`, { token, body: { dueDate: '2026-12-15' } });
  assert.equal(good.status, 200, 'a legitimate reschedule still works');
  const after = await Milestone.findById(created.data._id);
  assert.equal(after.dueDate.toISOString(), '2026-12-15T00:00:00.000Z', 'YYYY-MM-DD still means UTC midnight');
});

/* ------------------------------------------------------------------ *
 * The transition matrix end to end on milestones
 * ------------------------------------------------------------------ */

test('the server enforces the milestone transition matrix end to end', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/milestones', {
    token, body: { title: 'Matrix', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'Pending', 'a new milestone always starts Pending');
  const id = created.data._id;

  const walk = async (status) => {
    const res = await api('PUT', `/api/milestones/${id}`, { token, body: { status } });
    const doc = await Milestone.findById(id);
    return { code: res.status, now: doc.status };
  };

  assert.deepEqual(await walk('In Progress'), { code: 200, now: 'In Progress' });
  assert.deepEqual(await walk('Completed'), { code: 200, now: 'Completed' });
  assert.deepEqual(await walk('In Progress'), { code: 200, now: 'In Progress' }, 'Reopen');
  assert.deepEqual(await walk('Pending'), { code: 200, now: 'Pending' });
  assert.deepEqual(await walk('Overdue'), { code: 200, now: 'Overdue' });
  assert.deepEqual(await walk('Completed'), { code: 200, now: 'Completed' });

  const reOverdue = await api('PUT', `/api/milestones/${id}`, { token, body: { status: 'Overdue' } });
  assert.equal(reOverdue.status, 400, 'a completed milestone must not go back to Overdue');
  assert.match(reOverdue.data.message, /cannot change status/i);

  for (const bad of ['Done', 'completed', '', null, 123]) {
    const res = await api('PUT', `/api/milestones/${id}`, { token, body: { status: bad } });
    assert.equal(res.status, 400, `status ${JSON.stringify(bad)} must be refused`);
    assert.match(res.data.message, /invalid milestone status/i);
  }

  const empty = await api('PUT', `/api/milestones/${id}`, { token, body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.data.message, /no updatable fields/i);
});

/* ------------------------------------------------------------------ *
 * Who may do what
 * ------------------------------------------------------------------ */

test('an assignee may advance their own milestone but nothing else', async () => {
  const employee = await createUser({ role: 'Employee' });
  const other = await createUser({ role: 'Employee' });
  const manager = await createUser({ role: 'Manager' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: employee._id });

  const created = await api('POST', '/api/milestones', {
    token: signToken(manager),
    body: { title: 'Assigned work', contract: String(contract._id), assignedTo: String(employee._id), dueDate: '2026-11-30' }
  });
  const id = created.data._id;
  const mine = signToken(employee);
  const theirs = signToken(other);

  assert.equal((await api('PUT', `/api/milestones/${id}`, { token: mine, body: { status: 'In Progress' } })).status, 200);
  assert.equal((await api('PUT', `/api/milestones/${id}`, { token: mine, body: { title: 'Mine now' } })).status, 403, 'details are privileged');
  assert.equal((await api('PUT', `/api/milestones/${id}`, { token: mine, body: { dueDate: '2026-12-01' } })).status, 403, 'rescheduling is privileged');
  assert.equal((await api('PUT', `/api/milestones/${id}`, { token: mine, body: { assignedTo: String(other._id) } })).status, 403, 'reassignment is privileged');
  assert.equal((await api('PUT', `/api/milestones/${id}`, { token: theirs, body: { status: 'Completed' } })).status, 403, 'not your milestone');
  assert.equal((await api('GET', `/api/milestones/${id}`, { token: theirs })).status, 403);
  assert.equal((await api('GET', '/api/milestones', { token: theirs })).data.length, 0, 'the list is assignee-scoped');

  const after = await Milestone.findById(id);
  assert.equal(after.status, 'In Progress');
  assert.equal(after.title, 'Assigned work');
  assert.equal(after.dueDate.toISOString(), '2026-11-30T00:00:00.000Z');
});

test('creation is Admin/Manager only and unauthenticated traffic is rejected', async () => {
  const manager = await createUser({ role: 'Manager' });
  const employee = await createUser({ role: 'Employee' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: employee._id });
  const body = { title: 'Role gate', contract: String(contract._id), assignedTo: String(employee._id), dueDate: '2026-11-30' };

  assert.equal((await api('POST', '/api/milestones', { token: signToken(manager), body })).status, 201);
  assert.equal((await api('POST', '/api/milestones', { token: signToken(employee), body })).status, 403);
  assert.equal((await api('POST', '/api/milestones', { body })).status, 401);
  assert.equal((await api('GET', '/api/milestones')).status, 401);
  assert.equal((await api('GET', '/api/milestones/not-an-id', { token: signToken(manager) })).status, 400);
  assert.equal((await api('GET', `/api/milestones/${new mongoose.Types.ObjectId()}`, { token: signToken(manager) })).status, 404);
  assert.equal(
    (await api('POST', '/api/milestones', { token: signToken(manager), body: { ...body, assignedTo: String(new mongoose.Types.ObjectId()) } })).status,
    404,
    'a forged assignee id buys nothing'
  );
  assert.equal(
    (await api('POST', '/api/milestones', { token: signToken(manager), body: { ...body, contract: String(new mongoose.Types.ObjectId()) } })).status,
    404,
    'a forged contract id buys nothing'
  );
});

test('a forged Admin claim in the token buys nothing', async () => {
  const employee = await createUser({ role: 'Employee' });
  const manager = await createUser({ role: 'Manager' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: manager._id });
  const created = await api('POST', '/api/milestones', {
    token: signToken(manager),
    body: { title: 'Guarded', contract: String(contract._id), assignedTo: String(manager._id), dueDate: '2026-11-30' }
  });

  const forged = signToken(employee, { role: 'Admin' });
  assert.equal((await api('GET', `/api/milestones/${created.data._id}`, { token: forged })).status, 403);
  assert.equal((await api('PUT', `/api/milestones/${created.data._id}`, { token: forged, body: { title: 'Hacked' } })).status, 403);
});

/* ------------------------------------------------------------------ *
 * Archived contracts
 * ------------------------------------------------------------------ */

test('an archived contract freezes milestone details but not the status', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/milestones', {
    token, body: { title: 'Before archive', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  const id = created.data._id;

  await Contract.updateOne({ _id: contract._id }, { $set: { isArchived: true } });

  const blocked = await api('POST', '/api/milestones', {
    token, body: { title: 'Too late', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /archived contract/i);

  for (const body of [{ title: 'Renamed' }, { dueDate: '2027-01-01' }, { assignedTo: String(admin._id) }]) {
    const res = await api('PUT', `/api/milestones/${id}`, { token, body });
    assert.equal(res.status, 400, `${Object.keys(body)[0]} must be frozen`);
    assert.match(res.data.message, /archived contract/i);
  }

  const advance = await api('PUT', `/api/milestones/${id}`, { token, body: { status: 'In Progress' } });
  assert.equal(advance.status, 200, 'work already on an archived contract can still be closed out');

  const moved = await api('PUT', `/api/milestones/${id}`, { token, body: { contract: String(new mongoose.Types.ObjectId()) } });
  assert.equal(moved.status, 400, 'contract immutability is a separate rule and still applies');
});

/* ------------------------------------------------------------------ *
 * The audit trail the Milestones page depends on
 * ------------------------------------------------------------------ */

test('creating and editing a milestone leaves an attributable activity trail', async () => {
  const manager = await createUser({ name: 'Mia Manager', role: 'Manager' });
  const assignee = await createUser({ name: 'Eli Employee' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: assignee._id });
  const token = signToken(manager);

  const created = await api('POST', '/api/milestones', {
    token, body: { title: 'Trail', contract: String(contract._id), assignedTo: String(assignee._id), dueDate: '2026-11-30' }
  });
  assert.equal(created.status, 201);
  const id = created.data._id;

  await api('PUT', `/api/milestones/${id}`, { token, body: { status: 'In Progress' } });
  await api('PUT', `/api/milestones/${id}`, { token, body: { status: 'Completed' } });
  await api('PUT', `/api/milestones/${id}`, { token, body: { title: 'Trail renamed', dueDate: '2026-12-20' } });

  const log = await ActivityLog.find({}).sort({ createdAt: 1 });
  assert.deepEqual(
    log.map((entry) => entry.action),
    ['Milestone Created', 'Milestone Status Updated', 'Milestone Status Updated', 'Milestone Updated'],
    'each write names which kind of change it was'
  );

  for (const entry of log) {
    assert.equal(String(entry.user), String(manager._id), 'every entry names the actor, not the assignee');
    assert.equal(String(entry.contract), String(contract._id), 'and the contract it belongs to');
    assert.ok(entry.details && entry.details.length > 0, 'and carries a human-readable detail');
  }

  assert.match(log[0].details, /Trail/);
  assert.match(log[1].details, /In Progress/);
  assert.match(log[3].details, /Trail renamed/);

  // The assignee advancing their own milestone is attributed to them.
  await api('PUT', `/api/milestones/${id}`, { token: signToken(assignee), body: { status: 'In Progress' } });
  const reopened = await ActivityLog.findOne({ action: 'Milestone Status Updated', user: assignee._id });
  assert.ok(reopened, 'an Employee\'s own status change is logged under their name');
});

test('a failed write leaves no activity entry behind', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/milestones', {
    token, body: { title: 'No trail', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });

  await api('PUT', `/api/milestones/${created.data._id}`, { token, body: { status: 'Overdue' } });
  await api('PUT', `/api/milestones/${created.data._id}`, { token, body: { dueDate: true } });

  const log = await ActivityLog.find({});
  assert.deepEqual(
    log.map((entry) => entry.action),
    ['Milestone Created', 'Milestone Status Updated'],
    'the rejected reschedule must not be recorded as if it happened'
  );

  const stored = await Milestone.findById(created.data._id);
  assert.equal(stored.status, 'Overdue');
  assert.equal(stored.dueDate.toISOString(), '2026-11-30T00:00:00.000Z');
});
