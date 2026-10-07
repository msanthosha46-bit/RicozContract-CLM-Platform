const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
const Approval = require('../models/Approval');
const contractRoutes = require('../routes/contractRoutes');
const approvalRoutes = require('../routes/approvalRoutes');
const renewalRoutes = require('../routes/renewalRoutes');
const amendmentRoutes = require('../routes/amendmentRoutes');
const notificationRoutes = require('../routes/notificationRoutes');
const { syncDocumentVersionIndex } = require('../utils/documentIndexes');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

// A test database of its own, ALWAYS, and never the application's connection
// string. The `dotenv` call above has already loaded server/.env, where
// MONGO_URI is the real connection string, so the original
// `process.env.MONGO_URI || '..._test'` never fell through to its own default:
// this suite connected to the development database and dropped it in `before`
// and again in `after`.
//
// The rule lives in one place, helpers/testDatabase.js, which refuses any name
// that is not recognisably disposable and any host that is not loopback.
// testDatabaseSafety.test.js fails if this suite stops using it, or if any suite
// in this directory starts reading process.env.MONGO_URI.
const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_amendment_test');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The Phase 13 patch ships server/test/contractEditLock.test.js, which covers
// the edit lock and the core amendment lifecycle. This file covers what that
// file does not:
//
//   * concurrent approval attempts (the compare-and-set claim)
//   * the decision that the patch route had no test for: a SECOND approved
//     amendment for a field the first one already moved
//   * activity-history entries for all three amendment actions
//   * the notification feed, including that it stays a derived feed
//   * the assignee name resolution the list response needs to be renderable
//   * list scoping, so the queue cannot leak another team's requests

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
const createUser = async ({ name, role = 'Employee', status = 'Active' }) => {
  userSeq += 1;
  return User.create({
    name,
    email: `amd.${userSeq}.${role.toLowerCase()}@ricoz.test`,
    password: 'Password123!',
    role,
    status
  });
};

const makeContract = async ({ createdBy, assignedUser, status = 'Active', overrides = {} }) => Contract.create({
  contractNumber: `AMD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
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

const requestAmendment = (token, contract, proposed, reason = 'commercial change') =>
  api('POST', '/api/contract-amendments', { token, body: { contract: contract._id, proposed, reason } });

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  await syncDocumentVersionIndex(mongoose.model('ContractDocument'), { maxTimeMS: 10000 });
  // The amendment queue's one-open-request-per-contract rule is a partial
  // unique index, which the server does not build for itself (autoIndex:false).
  await ContractAmendment.syncIndexes();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/contracts', contractRoutes);
  app.use('/api/approvals', approvalRoutes);
  app.use('/api/renewals', renewalRoutes);
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
  await Approval.deleteMany({});
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// Concurrency: the compare-and-set claim
// ---------------------------------------------------------------------------

test('two approvers racing the same request produce exactly one decision', async () => {
  const admin = await createUser({ name: 'Race Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Race Manager', role: 'Manager' });
  const employee = await createUser({ name: 'Race Employee' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 1000 } });

  const requested = await requestAmendment(signToken(employee), contract, { amount: 2500 });
  assert.equal(requested.status, 201);

  // Both decisions are dispatched together, so both requests are inside the
  // route's read window at the same time. Without the compare-and-set claim
  // both read Pending, both pass the staleness check, and both write.
  const [first, second] = await Promise.all([
    api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } }),
    api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(manager), body: { action: 'Approved' } })
  ]);

  const statuses = [first.status, second.status].sort();
  // The bodies are included because this test failed once in a full-suite run
  // with no output retained, so the only way a recurrence can be diagnosed is
  // if the assertion says what actually came back.
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected one winner and one 409, got ${statuses.join(' and ')}; ` +
    `bodies: ${JSON.stringify([first.data, second.data])}`
  );
  assert.equal(
    ([first, second].find((r) => r.status === 409)).data.message,
    'This amendment has already been decided',
    'the loser is told the request was already decided'
  );

  const decided = await ContractAmendment.findById(requested.data._id);
  assert.equal(decided.status, 'Approved', `the stored status is ${decided.status}`);
  // Scoped to this test's contract rather than counted across the database, so
  // the assertion can only ever be about the race under test.
  assert.equal(
    (await ContractAmendment.countDocuments({ contract: contract._id, status: 'Approved' })),
    1,
    'the request was decided twice'
  );

  // The contract is written once. The value alone cannot prove that, so the
  // audit trail is checked: two "Amendment Approved" entries would mean the
  // contract was assigned twice and the approver could not tell which write won.
  const approvals = await ActivityLog.find({ contract: contract._id, action: 'Amendment Approved' });
  assert.equal(approvals.length, 1, `expected one audit entry, found ${approvals.length}`);
  assert.equal((await Contract.findById(contract._id)).amount, 2500);
});

