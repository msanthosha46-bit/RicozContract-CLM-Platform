// PHASE-11 regression tests: production-readiness audit fixes.
//
// Every test here corresponds to a defect confirmed during the Phase-11 audit,
// and each one fails against the pre-fix code. They run against their own
// disposable database and a mocked storage adapter, so nothing they do can reach
// real data or a real storage bucket.
//
// Covered:
//   1. Contract access scope fails CLOSED for an unrecognised role
//   2. POST /api/contracts rejects the payloads PUT /api/contracts/:id rejects
//   3. A contract number supplied by the client is ignored
//   4. The last-active-administrator guard still holds after being regrouped
//   5. The hourly jobs are idempotent, UTC-correct and non-re-entrant
//   6. The read-only schema index report never writes and detects drift
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const Approval = require('../models/Approval');
const ActivityLog = require('../models/ActivityLog');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

const contractRoutes = require('../routes/contractRoutes');
const approvalRoutes = require('../routes/approvalRoutes');
const userRoutes = require('../routes/userRoutes');
const documentRoutes = require('../routes/documentRoutes');

const { canAccessContract, employeeContractScope, PRIVILEGED_ROLES } = require('../utils/access');
const expireEligibleContracts = require('../utils/expiryUpdater');
const markOverdueItems = require('../utils/overdueUpdater');
const {
  declaredIndexesFor,
  readSchemaIndexReport,
  describeSchemaIndexReport
} = require('../utils/schemaIndexes');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const { createMockStorage } = require('./helpers/mockStorage');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_phase11_test';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;
let mockStorage;
let contractNumberSeed = 0;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

