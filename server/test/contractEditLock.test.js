const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
require('../models/ContractDocument');
const ContractAmendment = require('../models/ContractAmendment');
const ActivityLog = require('../models/ActivityLog');
const contractRoutes = require('../routes/contractRoutes');
const approvalRoutes = require('../routes/approvalRoutes');
const renewalRoutes = require('../routes/renewalRoutes');
const amendmentRoutes = require('../routes/amendmentRoutes');
const { UNLOCKED_STATUSES, LOCKED_FIELDS, evaluateContractEdit, sameValue } = require('../utils/contractEditLock');
const { syncDocumentVersionIndex } = require('../utils/documentIndexes');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

// A test database of its own, ALWAYS, and never the application's connection
// string. The original line here was `process.env.MONGO_URI || '..._test'`, and
// the `dotenv` call above has already loaded server/.env, where MONGO_URI is the
// real connection string - so the `||` never fired and this file connected to the
// development database and dropped it in `before` and again in `after`. Local
// development data was lost to that, with no dump.
//
// The rule now lives in one place, helpers/testDatabase.js, which refuses any
// name that is not recognisably disposable and any host that is not loopback.
// testDatabaseSafety.test.js fails if this suite stops using it, or if any suite
// in this directory starts reading process.env.MONGO_URI.
const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_editlock_test');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;

const utcDay = (daysFromToday) => new Date(Date.UTC(
  new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
) + daysFromToday * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

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

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  await syncDocumentVersionIndex(mongoose.model('ContractDocument'), { maxTimeMS: 10000 });
  // The amendment queue relies on a partial unique index; create it explicitly
  // exactly as production would have to.
  await ContractAmendment.syncIndexes();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/contracts', contractRoutes);
  app.use('/api/approvals', approvalRoutes);
  app.use('/api/renewals', renewalRoutes);
  app.use('/api/contract-amendments', amendmentRoutes);
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
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// The exact Phase 12 attack, replayed against the patched route
// ---------------------------------------------------------------------------

test('regression: an assigned Employee can no longer rewrite the amount or dates of an Active contract', async () => {
  const admin = await createUser({ name: 'Admin', email: 'lock.admin@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp', email: 'lock.emp@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active', overrides: { amount: 5000 } });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee),
    body: { amount: 999999, endDate: utcDay(2000).toISOString() }
  });

  assert.equal(res.status, 409);
  assert.equal(res.data.amendmentRequired, true);
  assert.deepEqual(res.data.lockedFields.sort(), ['amount', 'endDate']);
  assert.equal(res.data.contractStatus, 'Active');

  const stored = await Contract.findById(contract._id);
  assert.equal(stored.amount, 5000, 'amount must be untouched');
  assert.equal(stored.endDate.getTime(), contract.endDate.getTime(), 'endDate must be untouched');
});

test('regression: an assigned Employee can no longer reassign an Active contract', async () => {
  const admin = await createUser({ name: 'Admin2', email: 'lock.admin2@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp2', email: 'lock.emp2@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee), body: { assignedUser: admin._id }
  });

  assert.equal(res.status, 409);
  assert.deepEqual(res.data.lockedFields, ['assignedUser']);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.assignedUser.toString(), employee._id.toString());
});

test('the lock binds Admin and Manager too, not just Employees', async () => {
  const admin = await createUser({ name: 'Admin3', email: 'lock.admin3@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr', email: 'lock.mgr@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: manager._id, status: 'Active' });

  for (const user of [admin, manager]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      token: signToken(user), body: { amount: 1 }
    });
    assert.equal(res.status, 409, `${user.role} must also be locked out`);
  }
  assert.equal((await Contract.findById(contract._id)).amount, 1000);
});

// ---------------------------------------------------------------------------
// Rule 1: Draft and Rejected stay editable
// ---------------------------------------------------------------------------

test('every role can still edit a Draft contract', async () => {
  const admin = await createUser({ name: 'Admin4', email: 'lock.admin4@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp4', email: 'lock.emp4@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Draft' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee),
    body: { amount: 250, startDate: utcDay(0).toISOString(), endDate: utcDay(90).toISOString(), assignedUser: admin._id }
  });
  assert.equal(res.status, 200);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.amount, 250);
  assert.equal(stored.assignedUser.toString(), admin._id.toString());
});