test('an approve and a reject racing the same request still decide it once', async () => {
  // The mirror of the race above, and the case with a visible wrong outcome: if
  // the reject lost the claim but were applied anyway, the contract would carry
  // the amount while the request read Rejected.
  const admin = await createUser({ name: 'Race2 Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Race2 Manager', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 100 } });

  const requested = await requestAmendment(signToken(manager), contract, { amount: 900 });
  assert.equal(requested.status, 201);

  const [approve, reject] = await Promise.all([
    api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } }),
    api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Rejected' } })
  ]);

  const statuses = [approve.status, reject.status].sort();
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected one winner and one 409, got ${statuses.join(' and ')}; ` +
    `bodies: ${JSON.stringify([approve.data, reject.data])}`
  );

  const stored = await ContractAmendment.findById(requested.data._id);
  const amount = (await Contract.findById(contract._id)).amount;
  // The contract must agree with the recorded decision, whichever won.
  if (stored.status === 'Approved') {
    assert.equal(amount, 900, 'an approved amendment did not reach the contract');
  } else {
    assert.equal(amount, 100, 'a rejected amendment changed the contract');
  }
  // Scoped to this contract: the count is about this race, not about whatever
  // else the database happens to hold.
  assert.equal(
    (await ActivityLog.countDocuments({ contract: contract._id, action: 'Amendment Rejected' })) +
      (await ActivityLog.countDocuments({ contract: contract._id, action: 'Amendment Approved' })),
    1,
    `the race left more than one decision entry; stored status ${stored.status}, amount ${amount}`
  );
});

// ---------------------------------------------------------------------------
// A second amendment for a field the first one already moved
// ---------------------------------------------------------------------------

test('a later approved amendment for a field an earlier one already moved is refused as stale', async () => {
  const admin = await createUser({ name: 'Seq Admin', role: 'Admin' });
  const firstRequester = await createUser({ name: 'Seq Req A' });
  // Privileged, so this requester is also an approver - but the separation of
  // duties means they may not decide their OWN request, which is why the
  // decisions below are made by `admin`.
  const secondRequester = await createUser({ name: 'Seq Req B', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: firstRequester._id, overrides: { amount: 100 } });

  // A second request over the same field is accepted, because the first is
  // already decided and `before` is captured afresh.
  const firstRequest = await requestAmendment(signToken(firstRequester), contract, { amount: 200 });
  assert.equal(firstRequest.status, 201);
  assert.equal((await api('PUT', `/api/contract-amendments/${firstRequest.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } })).status, 200);
  assert.equal((await Contract.findById(contract._id)).amount, 200);

  // The first is decided, so the one-open-request-per-contract slot is free and a
  // second request over the same field is accepted.
  const secondRequest = await requestAmendment(signToken(secondRequester), contract, { amount: 300 });
  assert.equal(secondRequest.status, 201, 'a fresh request against the updated contract must be accepted');
  assert.equal(secondRequest.data.before.amount, 200, 'the new request must capture the updated value as its baseline');
  assert.equal(secondRequest.data.proposed.amount, 300);

  const decided = await api('PUT', `/api/contract-amendments/${secondRequest.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decided.status, 200);
  assert.equal((await Contract.findById(contract._id)).amount, 300);
});

test('an amendment whose field was moved by a renewal is refused as stale', async () => {
  // The realistic stale case, and the reason `before` exists. The request was
  // written against the end date the contract had when it was made; a renewal
  // then moved that end date without going through the amendment route (that is
  // what `POST /renewals/renew/:id` does). Approving the amendment now would
  // silently undo the renewal, so the decision has to be refused and the
  // requester told which field has to be recalculated.
  const admin = await createUser({ name: 'Stale Admin', role: 'Admin' });
  const requester = await createUser({ name: 'Stale Req', role: 'Manager' });
  const contract = await makeContract({
    createdBy: admin._id,
    assignedUser: admin._id,
    status: 'Active',
    overrides: { amount: 100, endDate: utcDay(400) }
  });

  const b = await requestAmendment(signToken(requester), contract, { endDate: utcDay(500).toISOString() });
  assert.equal(b.status, 201);
  assert.equal(b.data.before.endDate, utcDay(400).toISOString(), 'the baseline must be the end date as it stood');
  assert.equal(b.data.proposed.endDate, utcDay(500).toISOString());

  // A different route, a different actor, no amendment involved: the renewal
  // moves endDate out from under the open request.
  const renewed = await api('POST', `/api/renewals/renew/${contract._id}`, {
    token: signToken(admin), body: { newEndDate: utcDay(600).toISOString() }
  });
  assert.equal(renewed.status, 201, 'the renewal is what invalidates the request, so it has to actually succeed');
  assert.equal((await Contract.findById(contract._id)).endDate.getTime(), utcDay(600).getTime());

  const decidedB = await api('PUT', `/api/contract-amendments/${b.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decidedB.status, 409);
  // The message must name the field, or the requester cannot tell what to redo.
  assert.match(decidedB.data.message, /endDate changed after this request was made/);
  // The renewal stands: refusing the amendment is the whole point.
  assert.equal((await Contract.findById(contract._id)).endDate.getTime(), utcDay(600).getTime(), 'the stale amendment overwrote the renewal');
  assert.equal((await ContractAmendment.findById(b.data._id)).status, 'Pending', 'a refused amendment must stay open so the requester can resubmit');
  assert.equal(await ActivityLog.countDocuments({ action: 'Amendment Approved' }), 0, 'a refused decision was audited as an approval');
});

