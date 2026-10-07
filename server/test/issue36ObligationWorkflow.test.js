'use strict';

// Issue 36 - Obligations workflow regressions (server side).
//
// One genuine defect found by the audit: the due date was parsed with a bare
// `new Date(x)`, which is far more permissive than a calendar date. Both
// `dueDate: true` (=> 1970-01-01T00:00:00.001Z, instantly Overdue) and
// `dueDate: [2026, 10, 30]` (=> *local* midnight, the wrong UTC calendar day and
// therefore overdue a day early) were accepted with 200/201 and stored as if they
// were real due dates. The same hole existed on the PUT path for both obligations
// and milestones, so the guard now lives in the shared itemUpdate helper.
//
// The rest of this file pins the behaviors the workflow depends on, so a future
// change to the shared helper cannot quietly alter them: the transition matrix,
// who may edit what, contract immutability, the archived-contract freeze, and
// UTC calendar-day boundaries.

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
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const obligationRoutes = require('../routes/obligationRoutes');
const milestoneRoutes = require('../routes/milestoneRoutes');
const { applyItemUpdate, parseDueDate } = require('../utils/itemUpdate');
const { canTransitionItem } = require('../utils/itemTransitions');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_i36obligations_test';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const utcDay = (offset) => new Date(startOfUtcDay(new Date()) + offset * MS_PER_DAY);

const signToken = (user, extra = {}) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0, ...extra },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

let seq = 0;
const createUser = async (overrides = {}) => User.create({
  name: 'Probe User',
  email: `i36-${Date.now()}-${(seq += 1)}@ricoz.test`,
  password: 'Password123!',
  role: 'Employee',
  status: 'Active',
  ...overrides
});

const createContract = async (overrides = {}) => Contract.create({
  contractNumber: `I36-${Date.now()}-${(seq += 1)}`,
  title: 'Probe contract',
  type: 'Vendor',
  partyName: 'Vendor',
  startDate: utcDay(-10),
  endDate: utcDay(300),
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
    app.use('/api/obligations', obligationRoutes);
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

test.after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (server) server.close();
});

/* ------------------------------------------------------------------ *
 * The defect: due date input type coercion
 * ------------------------------------------------------------------ */

test('parseDueDate rejects values that are not dates at all', () => {
  // The exact inputs that used to be silently coerced.
  assert.equal(parseDueDate(true), null, 'a boolean must not become 1970-01-01T00:00:00.001Z');
  assert.equal(parseDueDate([2026, 10, 30]), null, 'an array must not become local midnight');
  assert.equal(parseDueDate({}), null);
  assert.equal(parseDueDate({ year: 2026 }), null);
  assert.equal(parseDueDate(() => {}), null);
  assert.equal(parseDueDate(Symbol('x')), null);
  assert.equal(parseDueDate(null), null);
  assert.equal(parseDueDate(undefined), null);
  assert.equal(parseDueDate('not-a-date'), null);
  assert.equal(parseDueDate(Number.NaN), null);
});