test('a Rejected contract is editable again', async () => {
  const admin = await createUser({ name: 'Admin5', email: 'lock.admin5@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp5', email: 'lock.emp5@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Rejected' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee), body: { amount: 750 }
  });
  assert.equal(res.status, 200);
  assert.equal((await Contract.findById(contract._id)).amount, 750);
});

test('UNLOCKED_STATUSES is exactly Draft and Rejected', () => {
  assert.deepEqual([...UNLOCKED_STATUSES].sort(), ['Draft', 'Rejected']);
});

// ---------------------------------------------------------------------------
// Descriptive fields and no-op saves keep working
// ---------------------------------------------------------------------------

test('descriptive fields stay editable on an Active contract', async () => {
  const admin = await createUser({ name: 'Admin6', email: 'lock.admin6@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp6', email: 'lock.emp6@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee),
    body: { title: 'Renamed', partyName: 'New vendor', description: 'Corrected typo' }
  });
  assert.equal(res.status, 200);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.title, 'Renamed');
  assert.equal(stored.partyName, 'New vendor');
});

test('a no-op resubmit of the current locked values is accepted (the existing EditContract form always does this)', async () => {
  const admin = await createUser({ name: 'Admin7', email: 'lock.admin7@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp7', email: 'lock.emp7@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee),
    body: {
      title: 'Renamed by admin',
      amount: contract.amount,
      currency: contract.currency,
      startDate: contract.startDate.toISOString(),
      endDate: contract.endDate.toISOString(),
      assignedUser: employee._id
    }
  });
  assert.equal(res.status, 200, 'resubmitting unchanged values must not be treated as a change');
});

test('a locked field mixed with a descriptive change is refused without applying the descriptive change', async () => {
  const admin = await createUser({ name: 'Admin8', email: 'lock.admin8@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp8', email: 'lock.emp8@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee), body: { title: 'Should not stick', amount: 4242 }
  });
  assert.equal(res.status, 409);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.title, 'Original title', 'the whole update is rejected, not partially applied');
  assert.equal(stored.amount, 1000);
});

test('changing only the currency is treated as a financial change', async () => {
  const admin = await createUser({ name: 'Admin9', email: 'lock.admin9@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin), body: { currency: 'EUR' }
  });
  assert.equal(res.status, 409);
  assert.deepEqual(res.data.lockedFields, ['currency']);
});

// ---------------------------------------------------------------------------
// Rule 3 / compatibility: the flows that legitimately change a locked field
// ---------------------------------------------------------------------------

test('the renewal route still changes endDate after the contract is locked', async () => {
  const admin = await createUser({ name: 'Admin10', email: 'lock.admin10@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp10', email: 'lock.emp10@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });

  const res = await api('POST', `/api/renewals/renew/${contract._id}`, {
    token: signToken(admin),
    body: { newEndDate: utcDay(800).toISOString(), notes: 'phase13 compatibility' }
  });
  assert.equal(res.status, 201, 'the dedicated renewal route must remain able to move the end date');
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.endDate.getTime(), utcDay(800).getTime());
});

test('the full submit -> approve lifecycle still works under the lock', async () => {
  const admin = await createUser({ name: 'Admin11', email: 'lock.admin11@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp11', email: 'lock.emp11@ricoz.test' });
  const manager = await createUser({ name: 'Mgr11', email: 'lock.mgr11@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Draft' });

  const submitted = await api('POST', `/api/approvals/submit/${contract._id}`, { token: signToken(employee) });
  assert.equal(submitted.status, 201);
  assert.equal((await Contract.findById(contract._id)).status, 'Pending Approval');

  const decided = await api('PUT', `/api/approvals/${submitted.data._id}/action`, {
    token: signToken(manager), body: { action: 'Approved', comments: 'ok' }
  });
  assert.equal(decided.status, 200);
  assert.equal((await Contract.findById(contract._id)).status, 'Active');

  const blocked = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(employee), body: { amount: 2 }
  });
  assert.equal(blocked.status, 409, 'the approved terms are now binding');
});

// ---------------------------------------------------------------------------
// Rule 3: the amendment workflow
// ---------------------------------------------------------------------------