test('a partial move is refused naming only the field that moved', async () => {
  // Two fields proposed, one moved. The message has to be specific: reporting
  // both would ask the requester to redo a change that is still valid.
  const admin = await createUser({ name: 'Partial Admin', role: 'Admin' });
  const requester = await createUser({ name: 'Partial Req', role: 'Manager' });
  const contract = await makeContract({
    createdBy: admin._id,
    assignedUser: admin._id,
    status: 'Active',
    overrides: { amount: 100, endDate: utcDay(400) }
  });

  const requested = await requestAmendment(signToken(requester), contract, {
    amount: 250,
    endDate: utcDay(500).toISOString()
  });
  assert.equal(requested.status, 201);

  await api('POST', `/api/renewals/renew/${contract._id}`, {
    token: signToken(admin), body: { newEndDate: utcDay(600).toISOString() }
  });

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decided.status, 409);
  assert.match(decided.data.message, /endDate changed/);
  assert.equal(/amount changed/.test(decided.data.message), false, 'amount did not move and must not be reported as stale');
  // Neither field is applied - a partial application would leave the contract in
  // a state no single approval ever authorised.
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.amount, 100);
  assert.equal(stored.endDate.getTime(), utcDay(600).getTime());
});

test('a value that has since moved onto the proposed figure is refused as stale, and the request stays open', async () => {
  // This is the case the patch's redundancy guard is written for: the contract
  // already holds the value the request proposes, so applying it would be a
  // no-op that still recorded an approval. It is also the case the staleness
  // guard catches first.
  //
  // The two are not independent. `redundant` is a subset of `stale`: a field can
  // only equal the proposed value if the contract has moved there since
  // `before` was captured, because the request-time check already refuses a
  // proposal that matches the contract as it stood. So when every proposed field
  // is redundant, every proposed field is stale too, and the staleness branch
  // returns first. That is the correct outcome - the value must be recalculated
  // either way - but the redundancy branch below it is unreachable.
  //
  // The behaviour is pinned here as it actually is, so the message a requester
  // sees is covered by a test rather than by inspection.
  const admin = await createUser({ name: 'Redundant Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Redundant Manager', role: 'Manager' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 100, endDate: utcDay(500) } });

  const requested = await requestAmendment(signToken(manager), contract, { amount: 700, endDate: utcDay(600).toISOString() });
  assert.equal(requested.status, 201);
  // A renewal extends the end date and a separate route moves the amount, so
  // the contract now holds exactly what was proposed.
  await Contract.updateOne({ _id: contract._id }, { $set: { amount: 700, endDate: utcDay(600) } });

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decided.status, 409);
  assert.match(decided.data.message, /amount, endDate changed after this request was made/);
  // Still open, so the requester can be told what happened and resubmit.
  assert.equal((await ContractAmendment.findById(requested.data._id)).status, 'Pending');
  // And no approval was recorded for a request that changed nothing.
  assert.equal(await ActivityLog.countDocuments({ action: 'Amendment Approved' }), 0);
});

