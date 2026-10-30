// RicozContract R2 - who may move a contract's assignee, what is recorded when
// they do, and who is told.
//
// WHAT THIS COVERS
// ----------------
// The assignee of a contract decides who works it and who can open it, so
// moving it is a management act rather than an editing act. Before R2 the
// assignee could be moved by anybody who could open the contract, so an
// assigned Employee could hand a contract to somebody else on a Draft and
// lose sight of it at the same time - and nothing in the log said that a
// handover had happened.
//
// The cases below defend four things at once:
//
//   1. AUTHORITY. Only an administrator or a manager may move the assignee, on
//      every status. A refused attempt changes nothing: not the assignment,
//      not anybody's access, not the log, and it sends no notification.
//   2. THE EDIT LOCK. It is unchanged. On a locked contract the assignee
//      cannot be changed by anybody, and the answer is still 409 with the
//      amendment route named - the role check must not take that over.
//   3. THE RECORD. A successful handover is logged on its own line, naming the
//      assignee the contract is leaving and the one it is going to.
//   4. THE NOTIFICATION. The new assignee is told through the existing derived
//      feed, and nobody else is. Nothing is persisted, and the id is stable.
//
// Every fixture lives in this file's own disposable database. No production or
// development data is read or written.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const { readFocusedTestConfig } = require('./helpers/testDatabase');
const { mongoUri: TEST_DB_URI, jwtSecret: TEST_JWT_SECRET } = readFocusedTestConfig(process.env, { suiteName: 'assignee' });
process.env.JWT_SECRET = TEST_JWT_SECRET;

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
require('../models/ContractDocument');
const ContractAmendment = require('../models/ContractAmendment');
const ActivityLog = require('../models/ActivityLog');
const contractRoutes = require('../routes/contractRoutes');
const amendmentRoutes = require('../routes/amendmentRoutes');
const notificationRoutes = require('../routes/notificationRoutes');
const { canAssignContract, isPrivileged } = require('../utils/access');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;
let userSeed = 0;

