// Issue 33 - Contracts List / Contract Details: IDOR, RBAC and archive scope.
//
// WHAT THIS COVERS
// ----------------
// The Contracts List and the Contract Details page are the two screens that read
// a contract and the records hanging off it. Both are covered end to end here:
//
//   1. Cross-contract leakage. `GET /documents/contract/:contractId` and
//      `GET /contract-amendments?contract=<id>` take a contract id and return
//      records for it. A caller must never be able to name a contract they
//      cannot open and still read its documents, its downloads or its amendment
//      trail - the trail in particular carries the before/after amount, currency,
//      dates and assignee name.
//   2. The listing scope. `GET /contracts` and `GET /contract-amendments` must
//      agree about who sees the repository. They did not: the amendment queue
//      scoped with the inverse predicate `role === 'Employee'`, so any role that
//      was merely NOT 'Employee' - including a value outside the vocabulary -
//      was handed the company-wide queue while every other listing route and
//      `canAccessContract` scoped it like an Employee.
//   3. The archived-contract freeze. Documents, obligations, milestones,
//      renewals, approvals and amendments all refuse to write to an archived
//      contract. `PUT /contracts/:id` did not, so the archive was not a freeze
//      for the contract itself. Status-only changes stay allowed, mirroring
//      utils/itemUpdate.js.
//   4. Invalid ObjectIds and missing contracts: 4xx, never a 500.
//
// Every fixture here is created in this file's own disposable database. No
// production or development data is read or written.

const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const ContractAmendment = require('../models/ContractAmendment');
const ActivityLog = require('../models/ActivityLog');

const contractRoutes = require('../routes/contractRoutes');
const documentRoutes = require('../routes/documentRoutes');
const amendmentRoutes = require('../routes/amendmentRoutes');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const { createMockStorage } = require('./helpers/mockStorage');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');
const { PRIVILEGED_ROLES, isPrivileged } = require('../utils/access');

const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_issue33_scope_test');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;
let mockStorage;
let userSeed = 0;
let numberSeed = 0;