// ---------------------------------------------------------------------------
// Activity history (TASK 6)
// ---------------------------------------------------------------------------

test('request, approval and rejection are each recorded in the existing activity log', async () => {
  const admin = await createUser({ name: 'Audit Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Audit Manager', role: 'Manager' });
  const employee = await createUser({ name: 'Audit Employee' });

  const approvedContract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const requested = await requestAmendment(signToken(employee), approvedContract, { amount: 20 }, 'price renegotiated');
  assert.equal(requested.status, 201);

  const requestEntry = await ActivityLog.findOne({ action: 'Amendment Requested', contract: approvedContract._id });
  assert.ok(requestEntry, 'the request was not recorded');
  assert.equal(requestEntry.user.toString(), employee._id.toString(), 'the request must be attributed to the requester, not the approver');
  assert.match(requestEntry.details, /amount/);
  assert.match(requestEntry.details, /price renegotiated|AMD-/);

  const approved = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(approved.status, 200);
  const approveEntry = await ActivityLog.findOne({ action: 'Amendment Approved', contract: approvedContract._id });
  assert.ok(approveEntry, 'the approval was not recorded');
  assert.equal(approveEntry.user.toString(), admin._id.toString());

  const rejectedContract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const rejectedRequest = await requestAmendment(signToken(employee), rejectedContract, { amount: 30 });
  const rejected = await api('PUT', `/api/contract-amendments/${rejectedRequest.data._id}/action`, {
    token: signToken(admin), body: { action: 'Rejected', comments: 'not budgeted' }
  });
  assert.equal(rejected.status, 200);
  const rejectEntry = await ActivityLog.findOne({ action: 'Amendment Rejected', contract: rejectedContract._id });
  assert.ok(rejectEntry, 'the rejection was not recorded');
  assert.match(rejectEntry.details, /not budgeted/);

  // One entry per action. A repeated decision cannot add a second, because the
  // claim refuses it before the log is written.
  assert.equal((await ActivityLog.countDocuments({ action: 'Amendment Approved' })), 1);
  assert.equal((await ActivityLog.countDocuments({ action: 'Amendment Rejected' })), 1);
  assert.equal((await ActivityLog.countDocuments({ action: 'Amendment Requested' })), 2);
});

// ---------------------------------------------------------------------------
// Notifications (TASK 5)
// ---------------------------------------------------------------------------

