const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const ActivityLog = require('../models/ActivityLog');
const Approval = require('../models/Approval');
const approvalRoutes = require('../routes/approvalRoutes');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

// A test database of its own, and never the application's connection string.
// The name is recognisably disposable and the host is loopback, which is what
// helpers/testDatabase.js enforces. testDatabaseSafety.test.js fails if this
// suite stops using the shared helper.
const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_approval_decision_test');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Issue 16 - the approval decision endpoint must decide a request exactly once,
// even when two approvers race the same Pending approval. The route used to be
// a read-then-write: both requests read `Pending`, both passed the guards, both
// wrote, and the loser overwrote the winner's contract status while BOTH
// "Contract Approved" and "Contract Rejected" entries landed in the audit
// trail. The decision is now a compare-and-set claim, the same pattern
// amendmentRoutes.js and expiryUpdater.js already use.

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

let userSeq = 0;
const createUser = async ({ name, role = 'Employee' }) => {
  userSeq += 1;
  return User.create({
    name,
    email: `apd.${userSeq}.${role.toLowerCase()}@ricoz.test`,
    password: 'Password123!',
    role,
    status: 'Active'
  });
};

const makeContract = async (createdBy, status = 'Pending Approval') => Contract.create({
  contractNumber: `APD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Race contract',
  type: 'Vendor',
  partyName: 'Race vendor',
  description: 'Race description',
  startDate: utcDay(-30),
  endDate: utcDay(365),
  amount: 1000,
  currency: 'USD',
  createdBy,
  status
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

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/approvals', approvalRoutes);
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
  await ActivityLog.deleteMany({});
  await Approval.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// Sets up a Pending approval requested by an Employee, decided by two distinct
// Admin/Manager accounts (so neither decision trips the self-approval rule).
const pendingRequest = async () => {
  const employee = await createUser({ name: 'Requester' });
  const first = await createUser({ name: 'First Approver', role: 'Admin' });
  const second = await createUser({ name: 'Second Approver', role: 'Manager' });
  const contract = await makeContract(employee._id);
  const approval = await Approval.create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });
  return { employee, first, second, contract, approval };
};

test('an approve and a reject racing the same request decide it exactly once', async () => {
  const { first, second, contract, approval } = await pendingRequest();

  // Dispatched together, so both requests are inside the route's read window at
  // the same time. Without the compare-and-set claim both read Pending, both
  // pass the guards, and both write.
  const [approve, reject] = await Promise.all([
    api('PUT', `/api/approvals/${approval._id}/action`, { token: signToken(first), body: { action: 'Approved' } }),
    api('PUT', `/api/approvals/${approval._id}/action`, { token: signToken(second), body: { action: 'Rejected' } })
  ]);

  const statuses = [approve.status, reject.status].sort();
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected one winner and one 409, got ${statuses.join(' and ')}; ` +
    `bodies: ${JSON.stringify([approve.data, reject.data])}`
  );
  assert.equal(
    [approve, reject].find((r) => r.status === 409).data.message,
    'This approval request has already been decided',
    'the loser is told the request was already decided'
  );

  const storedApproval = await Approval.findById(approval._id);
  const storedContract = await Contract.findById(contract._id);

  // The contract must agree with the recorded decision, whichever won.
  if (storedApproval.status === 'Approved') {
    assert.equal(storedContract.status, 'Active', 'an approved request did not activate the contract');
  } else {
    assert.equal(storedApproval.status, 'Rejected', `the stored status is ${storedApproval.status}`);
    assert.equal(storedContract.status, 'Rejected', 'a rejected request did not reject the contract');
  }

  // The audit trail must record the one decision that was applied. A stale
  // "Contract Rejected" beside a "Contract Approved" (or vice versa) means the
  // request was decided twice.
  const approved = await ActivityLog.countDocuments({ contract: contract._id, action: 'Contract Approved' });
  const rejected = await ActivityLog.countDocuments({ contract: contract._id, action: 'Contract Rejected' });
  assert.equal(approved + rejected, 1, `expected one audit entry, found ${approved} approved and ${rejected} rejected`);
});

test('two approvers racing to approve the same request decide it exactly once', async () => {
  const { first, second, contract, approval } = await pendingRequest();

  const [one, two] = await Promise.all([
    api('PUT', `/api/approvals/${approval._id}/action`, { token: signToken(first), body: { action: 'Approved' } }),
    api('PUT', `/api/approvals/${approval._id}/action`, { token: signToken(second), body: { action: 'Approved' } })
  ]);

  const statuses = [one.status, two.status].sort();
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected one winner and one 409, got ${statuses.join(' and ')}; ` +
    `bodies: ${JSON.stringify([one.data, two.data])}`
  );

  assert.equal((await Approval.findById(approval._id)).status, 'Approved');
  assert.equal((await Contract.findById(contract._id)).status, 'Active');
  assert.equal(
    await ActivityLog.countDocuments({ contract: contract._id, action: 'Contract Approved' }),
    1,
    'the contract was approved twice'
  );
});

test('a second sequential decision on an already-decided request is refused', async () => {
  const { first, second, contract, approval } = await pendingRequest();

  const first_ = await api('PUT', `/api/approvals/${approval._id}/action`, {
    token: signToken(first), body: { action: 'Approved' }
  });
  assert.equal(first_.status, 200);

  const second_ = await api('PUT', `/api/approvals/${approval._id}/action`, {
    token: signToken(second), body: { action: 'Rejected' }
  });
  assert.equal(second_.status, 409);
  assert.equal(second_.data.message, 'This approval request has already been decided');

  assert.equal((await Approval.findById(approval._id)).status, 'Approved');
  assert.equal((await Contract.findById(contract._id)).status, 'Active');
  assert.equal(
    await ActivityLog.countDocuments({ contract: contract._id, action: 'Contract Approved' }),
    1
  );
  assert.equal(
    await ActivityLog.countDocuments({ contract: contract._id, action: 'Contract Rejected' }),
    0,
    'the refused decision must not leave an audit entry behind'
  );
});