test('an amendment request is refused for a Draft, because a direct edit is allowed there', async () => {
  const admin = await createUser({ name: 'Admin12', email: 'lock.admin12@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Draft' });

  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(admin), body: { contract: contract._id, proposed: { amount: 10 }, reason: 'x' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /edited directly/);
});

test('an amendment can be requested by an Employee and applied by a Manager, with an audit trail', async () => {
  const admin = await createUser({ name: 'Admin13', email: 'lock.admin13@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp13', email: 'lock.emp13@ricoz.test' });
  const manager = await createUser({ name: 'Mgr13', email: 'lock.mgr13@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active', amount: 1000 });

  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(employee),
    body: { contract: contract._id, proposed: { amount: 1500, endDate: utcDay(500).toISOString() }, reason: 'Signed addendum' }
  });
  assert.equal(requested.status, 201);
  assert.equal(requested.data.status, 'Pending');
  assert.equal(requested.data.before.amount, 1000, 'the previous terms are captured');

  // Still not applied while pending.
  assert.equal((await Contract.findById(contract._id)).amount, 1000);

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(manager), body: { action: 'Approved', comments: 'Addendum received' }
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.status, 'Approved');

  const stored = await Contract.findById(contract._id);
  assert.equal(stored.amount, 1500);
  assert.equal(stored.endDate.getTime(), utcDay(500).getTime());

  const logs = await ActivityLog.find({ contract: contract._id }).sort({ createdAt: 1 });
  assert.ok(logs.some((l) => l.action === 'Amendment Requested'));
  assert.ok(logs.some((l) => l.action === 'Amendment Approved'));
});

test('an amendment cannot be approved by an Employee', async () => {
  const admin = await createUser({ name: 'Admin14', email: 'lock.admin14@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Emp14', email: 'lock.emp14@ricoz.test' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, status: 'Active' });
  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(admin), body: { contract: contract._id, proposed: { amount: 10 }, reason: 'y' }
  });

  const res = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(employee), body: { action: 'Approved' }
  });
  assert.equal(res.status, 403);
});

test('a requester cannot decide their own amendment', async () => {
  const admin = await createUser({ name: 'Admin15', email: 'lock.admin15@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(admin), body: { contract: contract._id, proposed: { amount: 10 }, reason: 'z' }
  });

  const res = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(admin), body: { action: 'Approved' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /your own amendment/);
});

test('a rejected amendment leaves the contract unchanged', async () => {
  const admin = await createUser({ name: 'Admin16', email: 'lock.admin16@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr16', email: 'lock.mgr16@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { amount: 1000 } });
  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { amount: 1 }, reason: 'bad idea' }
  });

  const res = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(admin), body: { action: 'Rejected', comments: 'No' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'Rejected');
  assert.equal((await Contract.findById(contract._id)).amount, 1000);
});

test('an amendment can only be decided once', async () => {
  const admin = await createUser({ name: 'Admin17', email: 'lock.admin17@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr17', email: 'lock.mgr17@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { amount: 1 }, reason: 'q' }
  });
  await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(admin), body: { action: 'Approved' }
  });
  const second = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(admin), body: { action: 'Rejected' }
  });
  assert.equal(second.status, 409);
});

test('only one open amendment per contract is allowed', async () => {
  const admin = await createUser({ name: 'Admin18', email: 'lock.admin18@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr18', email: 'lock.mgr18@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });

  const first = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { amount: 10 }, reason: 'first' }
  });
  assert.equal(first.status, 201);
  const second = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { amount: 20 }, reason: 'second' }
  });
  assert.equal(second.status, 409);
  assert.match(second.data.message, /already awaiting a decision/);
});