test('parseDueDate keeps accepting the shapes a date picker sends', () => {
  assert.equal(parseDueDate('2026-11-30').toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(parseDueDate('2026-11-30T00:00:00.000Z').toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(parseDueDate(new Date('2026-11-30T00:00:00.000Z')).toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(parseDueDate(1790000000000).getTime(), 1790000000000, 'an epoch number is a legitimate timestamp');
});

test('creating an obligation with a coerced due date is refused', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const base = { title: 'Type check', contract: String(contract._id), assignedTo: String(admin._id) };

  const before = await Obligation.countDocuments({ contract: contract._id });

  const refused = await api('POST', '/api/obligations', { token, body: { ...base, dueDate: true } });
  assert.equal(refused.status, 400, 'a boolean due date must not create a 1970 obligation');
  assert.match(refused.data.message, /valid due date/i);

  const shifted = await api('POST', '/api/obligations', { token, body: { ...base, dueDate: [2026, 10, 30] } });
  assert.equal(shifted.status, 400, 'an array due date must not become local midnight');

  assert.equal(
    await Obligation.countDocuments({ contract: contract._id }),
    before,
    'nothing may be persisted from a rejected due date'
  );
});

test('editing an obligation with a coerced due date is refused', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/obligations', {
    token, body: { title: 'Reschedule', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(created.status, 201);

  for (const bad of [true, [2026, 10, 30], {}, 'not-a-date']) {
    const res = await api('PUT', `/api/obligations/${created.data._id}`, { token, body: { dueDate: bad } });
    assert.equal(res.status, 400, `dueDate ${JSON.stringify(bad)} must be refused on PUT`);
    assert.match(res.data.message, /valid due date/i);
  }

  const stored = await Obligation.findById(created.data._id);
  assert.equal(
    stored.dueDate.toISOString(),
    '2026-11-30T00:00:00.000Z',
    'the original due date must survive every rejected attempt'
  );

  const good = await api('PUT', `/api/obligations/${created.data._id}`, { token, body: { dueDate: '2026-12-15' } });
  assert.equal(good.status, 200, 'a legitimate reschedule still works');
});

test('the milestone route rejects the same coerced due dates', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const base = { title: 'Milestone type check', contract: String(contract._id), assignedTo: String(admin._id) };

  const bad = await api('POST', '/api/milestones', { token, body: { ...base, dueDate: true } });
  assert.equal(bad.status, 400, 'milestones share the obligation due-date defect and the same fix');

  const array = await api('POST', '/api/milestones', { token, body: { ...base, dueDate: [2026, 10, 30] } });
  assert.equal(array.status, 400);

  const good = await api('POST', '/api/milestones', { token, body: { ...base, dueDate: '2026-11-30' } });
  assert.equal(good.status, 201);
});

test('a stored due date is always UTC midnight when it came from a date input', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const res = await api('POST', '/api/obligations', {
    token, body: { title: 'Calendar date', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.dueDate, '2026-11-30T00:00:00.000Z', 'YYYY-MM-DD must mean UTC midnight');
});

/* ------------------------------------------------------------------ *
 * The transition matrix the workflow depends on
 * ------------------------------------------------------------------ */

test('the transition matrix matches the audited workflow', () => {
  assert.equal(canTransitionItem('Pending', 'In Progress'), true, 'Start');
  assert.equal(canTransitionItem('Pending', 'Completed'), true, 'Complete');
  assert.equal(canTransitionItem('In Progress', 'Completed'), true, 'Complete');
  assert.equal(canTransitionItem('In Progress', 'Pending'), true, 'revert to Pending');
  assert.equal(canTransitionItem('Completed', 'In Progress'), true, 'Reopen');
  assert.equal(canTransitionItem('Overdue', 'In Progress'), true, 'Start an overdue obligation');
  assert.equal(canTransitionItem('Overdue', 'Completed'), true, 'Close out an overdue obligation');

  assert.equal(canTransitionItem('Completed', 'Overdue'), false, 'a completed obligation is never re-overdue');
  assert.equal(canTransitionItem('Pending', 'Unknown'), false);
  assert.equal(canTransitionItem('Unknown', 'Pending'), false);
});

test('the server enforces the transition matrix end to end', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/obligations', {
    token, body: { title: 'Matrix', contract: String(contract._id), assignedTo: String(admin._id), dueDate: utcDay(30) }
  });
  const id = created.data._id;

  const walk = async (status) => {
    const res = await api('PUT', `/api/obligations/${id}`, { token, body: { status } });
    const doc = await Obligation.findById(id);
    return { code: res.status, now: doc.status };
  };

  assert.deepEqual(await walk('In Progress'), { code: 200, now: 'In Progress' });
  assert.deepEqual(await walk('Completed'), { code: 200, now: 'Completed' });
  assert.deepEqual(await walk('In Progress'), { code: 200, now: 'In Progress' });
  assert.deepEqual(await walk('Pending'), { code: 200, now: 'Pending' });
  assert.deepEqual(await walk('Overdue'), { code: 200, now: 'Overdue' });
  assert.deepEqual(await walk('Completed'), { code: 200, now: 'Completed' });

  const reOverdue = await api('PUT', `/api/obligations/${id}`, { token, body: { status: 'Overdue' } });
  assert.equal(reOverdue.status, 400, 'a completed obligation must not go back to Overdue');
  assert.match(reOverdue.data.message, /cannot change status/i);

  for (const bad of ['Done', 'completed', '', null, 123]) {
    const res = await api('PUT', `/api/obligations/${id}`, { token, body: { status: bad } });
    assert.equal(res.status, 400, `status ${JSON.stringify(bad)} must be refused`);
    assert.match(res.data.message, /invalid obligation status/i);
  }

  const empty = await api('PUT', `/api/obligations/${id}`, { token, body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.data.message, /no updatable fields/i);
});

test('an obligation cannot be moved to a different contract', async () => {
  const admin = await createUser({ role: 'Admin' });
  const a = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const b = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/obligations', {
    token, body: { title: 'Pinned', contract: String(a._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });

  const res = await api('PUT', `/api/obligations/${created.data._id}`, { token, body: { contract: String(b._id) } });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /cannot be moved to a different contract/i);

  const stored = await Obligation.findById(created.data._id);
  assert.equal(stored.contract.toString(), a._id.toString());

  const same = await api('PUT', `/api/obligations/${created.data._id}`, { token, body: { contract: String(a._id) } });
  assert.equal(same.status, 400, 'naming the same contract is still a no-op and must not pass as an update');
});

/* ------------------------------------------------------------------ *
 * Who may do what
 * ------------------------------------------------------------------ */