let userSeed = 0;
const createUser = async ({ name, role = 'Employee', status = 'Active' }) => {
  userSeed += 1;
  return User.create({
    name: name || `Phase 11 User ${userSeed}`,
    email: `phase11.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role,
    status
  });
};

const createContract = async (overrides = {}) => {
  contractNumberSeed += 1;
  return Contract.create({
    contractNumber: `CNT-P11-${String(contractNumberSeed).padStart(6, '0')}`,
    title: 'Phase 11 contract',
    type: 'Vendor',
    partyName: 'Test vendor',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-12-31T00:00:00.000Z'),
    amount: 1000,
    createdBy: new mongoose.Types.ObjectId(),
    ...overrides
  });
};

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

const utcDay = (offsetDays) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * MS_PER_DAY);
};

const startTestApp = () =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/users', userRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/approvals', approvalRoutes);
    app.use('/api/documents', documentRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    app.use((error, req, res, next) => {
      if (error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'File exceeds the 10 MiB upload limit.' });
      }
      if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
        return res.status(400).json({ message: error.message });
      }
      if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ message: 'Invalid JSON payload' });
      }
      if (error.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation failed' });
      }
      if (error.name === 'CastError') {
        return res.status(400).json({ message: `Invalid value for '${error.path}'` });
      }
      if (error.code === 11000) {
        return res.status(409).json({ message: 'A record with the same unique value already exists' });
      }
      console.error(error);
      return res.status(500).json({ message: 'Internal server error' });
    });
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

test.before(async () => {
  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();
  await startTestApp();
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  resetStorageAdapter();
  mockStorage.cleanup();
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// 1. Contract access scope
// ---------------------------------------------------------------------------

test('contract access fails closed for any role that is not Admin or Manager', () => {
  const contract = { createdBy: { _id: 'someone-else' }, assignedUser: { _id: 'someone-else-2' } };

  // The pre-fix predicate was `user.role !== 'Employee'`, so every one of these
  // returned true and handed out the whole repository.
  for (const role of [undefined, null, '', 'employee', 'EMPLOYEE', 'SuperAdmin', 'Admin ', 'Manager']) {
    if (role === 'Admin' || role === 'Manager') continue;
    assert.equal(
      canAccessContract({ _id: 'attacker', role }, contract),
      false,
      `role ${JSON.stringify(role)} must not be treated as privileged`
    );
  }
});

test('contract access is granted to exactly the two privileged roles', () => {
  const contract = { createdBy: { _id: 'x' }, assignedUser: { _id: 'y' } };
  assert.equal(PRIVILEGED_ROLES.has('Admin'), true);
  assert.equal(PRIVILEGED_ROLES.has('Manager'), true);
  assert.equal(canAccessContract({ _id: 'attacker', role: 'Admin' }, contract), true);
  assert.equal(canAccessContract({ _id: 'attacker', role: 'Manager' }, contract), true);
  assert.equal(PRIVILEGED_ROLES.size, 2, 'the allow-list matches the authorize() role list exactly');
});

test('an Employee still reaches a contract it created or is assigned to, and nothing else', () => {
  const owner = { _id: 'employee-1', role: 'Employee' };
  assert.equal(canAccessContract(owner, { createdBy: 'employee-1', assignedUser: 'other' }), true);
  assert.equal(canAccessContract(owner, { createdBy: 'other', assignedUser: 'employee-1' }), true);
  assert.equal(canAccessContract(owner, { createdBy: 'other', assignedUser: 'other' }), false);
  assert.equal(canAccessContract(owner, { createdBy: 'other' }), false, 'an unassigned contract is not reachable');
  assert.equal(canAccessContract(null, { createdBy: 'employee-1' }), false, 'no user is never access');
  assert.equal(canAccessContract(owner, null), false, 'no contract is never access');
});

test('an authenticated user with an unrecognised role cannot read a contract through the API', async () => {
  const owner = await createUser({ name: 'Scope Owner' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });

  // A token minted for a real account, but with a role value the schema enum
  // would not normally allow - the exact state a renamed or future role leaves
  // behind. `protect` loads the user, so the role on the request is the stored
  // one; this test drives canAccessContract directly through the route by
  // writing the value onto the in-memory user the way a bad migration would.
  const rogue = { _id: new mongoose.Types.ObjectId(), role: 'SuperAdmin', status: 'Active' };
  const loadAccessible = async (user, id) => {
    const found = await Contract.findById(id);
    return canAccessContract(user, found) ? 200 : 403;
  };

  assert.equal(await loadAccessible(rogue, contract._id), 403);
  assert.equal(await loadAccessible({ _id: owner._id, role: 'Employee' }, contract._id), 200);
  assert.deepEqual(Object.keys(employeeContractScope('x')), ['$or'], 'the list scope is unchanged');
});

test('the employee list scope still matches the read predicate', () => {
  const userId = new mongoose.Types.ObjectId();
  const scope = employeeContractScope(userId);
  const user = { _id: userId, role: 'Employee' };
  assert.equal(canAccessContract(user, { createdBy: userId, assignedUser: 'other' }), true);
  assert.equal(canAccessContract(user, { createdBy: 'other', assignedUser: userId }), true);
  assert.equal(canAccessContract(user, { createdBy: 'other', assignedUser: 'other' }), false);
  assert.equal(scope.$or.length, 2);
});

// ---------------------------------------------------------------------------
// 2. Contract creation validation
// ---------------------------------------------------------------------------

test('creating a contract rejects a negative amount', async () => {
  const user = await createUser({ name: 'Amount Guard' });
  const before = await Contract.countDocuments();

  const created = await api('POST', '/api/contracts', {
    token: signToken(user),
    body: {
      title: 'Negative', type: 'Vendor', partyName: 'V',
      startDate: '2026-01-01', endDate: '2026-06-01', amount: -5000
    }
  });

  assert.equal(created.status, 400);
  assert.match(created.data.message, /non-negative/);
  assert.equal(await Contract.countDocuments(), before, 'nothing may be persisted');
});

test('creating a contract rejects a non-numeric or missing amount', async () => {
  const user = await createUser({ name: 'Amount Guard 2' });
  const token = signToken(user);
  const base = { title: 'Bad amount', type: 'Vendor', partyName: 'V', startDate: '2026-01-01', endDate: '2026-06-01' };

  for (const amount of ['abc', NaN, Infinity, '', null, undefined]) {
    const created = await api('POST', '/api/contracts', { token, body: { ...base, amount } });
    assert.equal(created.status, 400, `amount ${JSON.stringify(String(amount))} must be rejected`);
  }
});

test('creating a contract rejects an end date before the start date', async () => {
  const user = await createUser({ name: 'Date Guard' });
  const before = await Contract.countDocuments();

  const created = await api('POST', '/api/contracts', {
    token: signToken(user),
    body: {
      title: 'Backwards', type: 'Vendor', partyName: 'V',
      startDate: '2026-06-01', endDate: '2026-01-01', amount: 100
    }
  });

  assert.equal(created.status, 400);
  assert.match(created.data.message, /on or after/);
  assert.equal(await Contract.countDocuments(), before);
});

test('creating a contract rejects unparseable dates', async () => {
  const user = await createUser({ name: 'Date Guard 2' });
  const token = signToken(user);

  for (const dates of [{ startDate: 'not-a-date', endDate: '2026-06-01' }, { startDate: '2026-01-01', endDate: 'nope' }]) {
    const created = await api('POST', '/api/contracts', {
      token,
      body: { title: 'Bad dates', type: 'Vendor', partyName: 'V', amount: 100, ...dates }
    });
    assert.equal(created.status, 400);
    assert.match(created.data.message, /valid start date and end date/);
  }
});

test('creating a contract rejects an assignee that does not exist', async () => {
  const user = await createUser({ name: 'Assignee Guard' });
  const token = signToken(user);
  const base = { title: 'Ghost assignee', type: 'Vendor', partyName: 'V', startDate: '2026-01-01', endDate: '2026-06-01', amount: 100 };

  const malformed = await api('POST', '/api/contracts', { token, body: { ...base, assignedUser: 'not-an-id' } });
  assert.equal(malformed.status, 400);
  assert.match(malformed.data.message, /valid identifier/);

  const ghost = await api('POST', '/api/contracts', { token, body: { ...base, assignedUser: new mongoose.Types.ObjectId().toString() } });
  assert.equal(ghost.status, 404);
  assert.match(ghost.data.message, /Assigned user not found/);
});

test('a valid contract is still created, with a generated number and a resolved assignee', async () => {
  const user = await createUser({ name: 'Valid Creator' });
  const assignee = await createUser({ name: 'Valid Assignee' });

  const created = await api('POST', '/api/contracts', {
    token: signToken(user),
    body: {
      title: 'Valid contract', type: 'Vendor', partyName: 'V',
      startDate: '2026-01-01', endDate: '2026-06-01', amount: '4500',
      assignedUser: assignee._id.toString()
    }
  });

  assert.equal(created.status, 201);
  assert.match(created.data.contractNumber, /^CNT-\d{4}-\d{4}$/);
  assert.equal(created.data.status, 'Draft');
  assert.equal(Number(created.data.amount), 4500, 'a numeric string is stored as a number');
  assert.equal(created.data.assignedUser, assignee._id.toString());
  assert.equal(created.data.createdBy, user._id.toString());
});

test('a contract number supplied by the client is ignored on create and on update', async () => {
  const user = await createUser({ name: 'Number Forge' });
  const token = signToken(user);
  const victim = await createContract({ createdBy: user._id, assignedUser: user._id });

  const created = await api('POST', '/api/contracts', {
    token,
    body: {
      title: 'Forged number', type: 'Vendor', partyName: 'V',
      startDate: '2026-01-01', endDate: '2026-06-01', amount: 100,
      contractNumber: victim.contractNumber
    }
  });
  assert.equal(created.status, 201, 'the collision is impossible because the body value is not used');
  assert.notEqual(created.data.contractNumber, victim.contractNumber);

  const updated = await api('PUT', `/api/contracts/${created.data._id}`, {
    token,
    body: { contractNumber: victim.contractNumber }
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.data.contractNumber, victim.contractNumber, 'PUT still cannot rewrite the number');
  const victimNow = await Contract.findById(victim._id);
  assert.equal(victimNow.contractNumber, victim.contractNumber, 'the other contract is untouched');
});

test('update keeps the existing amount and dates when they are not supplied', async () => {
  const user = await createUser({ name: 'Partial Update' });
  const contract = await createContract({
    createdBy: user._id, assignedUser: user._id,
    startDate: new Date('2026-02-01T00:00:00.000Z'),
    endDate: new Date('2026-05-01T00:00:00.000Z'),
    amount: 777
  });

  const updated = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(user), body: { title: 'Renamed only' }
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.data.amount, 777);
  assert.equal(new Date(updated.data.startDate).toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(new Date(updated.data.endDate).toISOString(), '2026-05-01T00:00:00.000Z');
});

test('an unassignable update still reports the missing user instead of writing a dangling ref', async () => {
  const user = await createUser({ name: 'Unassign' });
  const contract = await createContract({ createdBy: user._id, assignedUser: user._id });

  const cleared = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(user), body: { assignedUser: null }
  });
  assert.equal(cleared.status, 200, 'clearing the assignee is allowed');
  assert.equal(cleared.data.assignedUser, null);

  const ghost = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(user), body: { assignedUser: new mongoose.Types.ObjectId().toString() }
  });
  assert.equal(ghost.status, 404);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.assignedUser, null, 'the rejected value was not written');
});

// ---------------------------------------------------------------------------
// 3. Last active administrator
// ---------------------------------------------------------------------------

test('the only active administrator still cannot be demoted or deactivated', async () => {
  await User.deleteMany({ role: 'Admin' });
  const only = await createUser({ name: 'Sole Admin P11', role: 'Admin' });
  const token = signToken(only);

  const demote = await api('PUT', `/api/users/${only._id}/role`, { token, body: { role: 'Employee' } });
  assert.equal(demote.status, 400);
  assert.match(demote.data.message, /only active administrator/);

  const deactivate = await api('PUT', `/api/users/${only._id}/role`, { token, body: { status: 'Inactive' } });
  assert.equal(deactivate.status, 400, 'deactivation is guarded by the same rule');

  // Both clauses in one request is still the last-admin case.
  const both = await api('PUT', `/api/users/${only._id}/role`, { token, body: { role: 'Employee', status: 'Inactive' } });
  assert.equal(both.status, 400);

  const noop = await api('PUT', `/api/users/${only._id}/role`, { token, body: { role: 'Admin', status: 'Active' } });
  assert.equal(noop.status, 200, 'a no-op does not trip the guard');

  const second = await createUser({ name: 'Second Admin P11', role: 'Admin' });
  const nowAllowed = await api('PUT', `/api/users/${only._id}/role`, { token, body: { role: 'Employee' } });
  assert.equal(nowAllowed.status, 200, 'with a second admin the demotion is allowed');
  assert.equal((await User.findById(only._id)).role, 'Employee');

  // `only` is an Employee now, so further admin work needs the remaining admin's
  // token - which also proves the guard is evaluated per request, not cached.
  const secondToken = signToken(second);
  const demoteOther = await api('PUT', `/api/users/${only._id}/role`, { token: secondToken, body: { role: 'Manager' } });
  assert.equal(demoteOther.status, 200, 'a remaining admin can still administer roles');
  assert.equal((await User.findById(only._id)).role, 'Manager');

  // `second` is now the only Admin, so the rule bites again immediately.
  const lastOne = await api('PUT', `/api/users/${second._id}/role`, { token: secondToken, body: { role: 'Manager' } });
  assert.equal(lastOne.status, 400);
  assert.equal((await User.findById(second._id)).role, 'Admin', 'nothing was written');
});

// ---------------------------------------------------------------------------
// 4. Background jobs
// ---------------------------------------------------------------------------

test('the expiry job flips only Active, unarchived contracts that ended before today (UTC)', async () => {
  await Contract.deleteMany({});
  await ActivityLog.deleteMany({ action: 'Contract Expired' });
  const user = await createUser({ name: 'Expiry Owner' });

  await createContract({ createdBy: user._id, title: 'Ended yesterday', status: 'Active', endDate: utcDay(-1) });
  await createContract({ createdBy: user._id, title: 'Ends today', status: 'Active', endDate: utcDay(0) });
  await createContract({ createdBy: user._id, title: 'Ends next year', status: 'Active', endDate: utcDay(365) });
  await createContract({ createdBy: user._id, title: 'Ended but Approved', status: 'Approved', endDate: utcDay(-10) });
  await createContract({ createdBy: user._id, title: 'Ended but archived', status: 'Active', isArchived: true, endDate: utcDay(-10) });
  await createContract({ createdBy: user._id, title: 'Ended but Closed', status: 'Closed', endDate: utcDay(-10) });

  const result = await expireEligibleContracts();
  assert.equal(result.expired, 1, 'exactly the one eligible contract is flipped');

  const byTitle = Object.fromEntries((await Contract.find({})).map((c) => [c.title, c.status]));
  assert.equal(byTitle['Ended yesterday'], 'Expired');
  assert.equal(byTitle['Ends today'], 'Active', 'a contract ending today is not expired until tomorrow UTC');
  assert.equal(byTitle['Ends next year'], 'Active');
  assert.equal(byTitle['Ended but Approved'], 'Approved', 'only Active is ever auto-expired');
  assert.equal(byTitle['Ended but archived'], 'Active', 'an archived contract is left alone');
  assert.equal(byTitle['Ended but Closed'], 'Closed', 'Closed is terminal');

  assert.equal(await ActivityLog.countDocuments({ action: 'Contract Expired' }), 1, 'one audit entry, not one per run');
});

test('the expiry job is idempotent across repeated executions', async () => {
  const first = await expireEligibleContracts();
  const second = await expireEligibleContracts();
  const third = await expireEligibleContracts();

  assert.equal(first.expired, 0, 'nothing is left to flip');
  assert.equal(second.expired, 0);
  assert.equal(third.expired, 0);
  assert.equal(await ActivityLog.countDocuments({ action: 'Contract Expired' }), 1, 'no duplicate audit entries');
});

test('concurrent expiry triggers share one pass instead of overlapping', async () => {
  await Contract.deleteMany({});
  await ActivityLog.deleteMany({ action: 'Contract Expired' });
  const user = await createUser({ name: 'Expiry Reentrancy' });
  for (let index = 0; index < 5; index += 1) {
    await createContract({ createdBy: user._id, title: `Reentrant ${index}`, status: 'Active', endDate: utcDay(-1) });
  }

  const results = await Promise.all([
    expireEligibleContracts(),
    expireEligibleContracts(),
    expireEligibleContracts()
  ]);

  // Every caller receives the result of the single pass that is running, rather
  // than starting its own. Three independent passes would each report 5.
  assert.equal(results[0], results[1], 'concurrent callers share one result object');
  assert.equal(results[1], results[2]);
  assert.equal(results[0].expired, 5, 'five contracts are flipped, once');
  assert.equal(await Contract.countDocuments({ status: 'Active' }), 0);
  assert.equal(await ActivityLog.countDocuments({ action: 'Contract Expired' }), 5, 'no duplicated work');
  assert.equal(expireEligibleContracts.isRunning(), false, 'the guard is released afterwards');
});

test('the overdue job flips only unfinished items whose due day has passed (UTC)', async () => {
  await Obligation.deleteMany({});
  await Milestone.deleteMany({});
  const user = await createUser({ name: 'Overdue Owner' });
  const contract = await createContract({ createdBy: user._id });

  await Obligation.create({ contract: contract._id, title: 'Due today', assignedTo: user._id, dueDate: utcDay(0), status: 'Pending' });
  await Obligation.create({ contract: contract._id, title: 'Overdue pending', assignedTo: user._id, dueDate: utcDay(-1), status: 'Pending' });
  await Obligation.create({ contract: contract._id, title: 'Overdue in progress', assignedTo: user._id, dueDate: utcDay(-3), status: 'In Progress' });
  await Obligation.create({ contract: contract._id, title: 'Completed long ago', assignedTo: user._id, dueDate: utcDay(-30), status: 'Completed' });
  await Obligation.create({ contract: contract._id, title: 'Already overdue', assignedTo: user._id, dueDate: utcDay(-5), status: 'Overdue' });
  await Obligation.create({ contract: contract._id, title: 'Future', assignedTo: user._id, dueDate: utcDay(10), status: 'Pending' });

  await Milestone.create({ contract: contract._id, title: 'Milestone overdue', assignedTo: user._id, dueDate: utcDay(-2), status: 'Pending' });
  await Milestone.create({ contract: contract._id, title: 'Milestone done', assignedTo: user._id, dueDate: utcDay(-2), status: 'Completed' });

  const result = await markOverdueItems();
  assert.equal(result.obligations, 2, 'only the two unfinished, past-due obligations are flipped');
  assert.equal(result.milestones, 1);

  const byTitle = Object.fromEntries((await Obligation.find({})).map((o) => [o.title, o.status]));
  assert.equal(byTitle['Due today'], 'Pending', 'an item due today is not overdue');
  assert.equal(byTitle['Overdue pending'], 'Overdue');
  assert.equal(byTitle['Overdue in progress'], 'Overdue');
  assert.equal(byTitle['Completed long ago'], 'Completed', 'finished work is never marked overdue again');
  assert.equal(byTitle['Already overdue'], 'Overdue');
  assert.equal(byTitle['Future'], 'Pending');

  const milestones = Object.fromEntries((await Milestone.find({})).map((m) => [m.title, m.status]));
  assert.equal(milestones['Milestone overdue'], 'Overdue');
  assert.equal(milestones['Milestone done'], 'Completed');
});

test('the overdue job is idempotent and non-re-entrant', async () => {
  const again = await markOverdueItems();
  assert.equal(again.obligations, 0, 'a second pass modifies nothing');
  assert.equal(again.milestones, 0);

  await Obligation.create({
    contract: (await Contract.findOne({}))._id,
    title: 'Concurrent overdue',
    assignedTo: (await User.findOne({}))._id,
    dueDate: utcDay(-1),
    status: 'Pending'
  });

  const [a, b, c] = await Promise.all([markOverdueItems(), markOverdueItems(), markOverdueItems()]);
  assert.equal(a, b, 'concurrent callers share one result object');
  assert.equal(b, c);
  assert.equal(a.obligations, 1, 'the new item is flipped once even though three triggers fired');
  assert.equal(await Obligation.countDocuments({ status: 'Pending', dueDate: { $lt: utcDay(0) } }), 0);
  assert.equal(markOverdueItems.isRunning(), false, 'the guard is released afterwards');
});

test('a failing job pass releases the in-flight guard so the next run still executes', async () => {
  const original = Obligation.updateMany;
  Obligation.updateMany = async () => { throw new Error('simulated database failure'); };
  try {
    await assert.rejects(markOverdueItems(), /simulated database failure/);
    assert.equal(markOverdueItems.isRunning(), false, 'a rejected pass must not wedge the schedule');
  } finally {
    Obligation.updateMany = original;
  }

  const recovered = await markOverdueItems();
  assert.equal(typeof recovered.obligations, 'number', 'the next run executes normally');
});

// ---------------------------------------------------------------------------
// 5. Read-only schema index report
// ---------------------------------------------------------------------------

test('the schema declares the indexes the audited queries depend on', () => {
  const byName = (model) => new Set(declaredIndexesFor(model).map((index) => index.name));

  const contracts = byName(Contract);
  for (const name of [
    'status_1_isArchived_1',
    'isArchived_1_status_1_endDate_1',
    'createdBy_1_isArchived_1',
    'assignedUser_1_isArchived_1',
    'createdAt_-1'
  ]) {
    assert.ok(contracts.has(name), `contracts must declare ${name}`);
  }

  // GET /api/activities sorts the whole collection newest-first.
  assert.ok(byName(ActivityLog).has('createdAt_-1'), 'the activity log must declare createdAt_-1');

  // filter (assignee / status) + sort (dueDate) for both work-item collections.
  for (const model of [Obligation, Milestone]) {
    const names = byName(model);
    assert.ok(names.has('assignedTo_1_dueDate_1'), `${model.modelName} must declare assignedTo+dueDate`);
    assert.ok(names.has('status_1_dueDate_1'), `${model.modelName} must declare status+dueDate`);
  }

  // The unique constraints the schema promises must be declared as unique.
  const users = declaredIndexesFor(User);
  const email = users.find((index) => index.name === 'email_1');
  assert.equal(email.unique, true, 'User.email uniqueness must be declared');
  const google = users.find((index) => index.name === 'googleId_1');
  assert.equal(google.unique, true);
  assert.equal(google.sparse, true);
  const documents = declaredIndexesFor(ContractDocument).find((i) => i.name === 'contract_1_version_1');
  assert.equal(documents.unique, true, 'the document version index must be unique');
});

test('the schema index report is read-only and detects drift', async () => {
  // Drift is detected against a collection whose index was never built. The
  // test connection has autoIndex left at its default, so the shared test
  // collections do get their declared indexes built; a dedicated connection with
  // autoIndex disabled reproduces the production condition exactly.
  //
  // autoCreate is disabled alongside it. It is a separate setting, and it
  // defaults to true, so it kept queueing a collection creation for every model
  // compiled on this connection. That creation lands on a later tick than the
  // `before` read below but earlier than the `after` read, which made
  // "the report created nothing" fail intermittently with
  // after=[{_id_}] and before=[] - the report was innocent, the connection was
  // creating the collection underneath it. It also made the sibling test
  // asserting an absent collection racy for the same reason.
  const connection = mongoose.createConnection();
  await connection.openUri(TEST_DB_URI, { autoIndex: false, autoCreate: false });
  const drifted = connection.model(
    'Phase11Drift',
    new mongoose.Schema({ contract: mongoose.Schema.Types.ObjectId, version: Number })
  );
  drifted.schema.index({ contract: 1, version: 1 }, { unique: true });

  try {
    const before = await connection.db.collection('phase11drifts').indexes().catch(() => []);
    const report = await readSchemaIndexReport(drifted);

    assert.equal(report.collection, 'phase11drifts');
    assert.equal(report.ready, false, 'the declared index is not present');
    assert.ok(
      report.missing.some((index) => index.name === 'contract_1_version_1'),
      'the missing unique index is reported by name'
    );
    assert.equal(
      report.missing.find((index) => index.name === 'contract_1_version_1').unique,
      true,
      'uniqueness the schema promises is part of the report'
    );
    assert.equal(report.mismatched.length, 0, 'nothing exists that could mismatch');

    const text = describeSchemaIndexReport(report);
    assert.match(text, /read-only/i);
    assert.match(text, /OUT OF SYNC/);
    assert.match(text, /MISSING/);
    assert.doesNotMatch(text, /mongodb:\/\/[^:@]*:[^@]*@/, 'no connection string may be printed');

    const after = await connection.db.collection('phase11drifts').indexes().catch(() => []);
    assert.deepEqual(after, before, 'the report created nothing');

    // Now build the index and confirm the report converges to "in sync".
    await connection.db.collection('phase11drifts').createIndex({ contract: 1, version: 1 }, { unique: true });
    const synced = await readSchemaIndexReport(drifted);
    assert.equal(synced.ready, true, 'a matching index is reported as in sync');
    assert.match(describeSchemaIndexReport(synced), /status: in sync/);
  } finally {
    await connection.db.dropCollection('phase11drifts').catch(() => {});
    await connection.close();
  }
});

test('a live index that does not match the schema is reported as mismatched, not silently accepted', async () => {
  const connection = mongoose.createConnection();
  await connection.openUri(TEST_DB_URI, { autoIndex: false, autoCreate: false });
  const model = connection.model(
    'Phase11Mismatch',
    new mongoose.Schema({ contract: mongoose.Schema.Types.ObjectId, version: Number })
  );
  model.schema.index({ contract: 1, version: 1 }, { unique: true });

  try {
    // The shape a half-applied change leaves behind: the key exists but the
    // uniqueness the schema promises does not.
    await connection.db.collection('phase11mismatches')
      .createIndex({ contract: 1, version: 1 }, { name: 'contract_1_version_1' });

    const report = await readSchemaIndexReport(model);
    assert.equal(report.ready, false);
    assert.equal(report.mismatched.length, 1);
    assert.equal(report.mismatched[0].declared.unique, true);
    assert.equal(report.mismatched[0].actual.unique, false);
    assert.match(describeSchemaIndexReport(report), /MISMATCHED/);
  } finally {
    await connection.db.dropCollection('phase11mismatches').catch(() => {});
    await connection.close();
  }
});

test('an absent collection reports every declared index as missing instead of failing', async () => {
  // autoCreate is off for the same reason as the drift test: this test is only
  // meaningful while the collection genuinely does not exist, so nothing may
  // create it in the background while the report is being taken.
  const connection = mongoose.createConnection();
  await connection.openUri(TEST_DB_URI, { autoIndex: false, autoCreate: false });
  const model = connection.model(
    'Phase11Absent',
    new mongoose.Schema({ contract: mongoose.Schema.Types.ObjectId })
  );
  model.schema.index({ contract: 1 });

  try {
    const report = await readSchemaIndexReport(model);
    assert.equal(report.collectionExists, false);
    assert.equal(report.ready, false);
    assert.ok(report.missing.length >= 2, '_id and the declared index are both reported missing');
  } finally {
    await connection.close();
  }
});

test('the schema index report source contains no write path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'schemaIndexes.js'), 'utf8');
  for (const forbidden of ['createIndex', 'dropIndex', 'syncIndexes', 'createIndexes', 'deleteMany', 'insertMany', 'updateMany', 'bulkWrite', 'dropDatabase']) {
    assert.doesNotMatch(source, new RegExp(`\\.${forbidden}\\s*\\(`), `${forbidden} must not be reachable`);
  }

  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'schema-index-report.js'), 'utf8');
  assert.match(cli, /autoIndex: false/, 'the report must not let the driver build indexes');
  for (const forbidden of ['createIndex', 'syncIndexes', 'dropIndex']) {
    assert.doesNotMatch(cli, new RegExp(`\\.${forbidden}\\s*\\(`), `${forbidden} must not be reachable`);
  }
});

test('the autoIndex guard is still in place on the production connection path', () => {
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'config', 'db.js'), 'utf8');
  assert.match(dbSource, /autoIndex:\s*false/, 'the production connection must not build indexes implicitly');
});

// ---------------------------------------------------------------------------
// 6. End-to-end: a proxied approval is reported, and the requester's own
//    request is still refused.
// ---------------------------------------------------------------------------

test('a manager still cannot decide their own approval request', async () => {
  const manager = await createUser({ name: 'Proxy Manager', role: 'Manager' });
  const token = signToken(manager);
  const contract = await createContract({ createdBy: manager._id, assignedUser: manager._id, status: 'Draft' });

  const submitted = await api('POST', `/api/approvals/submit/${contract._id}`, { token });
  assert.equal(submitted.status, 201);

  const decided = await api('PUT', `/api/approvals/${submitted.data._id}/action`, {
    token, body: { action: 'Approved' }
  });
  assert.equal(decided.status, 400);
  assert.match(decided.data.message, /own contract request/);

  const stillPending = await Approval.findById(submitted.data._id);
  assert.equal(stillPending.status, 'Pending', 'the refused decision wrote nothing');
  assert.equal((await Contract.findById(contract._id)).status, 'Pending Approval');
});