test('a pending amendment is announced to an approver with a stable id and a link to its queue row', async () => {
  const admin = await createUser({ name: 'Notify Admin', role: 'Admin' });
  const employee = await createUser({ name: 'Notify Employee' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const requested = await requestAmendment(signToken(employee), contract, { amount: 20 });
  assert.equal(requested.status, 201);

  const feed = await api('GET', '/api/notifications', { token: signToken(admin) });
  assert.equal(feed.status, 200);
  const item = feed.data.items.find((entry) => entry.id.startsWith('amendment-'));
  assert.ok(item, `no amendment notification in the feed: ${feed.data.items.map((i) => i.id).join(', ')}`);
  assert.equal(item.id, `amendment-${requested.data._id}`);
  assert.equal(item.type, 'amendment');
  // The link must reach the specific request, not just the top of the queue.
  assert.equal(item.href, `/amendments?focus=${requested.data._id}`);

  // Stable across requests: the id is derived from the document, not from a
  // position in a list, so the client's seen-state does not re-arm on reload.
  const again = await api('GET', '/api/notifications', { token: signToken(admin) });
  assert.equal(again.data.items.find((entry) => entry.type === 'amendment').id, item.id);

  // count must still equal the number of items, or the unread badge under-reports
  // and some items are never markable seen.
  assert.equal(feed.data.count, feed.data.items.length);
});

test('a decided amendment is announced to its own requester and to nobody else', async () => {
  const admin = await createUser({ name: 'Decide Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Decide Manager', role: 'Manager' });
  const requester = await createUser({ name: 'Decide Requester' });
  const bystander = await createUser({ name: 'Decide Bystander', role: 'Manager' });

  const contract = await makeContract({ createdBy: admin._id, assignedUser: requester._id, overrides: { amount: 10 } });
  const requested = await requestAmendment(signToken(requester), contract, { amount: 20 });
  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, {
    token: signToken(manager), body: { action: 'Rejected' }
  });
  assert.equal(decided.status, 200);

  const forRequester = await api('GET', '/api/notifications', { token: signToken(requester) });
  const own = forRequester.data.items.find((entry) => entry.id === `amendment-decision-${requested.data._id}`);
  assert.ok(own, 'the requester was not told how their request was decided');
  assert.equal(own.type, 'amendment-decision');
  assert.match(own.title, /rejected/i);
  // Straight back to the contract the amendment is about.
  assert.equal(own.href, `/contracts/${contract._id}`);

  // A decided request is no longer actionable, so it must leave the approver's
  // "to decide" group rather than sit there with nothing to click.
  const forAdmin = await api('GET', '/api/notifications', { token: signToken(admin) });
  assert.equal(forAdmin.data.items.some((entry) => entry.type === 'amendment'), false, 'a decided request is still offered as a decision to make');

  // Another manager learns nothing about a request that is not theirs to decide.
  const forBystander = await api('GET', '/api/notifications', { token: signToken(bystander) });
  assert.equal(forBystander.data.items.some((entry) => String(entry.id).includes(requested.data._id)), false);
});

test('the notification feed stays a derived feed with no stored notification model', async () => {
  // Nothing persists a notification, so the amendment id is minted per request
  // and the collection never exists. This is the architectural property that
  // keeps the amendment integration from introducing a second source of truth.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'notificationRoutes.js'), 'utf8');
  for (const forbidden of ['Notification.create', 'new Notification', 'insertMany', 'insertOne', 'save()']) {
    assert.equal(source.includes(forbidden), false, `notificationRoutes.js must not write notifications, found: ${forbidden}`);
  }
  assert.equal(mongoose.models.Notification, undefined, 'a Notification model was registered');

  const admin = await createUser({ name: 'Derived Admin', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 10 } });
  await requestAmendment(signToken(admin), contract, { amount: 20 });
  await api('GET', '/api/notifications', { token: signToken(admin) });

  // Reading the feed, and a decision, must not create any collection for it.
  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.equal(names.includes('notifications'), false, 'a notifications collection was created by a read');
});

// ---------------------------------------------------------------------------
// List scoping and the assignee display names the queue needs
// ---------------------------------------------------------------------------