const utcDay = (daysFromToday) => new Date(Date.UTC(
  new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
) + daysFromToday * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, role = 'Employee', status = 'Active' }) => {
  userSeed += 1;
  return User.create({
    name: name || `Issue33 User ${userSeed}`,
    email: `issue33.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role,
    status
  });
};

const makeContract = async ({ createdBy, assignedUser, status = 'Draft', isArchived = false, overrides = {} }) => {
  numberSeed += 1;
  return Contract.create({
    contractNumber: `I33-${Date.now()}-${numberSeed}`,
    title: 'Original title',
    type: 'Vendor',
    partyName: 'Original counterparty',
    description: 'Original description',
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
};

// Simulates the state a bad migration, a renamed role, a future role or the old
// null-role bug leaves behind. The HTTP API cannot produce it (the User model
// enum refuses it), but rows written before that fix, or by any other writer,
// can still carry it - and the listing routes must not be broader than
// canAccessContract, which already refuses such a user on GET /contracts/:id.
const forceRole = async (user, role) => {
  await User.collection.updateOne({ _id: user._id }, { $set: { role } });
  return User.findById(user._id);
};

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
  app.use('/api/contracts', contractRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/contract-amendments', amendmentRoutes);
  app.use((error, req, res, next) => {
    if (error.name === 'ValidationError') return res.status(400).json({ message: error.message });
    if (error.name === 'CastError') return res.status(400).json({ message: `Invalid value for '${error.path}'` });
    return res.status(500).json({ message: 'Internal server error' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);
});

test.beforeEach(async () => {
  await Contract.deleteMany({});
  await ContractDocument.deleteMany({});
  await ContractAmendment.deleteMany({});
  await ActivityLog.deleteMany({});
  await User.deleteMany({});
  mockStorage.reset();
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  resetStorageAdapter();
  if (mockStorage) mockStorage.cleanup();
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// 1. Cross-contract leakage
// ---------------------------------------------------------------------------

test('an Employee cannot open, edit, list documents for, or read the amendment trail of a contract they have no part in', async () => {
  const owner = await createUser({ name: 'Owner' });
  const outsider = await createUser({ name: 'Outsider' });
  const ownerToken = signToken(owner);
  const outsiderToken = signToken(outsider);

  const contract = await makeContract({ createdBy: owner._id, assignedUser: owner._id, status: 'Active' });
  await ContractDocument.create({
    contract: contract._id,
    filename: 'secret.pdf',
    originalname: 'secret.pdf',
    storageBackend: 'local',
    storageKey: 'secret.pdf',
    fileSize: 4,
    fileType: 'application/pdf',
    version: 1,
    uploadedBy: owner._id
  });
  await ContractAmendment.create({
    contract: contract._id,
    requestedBy: owner._id,
    proposed: { amount: 4242 },
    reason: 'Renegotiated price',
    before: { amount: 1000, currency: 'USD' },
    status: 'Pending'
  });

  const detail = await api('GET', `/api/contracts/${contract._id}`, { token: outsiderToken });
  assert.equal(detail.status, 403, 'detail read must be refused');

  const docs = await api('GET', `/api/documents/contract/${contract._id}`, { token: outsiderToken });
  assert.equal(docs.status, 403, 'document listing must be refused before any query');

  const trail = await api('GET', `/api/contract-amendments?contract=${contract._id}`, { token: outsiderToken });
  assert.equal(trail.status, 200, 'the amendment list itself is not a gate');
  assert.deepEqual(trail.data, [], 'but it must not leak a single record of a contract the caller cannot open');

  const edit = await api('PUT', `/api/contracts/${contract._id}`, {
    token: outsiderToken, body: { title: 'Hijacked' }
  });
  assert.equal(edit.status, 403, 'edit must be refused');

  const archive = await api('PATCH', `/api/contracts/${contract._id}/archive`, { token: outsiderToken });
  assert.equal(archive.status, 403, 'archive must be refused');

  // The owner is unaffected by any of the refusals above.
  assert.equal((await api('GET', `/api/contracts/${contract._id}`, { token: ownerToken })).status, 200);
  assert.equal((await api('GET', `/api/documents/contract/${contract._id}`, { token: ownerToken })).data.length, 1);
  assert.equal((await api('GET', `/api/contract-amendments?contract=${contract._id}`, { token: ownerToken })).data.length, 1);
});

test('a document download is refused for a contract the caller has no part in, and served for one they do', async () => {
  const owner = await createUser({ name: 'Doc Owner' });
  const outsider = await createUser({ name: 'Doc Outsider' });
  const contract = await makeContract({ createdBy: owner._id, assignedUser: owner._id });
  const body = Buffer.from('%PDF-1.4 test');
  const key = 'issue33/download.pdf';
  await mockStorage.adapter.upload({ key, body, contentType: 'application/pdf', filename: 'download.pdf' });
  const doc = await ContractDocument.create({
    contract: contract._id,
    filename: 'download.pdf',
    originalname: 'download.pdf',
    storageBackend: mockStorage.adapter.backend,
    storageKey: key,
    fileSize: body.length,
    fileType: 'application/pdf',
    version: 1,
    uploadedBy: owner._id
  });

  const denied = await api('GET', `/api/documents/download/${doc._id}`, { token: signToken(outsider) });
  assert.equal(denied.status, 403, 'download must be refused');

  const allowed = await fetch(`${baseURL}/api/documents/download/${doc._id}`, {
    headers: { authorization: `Bearer ${signToken(owner)}` }
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), '%PDF-1.4 test');
});

test('the documents and amendments returned for a contract contain only that contract\'s records', async () => {
  const owner = await createUser({ name: 'Scoped Owner' });
  const token = signToken(owner);
  const mine = await makeContract({ createdBy: owner._id, assignedUser: owner._id });
  const theirs = await makeContract({ createdBy: new mongoose.Types.ObjectId(), overrides: { title: 'Someone else' } });

  for (const [contract, name] of [[mine, 'mine.pdf'], [theirs, 'theirs.pdf']]) {
    await ContractDocument.create({
      contract: contract._id,
      filename: name,
      originalname: name,
      storageBackend: 'local',
      storageKey: name,
      fileSize: 1,
      fileType: 'application/pdf',
      version: 1,
      uploadedBy: owner._id
    });
    await ContractAmendment.create({
      contract: contract._id,
      requestedBy: owner._id,
      proposed: { amount: 5 },
      reason: 'reason',
      before: { amount: 1 },
      status: 'Pending'
    });
  }

  const docs = await api('GET', `/api/documents/contract/${mine._id}`, { token });
  assert.equal(docs.data.length, 1);
  assert.equal(docs.data[0].originalname, 'mine.pdf');

  const trail = await api('GET', `/api/contract-amendments?contract=${mine._id}`, { token });
  assert.equal(trail.data.length, 1);
  assert.equal(String(trail.data[0].contract._id || trail.data[0].contract), String(mine._id));
});

// ---------------------------------------------------------------------------
// 2. The listing scope: GET /contracts and GET /contract-amendments must agree
// ---------------------------------------------------------------------------

test('an unprivileged role outside the vocabulary sees only its own contracts\' amendments, like GET /contracts', async () => {
  const stranger = await forceRole(await createUser({ name: 'Stranger' }), 'Guest');
  const strangerToken = signToken(stranger);
  const mine = await makeContract({ createdBy: stranger._id, assignedUser: stranger._id, status: 'Active' });
  const theirs = await makeContract({ createdBy: new mongoose.Types.ObjectId(), status: 'Active' });

  await ContractAmendment.create({
    contract: mine._id, requestedBy: stranger._id, proposed: { amount: 11 },
    reason: 'mine', before: { amount: 1 }, status: 'Pending'
  });
  await ContractAmendment.create({
    contract: theirs._id, requestedBy: theirs.createdBy, proposed: { amount: 22 },
    reason: 'theirs', before: { amount: 2 }, status: 'Pending'
  });

  // GET /contracts already scopes this role: canAccessContract refuses the
  // stranger the contract it cannot open.
  const contracts = await api('GET', '/api/contracts?limit=100', { token: strangerToken });
  assert.equal(contracts.status, 200);
  assert.ok(
    contracts.data.contracts.every((c) => String(c._id) === String(mine._id)),
    'GET /contracts must not list a contract this role cannot open'
  );
  assert.equal((await api('GET', `/api/contracts/${theirs._id}`, { token: strangerToken })).status, 403);

  // The amendment queue must agree. Before the fix it asked "is this an
  // Employee?", so 'Guest' - not 'Employee' - took the repository-wide branch
  // and was handed a contract its own detail route refuses.
  const trail = await api('GET', '/api/contract-amendments', { token: strangerToken });
  assert.equal(trail.status, 200);
  assert.deepEqual(
    trail.data.map((a) => String(a.reason)).sort(),
    ['mine'],
    'only the amendments of contracts this role may read may be listed'
  );
  assert.ok(
    trail.data.every((a) => String(a.contract._id || a.contract) === String(mine._id)),
    'no record of an inaccessible contract may appear'
  );
});

test('an Employee amendment queue stays scoped and Admin/Manager still see the whole repository', async () => {
  const employee = await createUser({ name: 'Queue Employee' });
  const admin = await createUser({ name: 'Queue Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Queue Manager', role: 'Manager' });
  const mine = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Active' });
  const theirs = await makeContract({ createdBy: new mongoose.Types.ObjectId(), status: 'Active' });

  await ContractAmendment.create({
    contract: mine._id, requestedBy: employee._id, proposed: { amount: 1 },
    reason: 'mine', before: { amount: 0 }, status: 'Pending'
  });
  await ContractAmendment.create({
    contract: theirs._id, requestedBy: theirs.createdBy, proposed: { amount: 2 },
    reason: 'theirs', before: { amount: 0 }, status: 'Rejected'
  });

  const asEmployee = await api('GET', '/api/contract-amendments', { token: signToken(employee) });
  assert.deepEqual(asEmployee.data.map((a) => a.reason), ['mine']);

  for (const privileged of [admin, manager]) {
    assert.ok(isPrivileged(privileged), 'the fixture must be a privileged role');
    const all = await api('GET', '/api/contract-amendments', { token: signToken(privileged) });
    assert.deepEqual(all.data.map((a) => a.reason).sort(), ['mine', 'theirs']);
  }
});

// ---------------------------------------------------------------------------
// 3. The archived-contract freeze
// ---------------------------------------------------------------------------

test('an archived contract is frozen for every writable field, but its status may still progress', async () => {
  const admin = await createUser({ name: 'Archive Admin', role: 'Admin' });
  const manager = await createUser({ name: 'Archive Manager', role: 'Manager' });
  const token = signToken(admin);
  const contract = await makeContract({
    createdBy: admin._id, assignedUser: manager._id, status: 'Active', isArchived: true
  });

  for (const body of [
    { title: 'Renamed after archiving' },
    { partyName: 'New counterparty' },
    { description: 'Rewritten' },
    { type: 'Client' },
    { currency: 'EUR' },
    { amount: 1 },
    { endDate: utcDay(900).toISOString() },
    { assignedUser: null }
  ]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, { token, body });
    assert.equal(res.status, 400, `expected a refusal for ${JSON.stringify(body)}`);
    assert.match(res.data.message, /Archived contracts cannot be edited/);
  }

  const stored = await Contract.findById(contract._id);
  assert.equal(stored.title, 'Original title');
  assert.equal(stored.currency, 'USD');
  assert.equal(stored.amount, 1000);
  assert.equal(String(stored.assignedUser), String(manager._id));

  // Status is the documented exception, mirroring utils/itemUpdate.js: a lapsed
  // contract still has to be able to reach the terminal state.
  const closed = await api('PUT', `/api/contracts/${contract._id}`, { token, body: { status: 'Closed' } });
  assert.equal(closed.status, 200);
  assert.equal((await Contract.findById(contract._id)).status, 'Closed');
});

test('an archived contract is still readable, and a non-archived one is still editable', async () => {
  const admin = await createUser({ name: 'Read Admin', role: 'Admin' });
  const token = signToken(admin);
  const archived = await makeContract({ createdBy: admin._id, assignedUser: admin._id, isArchived: true });
  const live = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  assert.equal((await api('GET', `/api/contracts/${archived._id}`, { token })).status, 200);

  const edited = await api('PUT', `/api/contracts/${live._id}`, { token, body: { title: 'Renamed' } });
  assert.equal(edited.status, 200);
  assert.equal((await Contract.findById(live._id)).title, 'Renamed');
});

test('an archived contract is hidden from GET /contracts but not hidden from a direct read', async () => {
  const admin = await createUser({ name: 'List Admin', role: 'Admin' });
  const token = signToken(admin);
  const archived = await makeContract({ createdBy: admin._id, assignedUser: admin._id, isArchived: true });
  const live = await makeContract({ createdBy: admin._id, assignedUser: admin._id });

  const list = await api('GET', '/api/contracts?limit=100', { token });
  const ids = list.data.contracts.map((c) => String(c._id));
  assert.ok(ids.includes(String(live._id)));
  assert.ok(!ids.includes(String(archived._id)), 'the archive must not show in the repository listing');

  // Intentional and asymmetric: the record stays readable by direct link, which
  // is what makes an archived contract auditable after it leaves the list.
  assert.equal((await api('GET', `/api/contracts/${archived._id}`, { token })).status, 200);
});

// ---------------------------------------------------------------------------
// 4. Malformed and missing identifiers
// ---------------------------------------------------------------------------

test('a malformed contract id is a 400 on every contract-scoped route, never a 500', async () => {
  const owner = await createUser({ name: 'Malformed Owner' });
  const token = signToken(owner);
  const bad = 'not-an-object-id';

  for (const [method, url, body] of [
    ['GET', `/api/contracts/${bad}`, undefined],
    ['PUT', `/api/contracts/${bad}`, { title: 'x' }],
    ['PATCH', `/api/contracts/${bad}/archive`, undefined],
    ['GET', `/api/documents/contract/${bad}`, undefined],
    ['GET', `/api/documents/download/${bad}`, undefined],
    ['GET', `/api/contract-amendments?contract=${bad}`, undefined],
    ['POST', '/api/contract-amendments', { contract: bad, proposed: { amount: 1 }, reason: 'x' }]
  ]) {
    const res = await api(method, url, { token, body });
    assert.ok(res.status >= 400 && res.status < 500, `${method} ${url} returned ${res.status}`);
    assert.notEqual(res.status, 500, `${method} ${url} must not be a server error`);
  }
});

test('a well-formed id that matches nothing is a 404, not a 403', async () => {
  const owner = await createUser({ name: 'Missing Owner' });
  const admin = await createUser({ name: 'Missing Admin', role: 'Admin' });
  const token = signToken(owner);
  const absent = new mongoose.Types.ObjectId();

  assert.equal((await api('GET', `/api/contracts/${absent}`, { token })).status, 404);
  assert.equal((await api('PUT', `/api/contracts/${absent}`, { token, body: { title: 'x' } })).status, 404);
  assert.equal((await api('GET', `/api/documents/contract/${absent}`, { token })).status, 404);

  // Archive carries a role guard ahead of the lookup, so the 404 is only
  // observable by a caller who would have been allowed to archive it anyway.
  assert.equal((await api('PATCH', `/api/contracts/${absent}/archive`, { token })).status, 403);
  assert.equal((await api('PATCH', `/api/contracts/${absent}/archive`, { token: signToken(admin) })).status, 404);
});

// ---------------------------------------------------------------------------
// 5. The static guard that keeps the amendment queue from failing open again
// ---------------------------------------------------------------------------

test('no route reintroduces the fail-open "is this an Employee?" predicate', () => {
  const fs = require('node:fs');
  const routeDir = path.join(__dirname, '..', 'routes');
  const files = fs.readdirSync(routeDir).filter((name) => name.endsWith('.js'));

  // Comments are stripped first: a route may legitimately *name* the predicate
  // in the comment that explains why it must not come back.
  const executableSource = (source) => source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  // Inverted membership: `role === 'Employee'` treats every other value as
  // privileged. utils/access.js and utils/itemUpdate.js both carry this rule, and
  // the amendment queue is the one route that had reintroduced it.
  const failOpen = /role\s*(===|!==)\s*'Employee'/;
  const duplicatedList = /\[\s*'Admin'\s*,\s*'Manager'\s*\]\s*\.includes/;

  for (const file of files) {
    const source = executableSource(fs.readFileSync(path.join(routeDir, file), 'utf8'));
    assert.doesNotMatch(source, failOpen, `routes/${file} must scope from the allow-list, not from an Employee test`);
    assert.doesNotMatch(source, duplicatedList, `routes/${file} must use isPrivileged, not a copied role list`);
  }
});

test('the privileged allow-list is unchanged by this issue', () => {
  assert.deepEqual([...PRIVILEGED_ROLES].sort(), ['Admin', 'Manager']);
});