const utcDay = (daysFromToday) => new Date(Date.UTC(
  new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
) + daysFromToday * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  TEST_JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, role = 'Employee', status = 'Active' }) => {
  userSeed += 1;
  return User.create({
    name: name || `Assignee User ${userSeed}`,
    email: `assignee.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role,
    status
  });
};

const makeContract = async ({ createdBy, assignedUser, status = 'Draft', overrides = {} }) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Original title',
  type: 'Vendor',
  partyName: 'Original vendor',
  description: 'Original description',
  startDate: utcDay(-30),
  endDate: utcDay(365),
  amount: 1000,
  currency: 'USD',
  createdBy,
  assignedUser,
  status,
  ...overrides
});

const api = async (method, url, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(baseURL + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { status: response.status, data };
};

const feedOf = async (user) => {
  const feed = await api('GET', '/api/notifications', { token: signToken(user) });
  assert.equal(feed.status, 200);
  return feed.data;
};

const reassignmentItems = (feed) => feed.items.filter((item) => item.type === 'reassignment');

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false, serverSelectionTimeoutMS: 3000 });
  // The amendment queue's one-open-request-per-contract rule is a partial
  // unique index. Create only this required index; syncIndexes could drop
  // indexes and is deliberately not used in the focused test setup.
  await ContractAmendment.collection.createIndex(
    { contract: 1 },
    {
      unique: true,
      partialFilterExpression: { status: 'Pending' },
      name: 'one_pending_amendment_per_contract'
    }
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/contracts', contractRoutes);
  app.use('/api/contract-amendments', amendmentRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use((error, req, res, next) => {
    if (error.name === 'ValidationError') return res.status(400).json({ message: error.message });
    if (error.name === 'CastError') return res.status(400).json({ message: `Invalid value for '${error.path}'` });
    console.error(error);
    return res.status(500).json({ message: 'Internal server error' });
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await ContractAmendment.deleteMany({});
  await ActivityLog.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// 1. Authority: only an administrator or a manager may move the assignee
// ---------------------------------------------------------------------------

test('canAssignContract follows the same allow-list as the route guards', () => {
  const admin = { role: 'Admin' };
  const manager = { role: 'Manager' };
  const employee = { role: 'Employee' };
  const unknown = { role: 'Superuser' };

  assert.equal(canAssignContract(admin), true);
  assert.equal(canAssignContract(manager), true);
  assert.equal(canAssignContract(employee), false);
  // A role that is merely not 'Employee' is not privileged: the check is an
  // allow-list, so it cannot fail open the way a negative check would.
  assert.equal(canAssignContract(unknown), false);
  assert.equal(canAssignContract(null), false);
  assert.equal(canAssignContract({}), false);
  // The two must agree, always: they read the same allow-list.
  for (const user of [admin, manager, employee, unknown, null, {}]) {
    assert.equal(canAssignContract(user), isPrivileged(user));
  }
});

test('an assigned Employee may not move the assignee of a Draft contract', async () => {
  const admin = await createUser({ name: 'Draft Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Current Holder' });
  const stranger = await createUser({ name: 'Wanted Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  const refused = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder), body: { assignedUser: stranger._id.toString() }
  });

  assert.equal(refused.status, 403);
  assert.match(refused.data.message, /Only administrators and managers can change the contract assignee/);

  // The assignment did not move.
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.assignedUser.toString(), holder._id.toString());

  // Nobody gained access: the wanted holder still cannot open the contract.
  const outsider = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(stranger), body: { description: 'Trying to work on it' }
  });
  assert.equal(outsider.status, 403);
  assert.match(outsider.data.message, /do not have access/);

  // Nothing was recorded as a handover, and nobody was told about one.
  const entry = await ActivityLog.findOne({ action: 'Contract Reassigned' });
  assert.equal(entry, null, 'a refused attempt was recorded as a handover');
  for (const user of [holder, stranger, admin]) {
    assert.equal(reassignmentItems(await feedOf(user)).length, 0);
  }

  // The Employee may still edit the contract it is assigned. Only the handover
  // is a management act.
  const edit = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder), body: { description: 'Still my contract to work on' }
  });
  assert.equal(edit.status, 200);
});

test('an assigned Employee may not move the assignee of a Rejected contract', async () => {
  const admin = await createUser({ name: 'Rejected Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Rejected Holder' });
  const stranger = await createUser({ name: 'Rejected Stranger' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Rejected' });

  const refused = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder), body: { assignedUser: stranger._id.toString() }
  });

  assert.equal(refused.status, 403);
  assert.match(refused.data.message, /Only administrators and managers can change the contract assignee/);
  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), holder._id.toString());
  assert.equal(await ActivityLog.findOne({ action: 'Contract Reassigned' }), null);
});

test('an Employee may not clear the assignee either', async () => {
  const admin = await createUser({ name: 'Clear Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Clear Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  const refused = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder), body: { assignedUser: null }
  });

  assert.equal(refused.status, 403);
  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), holder._id.toString());
});

test('an administrator and a manager may move the assignee', async () => {
  const admin = await createUser({ name: 'Move Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Move Manager', role: 'Manager' });
  const holder = await createUser({ name: 'Move Holder' });
  const successor = await createUser({ name: 'Move Successor' });

  for (const mover of [admin, manager]) {
    const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

    const moved = await api('PUT', `/api/contracts/${contract._id}`, {
      token: signToken(mover), body: { assignedUser: successor._id.toString() }
    });

    assert.equal(moved.status, 200, `${mover.role} must be able to move the assignee`);
    assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), successor._id.toString());
  }
});

test('resubmitting the unchanged assignee is accepted and changes nothing', async () => {
  const admin = await createUser({ name: 'Noop Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Noop Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  // The same value, sent as an id: that is not a change, and the edit form
  // always posts the whole current state.
  for (const body of [
    { assignedUser: holder._id.toString() },
    { title: 'Renamed only' }
  ]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      token: signToken(holder), body
    });
    assert.equal(res.status, 200, `a no-op save was refused: ${JSON.stringify(body)}`);
  }

  // An empty string means "clear the assignee", which on a contract that HAS
  // one is a real change, so it is refused for the Employee like any other.
  const cleared = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder), body: { assignedUser: '' }
  });
  assert.equal(cleared.status, 403);
  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), holder._id.toString());

  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), holder._id.toString());
  // A no-op is not a handover, so it is not recorded as one and announces
  // nothing.
  assert.equal(await ActivityLog.findOne({ action: 'Contract Reassigned' }), null);
  assert.equal(reassignmentItems(await feedOf(holder)).length, 0);
});

test('clearing an assignee that is already unset is a no-op, not a handover', async () => {
  const employee = await createUser({ name: 'Unset Employee' });
  const contract = await makeContract({ createdBy: employee._id, assignedUser: undefined, status: 'Draft' });

  // The contract has no assignee to begin with, so clearing it changes
  // nothing - and nothing is a change, for anybody.
  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee), body: { assignedUser: null }
  });
  assert.equal(res.status, 200);
  assert.equal(await ActivityLog.findOne({ action: 'Contract Reassigned' }), null);
});

// ---------------------------------------------------------------------------
// 2. The edit lock is unchanged, and still answers before the role check
// ---------------------------------------------------------------------------

test('a locked contract still answers 409 for an assignee change, for every role', async () => {
  const admin = await createUser({ name: 'Lock Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Lock Holder' });
  const successor = await createUser({ name: 'Lock Successor' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Active' });

  for (const actor of [holder, admin]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      token: signToken(actor), body: { assignedUser: successor._id.toString() }
    });
    assert.equal(res.status, 409, `${actor.role} must meet the edit lock, not the role check`);
    assert.deepEqual(res.data.lockedFields, ['assignedUser']);
    assert.equal(res.data.amendmentRequired, true);
  }

  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), holder._id.toString());
});

// ---------------------------------------------------------------------------
// 3. The record: a handover is logged, naming the old and the new assignee
// ---------------------------------------------------------------------------

test('a successful handover is logged with the old and the new assignee', async () => {
  const admin = await createUser({ name: 'Log Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Old Holder' });
  const successor = await createUser({ name: 'New Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  const moved = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin), body: { assignedUser: successor._id.toString() }
  });
  assert.equal(moved.status, 200);

  const entry = await ActivityLog.findOne({ action: 'Contract Reassigned', contract: contract._id });
  assert.ok(entry, 'the handover was not recorded');
  // Who did it, which contract, and the before-and-after.
  assert.equal(entry.user.toString(), admin._id.toString());
  assert.equal(entry.contract.toString(), contract._id.toString());
  assert.equal(entry.previousUser.toString(), holder._id.toString());
  assert.equal(entry.targetUser.toString(), successor._id.toString());
  assert.match(entry.details, /Old Holder/);
  assert.match(entry.details, /New Holder/);
  // The timestamp comes from the schema, like every other activity entry.
  assert.ok(entry.createdAt instanceof Date);

  // An ordinary edit of the same contract is not a handover and is not
  // recorded as one.
  await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin), body: { description: 'An ordinary edit' }
  });
  assert.equal(await ActivityLog.countDocuments({ action: 'Contract Reassigned', contract: contract._id }), 1);
});

// ---------------------------------------------------------------------------
// 4. The notification: the new assignee is told, and nobody else is
// ---------------------------------------------------------------------------

test('the new assignee is told about the handover, and nobody else is', async () => {
  const admin = await createUser({ name: 'Notify Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Notify Old Holder' });
  const successor = await createUser({ name: 'Notify New Holder' });
  const bystander = await createUser({ name: 'Notify Bystander', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin), body: { assignedUser: successor._id.toString() }
  });
  const entry = await ActivityLog.findOne({ action: 'Contract Reassigned', contract: contract._id });

  const feed = await feedOf(successor);
  const item = reassignmentItems(feed)[0];
  assert.ok(item, `the new assignee was not told: ${feed.items.map((i) => i.id).join(', ')}`);
  assert.equal(item.id, `reassignment-${entry._id}`);
  assert.equal(item.href, `/contracts/${contract._id}`);
  // The count must match the items, or the unread badge under-reports and some
  // notifications can never be marked seen.
  assert.equal(feed.count, feed.items.length);

  // Stable across reads: the id is derived from the entry, not from a position
  // in a list, so the client's seen-state does not re-arm on reload.
  const again = await feedOf(successor);
  assert.equal(reassignmentItems(again)[0].id, item.id);

  // The old assignee and everybody else learn nothing.
  assert.equal(reassignmentItems(await feedOf(holder)).length, 0);
  assert.equal(reassignmentItems(await feedOf(bystander)).length, 0);
  assert.equal(reassignmentItems(await feedOf(admin)).length, 0);
});

test('clearing an assignee is logged but notifies nobody', async () => {
  const admin = await createUser({ name: 'Clear Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Clear Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  const cleared = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin), body: { assignedUser: null }
  });
  assert.equal(cleared.status, 200);

  const entry = await ActivityLog.findOne({ action: 'Contract Reassigned', contract: contract._id });
  assert.ok(entry, 'the clearing was not recorded');
  assert.equal(entry.previousUser.toString(), holder._id.toString());
  assert.equal(entry.targetUser, undefined, 'a cleared assignment has no recipient');
  assert.match(entry.details, /Unassigned/);

  for (const user of [holder, admin]) {
    assert.equal(reassignmentItems(await feedOf(user)).length, 0, 'a cleared assignment notified somebody');
  }
});

// ---------------------------------------------------------------------------
// 5. The amendment route hands the contract over the same way
// ---------------------------------------------------------------------------

test('an approved amendment that moves the assignee logs and notifies the same way', async () => {
  const admin = await createUser({ name: 'Amend Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Amend Manager', role: 'Manager' });
  const holder = await createUser({ name: 'Amend Holder' });
  const successor = await createUser({ name: 'Amend Successor' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Active' });

  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(holder),
    body: { contract: contract._id, proposed: { assignedUser: successor._id.toString() }, reason: 'handover' }
  });
  assert.equal(requested.status, 201);

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(manager), body: { action: 'Approved' }
  });
  assert.equal(decided.status, 200);
  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), successor._id.toString());

  const entry = await ActivityLog.findOne({ action: 'Contract Reassigned', contract: contract._id });
  assert.ok(entry, 'the amendment handover was not recorded');
  assert.equal(entry.user.toString(), manager._id.toString());
  assert.equal(entry.previousUser.toString(), holder._id.toString());
  assert.equal(entry.targetUser.toString(), successor._id.toString());

  const feed = await feedOf(successor);
  const item = reassignmentItems(feed)[0];
  assert.ok(item, 'the amendment handover notified nobody');
  assert.equal(item.id, `reassignment-${entry._id}`);
  assert.equal(reassignmentItems(await feedOf(holder)).length, 0);
});

// ---------------------------------------------------------------------------
// 6. Everything else about the contract is unchanged
// ---------------------------------------------------------------------------

test('creating a contract with an assignee is unchanged', async () => {
  const employee = await createUser({ name: 'Create Employee' });
  const assignee = await createUser({ name: 'Create Assignee' });

  const created = await api('POST', '/api/contracts', {
    token: signToken(employee),
    body: {
      title: 'Created by an Employee',
      type: 'Vendor',
      partyName: 'Original vendor',
      startDate: utcDay(0).toISOString(),
      endDate: utcDay(90).toISOString(),
      amount: 500,
      currency: 'USD',
      assignedUser: assignee._id.toString()
    }
  });

  assert.equal(created.status, 201);
  assert.equal(created.data.assignedUser, assignee._id.toString());
  // A contract that is born assigned is not a handover: there was no previous
  // assignee and nobody is told about a change that never happened.
  assert.equal(await ActivityLog.findOne({ action: 'Contract Reassigned' }), null);
});

test('an ordinary editable-field save by an Employee is unchanged', async () => {
  const admin = await createUser({ name: 'Edit Admin', role: 'Admin' });
  const holder = await createUser({ name: 'Edit Holder' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: holder._id, status: 'Draft' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(holder),
    body: { title: 'Renamed', description: 'Corrected a typo', partyName: 'New counterparty' }
  });

  assert.equal(res.status, 200);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.title, 'Renamed');
  assert.equal(stored.description, 'Corrected a typo');
  assert.equal(stored.partyName, 'New counterparty');
  assert.equal(stored.assignedUser.toString(), holder._id.toString());
});