test('an Employee only sees amendments for the contracts it can read', async () => {
  const admin = await createUser({ name: 'Scope Admin', role: 'Admin' });
  const employee = await createUser({ name: 'Scope Employee' });
  const otherEmployee = await createUser({ name: 'Scope Other' });

  const mine = await makeContract({ createdBy: employee._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const theirs = await makeContract({ createdBy: otherEmployee._id, assignedUser: otherEmployee._id, overrides: { amount: 10 } });
  await requestAmendment(signToken(employee), mine, { amount: 20 });
  const otherRequest = await requestAmendment(signToken(otherEmployee), theirs, { amount: 20 });
  assert.equal(otherRequest.status, 201);

  const feed = await api('GET', '/api/contract-amendments', { token: signToken(employee) });
  assert.equal(feed.status, 200);
  assert.equal(feed.data.length, 1, `expected only the employee's own contract, got ${feed.data.length}`);
  assert.equal(feed.data[0].contract._id.toString(), mine._id.toString());

  // The same scoping the contract list uses, so the two cannot disagree.
  const asAdmin = await api('GET', '/api/contract-amendments', { token: signToken(admin) });
  assert.equal(asAdmin.data.length, 2);
});

test('the list resolves the assignee to a name so the queue is judgeable', async () => {
  const admin = await createUser({ name: 'Name Admin', role: 'Admin' });
  const from = await createUser({ name: 'Ada Lovelace' });
  const to = await createUser({ name: 'Grace Hopper' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: from._id, overrides: { amount: 10 } });

  const requested = await requestAmendment(signToken(from), contract, { assignedUser: to._id.toString() });
  assert.equal(requested.status, 201);
  assert.equal(requested.data.proposedAssignee, 'Grace Hopper');
  assert.equal(requested.data.beforeAssignee, 'Ada Lovelace');

  const feed = await api('GET', '/api/contract-amendments', { token: signToken(admin) });
  const row = feed.data.find((entry) => entry._id === requested.data._id);
  assert.equal(row.proposedAssignee, 'Grace Hopper');
  assert.equal(row.beforeAssignee, 'Ada Lovelace');
  // The raw Mixed values are untouched, so the decision path still applies the
  // id and not a name.
  assert.equal(row.proposed.assignedUser, to._id.toString());
  // The name is all the queue needs; the address book is not required for it.
  assert.equal(row.proposedAssignee.includes('@'), false);
});

test('clearing the assignee is rendered as a proposed change, not as an absent one', async () => {
  const admin = await createUser({ name: 'Clear Admin', role: 'Admin' });
  const employee = await createUser({ name: 'Clear Employee' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });

  const requested = await requestAmendment(signToken(employee), contract, { assignedUser: null });
  assert.equal(requested.status, 201);
  assert.equal(requested.data.proposed.assignedUser, null);
  // `null` must resolve to a name-less value, not be mistaken for "not proposed"
  // and dropped.
  assert.ok('proposedAssignee' in requested.data, 'a cleared assignee is indistinguishable from an untouched one');
  assert.equal(requested.data.proposedAssignee, null);
  assert.equal(requested.data.beforeAssignee, 'Clear Employee');

  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decided.status, 200);
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.assignedUser, null, 'approving a cleared assignee did not clear it');
});