test('an assignee may advance their own obligation but nothing else', async () => {
  const employee = await createUser({ role: 'Employee' });
  const other = await createUser({ role: 'Employee' });
  const manager = await createUser({ role: 'Manager' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: employee._id });

  const created = await api('POST', '/api/obligations', {
    token: signToken(manager),
    body: { title: 'Assigned work', contract: String(contract._id), assignedTo: String(employee._id), dueDate: '2026-11-30' }
  });
  const id = created.data._id;
  const mine = signToken(employee);
  const theirs = signToken(other);

  assert.equal((await api('PUT', `/api/obligations/${id}`, { token: mine, body: { status: 'In Progress' } })).status, 200);
  assert.equal((await api('PUT', `/api/obligations/${id}`, { token: mine, body: { title: 'Mine now' } })).status, 403, 'details are privileged');
  assert.equal((await api('PUT', `/api/obligations/${id}`, { token: mine, body: { assignedTo: String(other._id) } })).status, 403, 'reassignment is privileged');
  assert.equal((await api('PUT', `/api/obligations/${id}`, { token: theirs, body: { status: 'Completed' } })).status, 403, 'not your obligation');
  assert.equal((await api('GET', `/api/obligations/${id}`, { token: theirs })).status, 403);
  assert.equal((await api('GET', '/api/obligations', { token: theirs })).data.length, 0, 'the list is assignee-scoped');
});

test('creation is Admin/Manager only and unauthenticated traffic is rejected', async () => {
  const manager = await createUser({ role: 'Manager' });
  const employee = await createUser({ role: 'Employee' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: employee._id });
  const body = { title: 'Role gate', contract: String(contract._id), assignedTo: String(employee._id), dueDate: '2026-11-30' };

  assert.equal((await api('POST', '/api/obligations', { token: signToken(manager), body })).status, 201);
  assert.equal((await api('POST', '/api/obligations', { token: signToken(employee), body })).status, 403);
  assert.equal((await api('POST', '/api/obligations', { body })).status, 401);
  assert.equal((await api('GET', '/api/obligations')).status, 401);
  assert.equal((await api('GET', '/api/obligations/not-an-id', { token: signToken(manager) })).status, 400);
  assert.equal((await api('GET', `/api/obligations/${new mongoose.Types.ObjectId()}`, { token: signToken(manager) })).status, 404);
});

test('a forged Admin claim in the token buys nothing', async () => {
  const employee = await createUser({ role: 'Employee' });
  const manager = await createUser({ role: 'Manager' });
  const contract = await createContract({ createdBy: manager._id, assignedUser: manager._id });
  const created = await api('POST', '/api/obligations', {
    token: signToken(manager),
    body: { title: 'Guarded', contract: String(contract._id), assignedTo: String(manager._id), dueDate: '2026-11-30' }
  });

  const forged = signToken(employee, { role: 'Admin' });
  assert.equal((await api('GET', `/api/obligations/${created.data._id}`, { token: forged })).status, 403);
  assert.equal((await api('PUT', `/api/obligations/${created.data._id}`, { token: forged, body: { title: 'Hacked' } })).status, 403);
});

/* ------------------------------------------------------------------ *
 * Archived contracts
 * ------------------------------------------------------------------ */

test('an archived contract freezes obligation details but not the status', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const created = await api('POST', '/api/obligations', {
    token, body: { title: 'Before archive', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  const id = created.data._id;

  await Contract.updateOne({ _id: contract._id }, { $set: { isArchived: true } });

  const blocked = await api('POST', '/api/obligations', {
    token, body: { title: 'Too late', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /archived contract/i);

  for (const body of [{ title: 'Renamed' }, { dueDate: '2027-01-01' }, { assignedTo: String(admin._id) }]) {
    const res = await api('PUT', `/api/obligations/${id}`, { token, body });
    assert.equal(res.status, 400, `${Object.keys(body)[0]} must be frozen`);
    assert.match(res.data.message, /archived contract/i);
  }

  const advance = await api('PUT', `/api/obligations/${id}`, { token, body: { status: 'In Progress' } });
  assert.equal(advance.status, 200, 'work already on an archived contract can still be closed out');
});

/* ------------------------------------------------------------------ *
 * The shared helper directly
 * ------------------------------------------------------------------ */

test('applyItemUpdate trims titles and refuses an empty one', async () => {
  const admin = await createUser({ role: 'Admin' });
  const obligation = { title: 'x', assignedTo: admin._id, status: 'Pending' };

  const trimmed = await applyItemUpdate({
    req: { user: admin, body: { title: '  Spaced out  ' } }, item: obligation, contract: null, label: 'obligation'
  });
  assert.deepEqual(trimmed, { changes: ['title'] });
  assert.equal(obligation.title, 'Spaced out');

  const blank = await applyItemUpdate({
    req: { user: admin, body: { title: '   ' } }, item: obligation, contract: null, label: 'obligation'
  });
  assert.equal(blank.error.status, 400);
  assert.match(blank.error.message, /title cannot be empty/i);
});

test('applyItemUpdate detail editing fails closed for an unknown role', async () => {
  // The User schema restricts `role` to its enum, so an account carrying an
  // unrecognised role cannot be created through the API - which is exactly the
  // point: the helper must not depend on the enum to stay safe.
  const owner = { _id: new mongoose.Types.ObjectId(), role: 'Something New' };
  const obligation = { title: 'x', assignedTo: owner._id, status: 'Pending' };

  const res = await applyItemUpdate({
    req: { user: owner, body: { title: 'Renamed' } }, item: obligation, contract: null, label: 'obligation'
  });
  assert.equal(res.error.status, 403, 'a role that is not Admin/Manager gets the Employee branch, never the privileged one');
  assert.equal(obligation.title, 'x');
});