test('an amendment that changes nothing is refused', async () => {
  const admin = await createUser({ name: 'Admin19', email: 'lock.admin19@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr19', email: 'lock.mgr19@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { amount: 1000 } });
  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { amount: 1000 }, reason: 'no change' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /Nothing to amend/);
});

test('an amendment may not propose a field outside the locked set', async () => {
  const admin = await createUser({ name: 'Admin20', email: 'lock.admin20@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(admin), body: { contract: contract._id, proposed: { title: 'sneaky' }, reason: 'nope' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /Only/);
});

test('an amendment is rejected if it would make the end date precede the start date', async () => {
  const admin = await createUser({ name: 'Admin21', email: 'lock.admin21@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(admin),
    body: { contract: contract._id, proposed: { endDate: utcDay(-500).toISOString() }, reason: 'backwards' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /on or after the start date/);
});

test('an amendment is rejected if it would push the start date past the existing end date', async () => {
  const admin = await createUser({ name: 'Admin22', email: 'lock.admin22@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(admin),
    body: { contract: contract._id, proposed: { startDate: utcDay(900).toISOString() }, reason: 'bad range' }
  });
  assert.equal(res.status, 400, 'the RESULTING range must be valid, not just the supplied field');
});

test('an approved amendment cannot silently undo a renewal made while it was pending', async () => {
  const admin = await createUser({ name: 'Admin23', email: 'lock.admin23@ricoz.test', role: 'Admin' });
  const manager = await createUser({ name: 'Mgr23', email: 'lock.mgr23@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });

  // An amendment asking for the end date that is already in force.
  const requested = await api('POST', '/api/contract-amendments', {
    token: signToken(manager), body: { contract: contract._id, proposed: { endDate: utcDay(700).toISOString() }, reason: 'stale' }
  });
  assert.equal(requested.status, 201);

  // Someone renews the contract in the meantime, moving endDate.
  const renewed = await api('POST', `/api/renewals/renew/${contract._id}`, {
    token: signToken(admin), body: { newEndDate: utcDay(900).toISOString() }
  });
  assert.equal(renewed.status, 201);

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(admin), body: { action: 'Approved' }
  });
  assert.equal(decided.status, 409);
  assert.equal((await Contract.findById(contract._id)).endDate.getTime(), utcDay(900).getTime());
});

test('an amendment on an archived contract is refused', async () => {
  const admin = await createUser({ name: 'Admin24', email: 'lock.admin24@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { isArchived: true } });
  const res = await api('POST', '/api/contract-amendments', {
    token: signToken(admin), body: { contract: contract._id, proposed: { amount: 5 }, reason: 'archived' }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /Archived/);
});

// ---------------------------------------------------------------------------
// Unit-level checks on the policy itself
// ---------------------------------------------------------------------------

test('LOCKED_FIELDS is exactly the financial terms, the dates and the assignee', () => {
  assert.deepEqual([...LOCKED_FIELDS].sort(), ['amount', 'assignedUser', 'currency', 'endDate', 'startDate']);
});

test('sameValue treats an absent assignee and a null assignee as equal', () => {
  assert.equal(sameValue('assignedUser', null, null), true);
  assert.equal(sameValue('assignedUser', null, undefined), true);
  assert.equal(sameValue('assignedUser', null, '507f1f77bcf86cd799439011'), false);
});

test('sameValue compares dates by instant, not by string format', () => {
  assert.equal(sameValue('startDate', '2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:00:00Z')), true);
  assert.equal(sameValue('startDate', '2026-01-02T00:00:00.000Z', new Date('2026-01-01T00:00:00Z')), false);
});

test('evaluateContractEdit allows a Draft edit and refuses an Active one', () => {
  const draft = { _id: 'x', status: 'Draft', amount: 1 };
  assert.equal(evaluateContractEdit({ contract: draft, proposed: { amount: 2 } }), null);
  const active = { _id: 'x', status: 'Active', amount: 1 };
  const verdict = evaluateContractEdit({ contract: active, proposed: { amount: 2 } });
  assert.equal(verdict.status, 409);
  assert.deepEqual(verdict.lockedFields, ['amount']);
});

test('every submitted-or-later status is locked, so no state is left unguarded', () => {
  const all = ['Draft', 'Pending Review', 'Pending Approval', 'Approved', 'Active', 'Rejected', 'Expired', 'Closed', 'Renewed'];
  for (const status of all) {
    const locked = Boolean(evaluateContractEdit({ contract: { _id: 'x', status, amount: 1 }, proposed: { amount: 2 } }));
    assert.equal(locked, !UNLOCKED_STATUSES.has(status), `status '${status}' must be ${UNLOCKED_STATUSES.has(status) ? 'editable' : 'locked'}`);
  }
});