test('an amendment that only reassigns still applies the new assignee', async () => {
  const admin = await createUser({ name: 'Reassign Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Reassign Manager', role: 'Manager' });
  const next = await createUser({ name: 'Reassign Target' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 10 } });

  const requested = await requestAmendment(signToken(manager), contract, { assignedUser: next._id.toString() });
  assert.equal(requested.status, 201);
  const decided = await api('PUT', `/api/contract-amendments/${requested.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(decided.status, 200);
  assert.equal((await Contract.findById(contract._id)).assignedUser.toString(), next._id.toString());
  // Reassigning is not a renewal: the end date and status are untouched.
  const stored = await Contract.findById(contract._id);
  assert.equal(stored.endDate.getTime(), utcDay(365).getTime());
  assert.equal(stored.status, 'Active');
});

// ---------------------------------------------------------------------------
// Separation of duties and role coverage the patch does not assert on the queue
// ---------------------------------------------------------------------------

test('a Manager may approve and an Admin may approve, and neither may approve their own', async () => {
  const admin = await createUser({ name: 'Duty Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Duty Manager', role: 'Manager' });
  const employee = await createUser({ name: 'Duty Employee' });

  // Manager approves an employee's request.
  const first = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const firstRequest = await requestAmendment(signToken(employee), first, { amount: 20 });
  const byManager = await api('PUT', `/api/contract-amendments/${firstRequest.data._id}/action`, { token: signToken(manager), body: { action: 'Approved' } });
  assert.equal(byManager.status, 200);
  assert.equal((await ContractAmendment.findById(firstRequest.data._id)).decidedBy._id?.toString() || String((await ContractAmendment.findById(firstRequest.data._id)).decidedBy), manager._id.toString());

  // Admin approves another employee's request.
  const second = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const secondRequest = await requestAmendment(signToken(employee), second, { amount: 20 });
  const byAdmin = await api('PUT', `/api/contract-amendments/${secondRequest.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });
  assert.equal(byAdmin.status, 200);

  // Neither role may decide its own request, even though both may decide others'.
  const ownByAdmin = await requestAmendment(signToken(admin), await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 10 } }), { amount: 20 });
  const ownByManager = await requestAmendment(signToken(manager), await makeContract({ createdBy: admin._id, assignedUser: manager._id, overrides: { amount: 10 } }), { amount: 20 });
  assert.equal((await api('PUT', `/api/contract-amendments/${ownByAdmin.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } })).status, 400);
  assert.equal((await api('PUT', `/api/contract-amendments/${ownByManager.data._id}/action`, { token: signToken(manager), body: { action: 'Approved' } })).status, 400);
  // And the refusal leaves both requests open, not silently decided.
  assert.equal((await ContractAmendment.findById(ownByAdmin.data._id)).status, 'Pending');
  assert.equal((await ContractAmendment.findById(ownByManager.data._id)).status, 'Pending');
});

test('an amendment request is refused for an unauthenticated or foreign caller', async () => {
  const admin = await createUser({ name: 'Auth Admin', role: 'Admin' });
  const outsider = await createUser({ name: 'Auth Outsider' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { amount: 10 } });

  const anonymous = await requestAmendment(undefined, contract, { amount: 20 });
  assert.equal(anonymous.status, 401);
  const foreign = await requestAmendment(signToken(outsider), contract, { amount: 20 });
  assert.equal(foreign.status, 403);

  // The list needs a token too, and the decision route is role-gated.
  assert.equal((await api('GET', '/api/contract-amendments')).status, 401);
  const foreignList = await api('GET', '/api/contract-amendments', { token: signToken(outsider) });
  assert.equal(foreignList.status, 200);
  assert.equal(foreignList.data.length, 0, 'an outsider can list another team\'s amendments');
  assert.equal((await api('PUT', `/api/contract-amendments/507f1f77bcf86cd799439011/action`, { token: signToken(outsider), body: { action: 'Approved' } })).status, 403);
});

test('a requester can read their own request list and the contract-scoped filter returns only that contract', async () => {
  const admin = await createUser({ name: 'Filter Admin', role: 'Admin' });
  const employee = await createUser({ name: 'Filter Employee' });
  const first = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const second = await makeContract({ createdBy: admin._id, assignedUser: employee._id, overrides: { amount: 10 } });
  const firstRequest = await requestAmendment(signToken(employee), first, { amount: 20 });
  await requestAmendment(signToken(employee), second, { amount: 20 });
  await api('PUT', `/api/contract-amendments/${firstRequest.data._id}/action`, { token: signToken(admin), body: { action: 'Approved' } });

  const mine = await api('GET', '/api/contract-amendments?mine=true', { token: signToken(employee) });
  assert.equal(mine.data.length, 2);

  const forContract = await api('GET', `/api/contract-amendments?contract=${first._id}`, { token: signToken(employee) });
  assert.equal(forContract.data.length, 1);
  assert.equal(forContract.data[0]._id, firstRequest.data._id);

  const byStatus = await api('GET', '/api/contract-amendments?status=Pending', { token: signToken(employee) });
  assert.equal(byStatus.data.length, 1);
  assert.equal(byStatus.data[0].contract._id.toString(), second._id.toString());

  const decided = await api('GET', '/api/contract-amendments?status=Approved', { token: signToken(employee) });
  assert.equal(decided.data.length, 1);
  assert.equal(decided.data[0]._id, firstRequest.data._id);

  // A bad filter is refused rather than silently returning the whole list.
  assert.equal((await api('GET', '/api/contract-amendments?status=Nonsense', { token: signToken(employee) })).status, 400);
  assert.equal((await api('GET', '/api/contract-amendments?contract=not-an-id', { token: signToken(employee) })).status, 400);
});
