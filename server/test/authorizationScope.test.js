// PHASE-11 authorization regression tests.
//
// Each test here corresponds to a defect confirmed against a running instance
// during the Phase-11 audit, and each one fails against the pre-fix code. They
// run against a disposable database and a mocked storage adapter, so nothing
// they touch can reach real data or a real storage bucket.
//
// Covered:
//   1. PUT /api/users/:id/role rejects null and non-string role/status
//      (a mongoose enum alone lets null through, which is how a user with a
//       null role was created in the first place)
//   2. A user whose stored role is not in the privileged allow-list is scoped
//      like an Employee on every listing route, exactly as canAccessContract
//      already scoped them on GET /contracts/:id
//   3. An unrecognised role cannot edit another user's obligation or milestone
//   4. release:verify asserts the Supabase variable names the adapter reads
//   5. No route may reintroduce the fail-open "is this an Employee?" predicate
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'https://app.ricoz.test';

const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');

const { createApp } = require('../app');
const { isPrivileged, canAccessContract } = require('../utils/access');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const { createMockStorage } = require('./helpers/mockStorage');

const SERVER_ROOT = path.join(__dirname, '..');
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_phase11_authz_test';

let server;
let baseURL;
let mockStorage;
let contractNumberSeed = 0;
let userSeed = 0;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, role = 'Employee', status = 'Active' }) => {
  userSeed += 1;
  return User.create({
    name: name || `Authz User ${userSeed}`,
    email: `phase11authz.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role,
    status
  });
};

const createContract = async (overrides = {}) => {
  contractNumberSeed += 1;
  return Contract.create({
    contractNumber: `CNT-AUTHZ-${String(contractNumberSeed).padStart(6, '0')}`,
    title: 'Authz test contract',
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
  return { status: response.status, data, headers: response.headers };
};

// The production connection sets autoIndex:false; this one is left at the
// default so the disposable collections get their declared indexes and the
// suite is not measuring query plans.
test.before(async () => {
  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

// Several tests assert exact row counts, so each one starts from empty
// collections. Without this a contract created by an earlier test would still
// be in the repository for the next one, and the count assertions below would
// pass or fail for the wrong reason.
test.beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Contract.deleteMany({}),
    Obligation.deleteMany({}),
    Milestone.deleteMany({})
  ]);
  mockStorage.reset();
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
// 1. PUT /api/users/:id/role input validation
// ---------------------------------------------------------------------------

test('a null role is rejected instead of being stored', async () => {
  const admin = await createUser({ name: 'Null Role Admin', role: 'Admin' });
  const target = await createUser({ name: 'Null Role Target' });
  const token = signToken(admin);

  // Pre-fix this answered 200 and persisted role:null. A mongoose `enum`
  // rejects a value that is present and not in the list, but null is not
  // "present" - and `role` is not `required`, so nothing else caught it.
  const response = await api('PUT', `/api/users/${target._id}/role`, { token, body: { role: null } });

  assert.equal(response.status, 400, 'null is not a valid role');
  assert.match(response.data.message, /Admin, Manager, Employee/);
  assert.equal((await User.findById(target._id)).role, 'Employee', 'the stored role is unchanged');
});

test('a null status is rejected and cannot silently de-deactivate an account', async () => {
  const admin = await createUser({ name: 'Null Status Admin', role: 'Admin' });
  const target = await createUser({ name: 'Null Status Target' });
  const token = signToken(admin);

  // Pre-fix this answered 200 and stored status:null. auth.js refuses only
  // `status === 'Inactive'`, so such an account stayed fully authenticated
  // while dropping out of the last-administrator census and out of
  // GET /api/users/directory, which selects on { status: 'Active' }.
  const response = await api('PUT', `/api/users/${target._id}/role`, { token, body: { status: null } });

  assert.equal(response.status, 400);
  assert.equal((await User.findById(target._id)).status, 'Active', 'the stored status is unchanged');

  const me = await api('GET', '/api/users/me', { token: signToken(target) });
  assert.equal(me.data.status, 'Active', 'and the account is still a normal Active user');
});

test('a non-string role or status is rejected', async () => {
  const admin = await createUser({ name: 'Type Admin', role: 'Admin' });
  const target = await createUser({ name: 'Type Target' });
  const token = signToken(admin);

  for (const body of [
    { role: 5 },
    { role: true },
    { role: ['Admin'] },
    { role: { $ne: null } },
    { status: 0 },
    { status: 'deleted' },
    { status: [] }
  ]) {
    const response = await api('PUT', `/api/users/${target._id}/role`, { token, body });
    assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
  }

  const stored = await User.findById(target._id);
  assert.equal(stored.role, 'Employee');
  assert.equal(stored.status, 'Active');
});

test('a value outside the enum is still rejected with a validation message', async () => {
  const admin = await createUser({ name: 'Enum Admin', role: 'Admin' });
  const target = await createUser({ name: 'Enum Target' });
  const token = signToken(admin);

  for (const role of ['SuperAdmin', 'admin', 'Employee ', 'ADMIN']) {
    const response = await api('PUT', `/api/users/${target._id}/role`, { token, body: { role } });
    assert.equal(response.status, 400, `role ${JSON.stringify(role)} must be rejected`);
  }
  assert.equal((await User.findById(target._id)).role, 'Employee');
});

test('valid role and status changes still work', async () => {
  const admin = await createUser({ name: 'Valid Admin', role: 'Admin' });
  const target = await createUser({ name: 'Valid Target' });
  const token = signToken(admin);

  const promoted = await api('PUT', `/api/users/${target._id}/role`, { token, body: { role: 'Manager' } });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.user.role, 'Manager');

  const deactivated = await api('PUT', `/api/users/${target._id}/role`, { token, body: { status: 'Inactive' } });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.data.user.status, 'Inactive');

  // A deactivated account must be refused by the auth middleware.
  const refused = await api('GET', '/api/users/me', { token: signToken(target) });
  assert.equal(refused.status, 401, 'an Inactive account cannot keep using an old token');
});

// ---------------------------------------------------------------------------
// 2. Scope fails closed for every role outside the privileged allow-list
// ---------------------------------------------------------------------------

// Simulates the state a bad migration, a renamed role, a future role or the
// null-role bug leaves behind. The HTTP API can no longer produce it (test 1),
// but rows written before the fix, or by any other writer, can still carry it -
// and the listing routes must not be broader than `canAccessContract`, which
// refused such a user before this audit touched them.
const forceRole = async (user, role) => {
  await User.collection.updateOne({ _id: user._id }, { $set: { role } });
  return User.findById(user._id);
};

test('isPrivileged grants the repository only to Admin and Manager', () => {
  for (const role of ['Admin', 'Manager']) {
    assert.equal(isPrivileged({ role }), true, `${role} is privileged`);
  }
  for (const role of [undefined, null, '', 'Employee', 'employee', 'EMPLOYEE', 'Admin ', 'SuperAdmin', 0, 1]) {
    assert.equal(isPrivileged({ role }), false, `${JSON.stringify(role)} is not privileged`);
  }
  assert.equal(isPrivileged(null), false);
  assert.equal(isPrivileged(undefined), false);
});

test('an unrecognised role lists only its own contracts, not the whole repository', async () => {
  const owner = await createUser({ name: 'Scope Owner' });
  await createContract({ createdBy: owner._id, assignedUser: owner._id, title: 'Not for you' });
  const mine = await createContract({ createdBy: owner._id, assignedUser: owner._id, title: 'Mine' });

  const rogue = await forceRole(await createUser({ name: 'Scope Rogue' }), 'SuperAdmin');
  const token = signToken(rogue);

  const list = await api('GET', '/api/contracts', { token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data), 'an unprivileged role still receives a plain list');
  // No contract was ever created by or assigned to the rogue account, so the
  // repository-wide result it used to receive is now empty.
  assert.equal(list.data.length, 0, 'the whole repository is no longer disclosed');

  const own = await api('GET', `/api/contracts/${mine._id}`, { token });
  assert.equal(own.status, 403, 'and the single-record read is refused, exactly as before this audit');
});

test('an unrecognised role gets a dashboard scoped like an Employee', async () => {
  const owner = await createUser({ name: 'Dash Owner' });
  await createContract({ createdBy: owner._id, assignedUser: owner._id, status: 'Active' });

  const manager = await createUser({ name: 'Dash Manager', role: 'Manager' });
  const rogue = await forceRole(await createUser({ name: 'Dash Rogue' }), null);

  const asManager = await api('GET', '/api/reports/dashboard', { token: signToken(manager) });
  const asRogue = await api('GET', '/api/reports/dashboard', { token: signToken(rogue) });

  assert.equal(asManager.data.metrics.total, 1, 'a Manager sees the repository');
  assert.equal(asRogue.status, 200);
  assert.equal(asRogue.data.metrics.total, 0, 'a null role is scoped, not privileged');
});

test('an unrecognised role sees only its own work items', async () => {
  const owner = await createUser({ name: 'Items Owner' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const obligation = await Obligation.create({
    contract: contract._id, title: 'Owner obligation', assignedTo: owner._id,
    dueDate: new Date('2026-01-01'), status: 'Pending'
  });
  const milestone = await Milestone.create({
    contract: contract._id, title: 'Owner milestone', assignedTo: owner._id,
    dueDate: new Date('2026-01-01'), status: 'Pending'
  });

  const rogue = await forceRole(await createUser({ name: 'Items Rogue' }), 'Contractor');
  const token = signToken(rogue);

  const obligations = await api('GET', '/api/obligations', { token });
  const milestones = await api('GET', '/api/milestones', { token });
  assert.equal(obligations.data.length, 0, "another user's obligations are not listed");
  assert.equal(milestones.data.length, 0, "another user's milestones are not listed");

  const singleObligation = await api('GET', `/api/obligations/${obligation._id}`, { token });
  const singleMilestone = await api('GET', `/api/milestones/${milestone._id}`, { token });
  assert.equal(singleObligation.status, 403);
  assert.equal(singleMilestone.status, 403);
});

test('an unrecognised role cannot edit or reassign another user work item', async () => {
  const owner = await createUser({ name: 'Edit Owner' });
  const rogue = await forceRole(await createUser({ name: 'Edit Rogue' }), 'Contractor');
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const obligation = await Obligation.create({
    contract: contract._id, title: 'Owner obligation', assignedTo: owner._id,
    dueDate: new Date('2026-01-01'), status: 'Pending'
  });
  const milestone = await Milestone.create({
    contract: contract._id, title: 'Owner milestone', assignedTo: owner._id,
    dueDate: new Date('2026-01-01'), status: 'Pending'
  });

  const token = signToken(rogue);
  const body = { title: 'HIJACKED', dueDate: '2099-01-01', assignedTo: rogue._id.toString() };

  const obEdit = await api('PUT', `/api/obligations/${obligation._id}`, { token, body });
  const msEdit = await api('PUT', `/api/milestones/${milestone._id}`, { token, body });

  // Pre-fix the "not an Employee" branch granted the privileged path, so both
  // answered 200 and the item was retitled, rescheduled and reassigned to the
  // rogue account.
  assert.equal(obEdit.status, 403);
  assert.match(obEdit.data.message, /assigned to you/);
  assert.equal(msEdit.status, 403);

  const storedObligation = await Obligation.findById(obligation._id);
  const storedMilestone = await Milestone.findById(milestone._id);
  assert.equal(storedObligation.title, 'Owner obligation', 'the obligation is untouched');
  assert.equal(storedObligation.assignedTo.toString(), owner._id.toString());
  assert.equal(new Date(storedObligation.dueDate).toISOString().slice(0, 10), '2026-01-01');
  assert.equal(storedMilestone.title, 'Owner milestone', 'the milestone is untouched');
});

test('an Employee and a Manager keep exactly the access they had before', async () => {
  const owner = await createUser({ name: 'Compat Owner' });
  const employee = await createUser({ name: 'Compat Employee' });
  const manager = await createUser({ name: 'Compat Manager', role: 'Manager' });
  await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const assigned = await createContract({ createdBy: owner._id, assignedUser: employee._id });

  const employeeList = await api('GET', '/api/contracts', { token: signToken(employee) });
  assert.equal(employeeList.data.length, 1, 'an Employee sees the contract they are assigned to');
  assert.equal(employeeList.data[0]._id, assigned._id.toString());

  const managerList = await api('GET', '/api/contracts', { token: signToken(manager) });
  assert.equal(managerList.data.length, 2, 'a Manager still sees the whole repository');

  // And the single-record predicate is unchanged for all three.
  const secret = (await createContract({ createdBy: owner._id, assignedUser: owner._id }))._id;
  assert.equal((await api('GET', `/api/contracts/${secret}`, { token: signToken(employee) })).status, 403);
  assert.equal((await api('GET', `/api/contracts/${secret}`, { token: signToken(manager) })).status, 200);
  assert.equal(canAccessContract({ role: 'Manager' }, { createdBy: 'a' }), true);
});

test('the notification feed is scoped for an unrecognised role', async () => {
  const owner = await createUser({ name: 'Feed Owner' });
  const contract = await createContract({
    createdBy: owner._id, assignedUser: owner._id, status: 'Active',
    endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
  });
  await Obligation.create({
    contract: contract._id, title: 'Owner overdue obligation', assignedTo: owner._id,
    dueDate: new Date('2020-01-01'), status: 'Overdue'
  });

  const rogue = await forceRole(await createUser({ name: 'Feed Rogue' }), null);
  const feed = await api('GET', '/api/notifications', { token: signToken(rogue) });

  assert.equal(feed.status, 200);
  assert.equal(feed.data.count, 0, 'no contract, obligation or milestone of another user appears');
});

// ---------------------------------------------------------------------------
// 3. release:verify must assert the names the storage adapter reads
// ---------------------------------------------------------------------------

// Reads a file with comment lines removed, so an assertion about executable
// code is not defeated by prose that deliberately names the old behaviour.
const executableSource = (file) => fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

test('release:verify checks SUPABASE_SECRET_KEY and not the unused service-role name', () => {
  const source = executableSource('scripts/release-verify.js');

  // The adapter is the authority; the names are derived from it, so they cannot
  // drift back to a hand-copied list.
  assert.match(source, /REQUIRED_ENV/, 'the required list is derived from the storage adapter');
  assert.match(
    source,
    /['"]services['"]\s*,\s*['"]storage['"]\s*,\s*['"]supabaseStorage['"]/,
    'REQUIRED_ENV is read from the storage adapter module'
  );
  assert.doesNotMatch(
    source,
    /SUPABASE_SERVICE_ROLE_KEY/,
    'SUPABASE_SERVICE_ROLE_KEY is read by no module and must not be required'
  );

  const REQUIRED_ENV = require('../services/storage/supabaseStorage').REQUIRED_ENV;
  assert.deepEqual(
    [...REQUIRED_ENV].sort(),
    ['SUPABASE_BUCKET_NAME', 'SUPABASE_SECRET_KEY', 'SUPABASE_URL'],
    'the adapter reads exactly these three'
  );
  assert.ok(
    fs.readFileSync(path.join(SERVER_ROOT, '.env.example'), 'utf8').includes('SUPABASE_SECRET_KEY'),
    'the documented variable name matches'
  );
});

test('release:verify reports READY when every variable the app reads is set', () => {
  // Runs the real script with a complete, fully synthetic environment: no real
  // credential, no network call (no --smtp) and no database connection.
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb://127.0.0.1:27017/ricozcontract_releaseverify_dummy',
    JWT_SECRET: 'synthetic-release-verify-secret-not-real-0123456789',
    CLIENT_URL: 'https://ricoz-contract-clm-platform.vercel.app',
    GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
    SUPABASE_URL: 'https://synthetic-project.supabase.co',
    SUPABASE_SECRET_KEY: 'synthetic-secret-key',
    SUPABASE_BUCKET_NAME: 'contract-documents',
    RESEND_API_KEY: 're_synthetic',
    EMAIL_FROM: 'RicozContract <no-reply@example.com>',
    RESEND_TIMEOUT_MS: ''
  };

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(SERVER_ROOT, 'scripts', 'release-verify.js')],
      { cwd: SERVER_ROOT, env: environment, timeout: 60000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        // Pre-fix this exited 1 with "SUPABASE_SERVICE_ROLE_KEY is EMPTY" on a
        // correctly configured host, so the pre-deploy gate was permanently red.
        assert.equal(error, null, `release:verify failed:\n${output}`);
        assert.doesNotMatch(output, /SUPABASE_SERVICE_ROLE_KEY/);
        assert.match(output, /SUPABASE_SECRET_KEY/);
        assert.match(output, /SUPABASE_BUCKET_NAME/);
        assert.match(output, /READY - 0 blockers/);
        assert.doesNotMatch(
          output,
          /synthetic-release-verify-secret-not-real/,
          'no secret value may be printed'
        );
        resolve();
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Static guard against reintroducing the fail-open predicate
// ---------------------------------------------------------------------------

test('no scope check asks "is this an Employee?" instead of using the allow-list', () => {
  const files = [
    'routes/contractRoutes.js',
    'routes/reportRoutes.js',
    'routes/obligationRoutes.js',
    'routes/milestoneRoutes.js',
    'routes/notificationRoutes.js',
    'routes/approvalRoutes.js',
    'routes/renewalRoutes.js',
    'routes/activityRoutes.js',
    'routes/userRoutes.js',
    'utils/itemUpdate.js',
    'utils/access.js'
  ];

  // Inverted membership: `role === 'Employee'` (or `!== 'Employee'`) treats
  // every other value as privileged, which is the defect this audit found.
  const failOpen = /role\s*(===|!==)\s*'Employee'/;
  // A hand-copied privileged list is the same drift in a different shape; the
  // single source of truth is PRIVILEGED_ROLES in utils/access.js.
  const duplicatedList = /\[\s*'Admin'\s*,\s*'Manager'\s*\]\s*\.includes/;

  for (const file of files) {
    const source = executableSource(file);

    assert.doesNotMatch(source, failOpen, `${file} must scope from the allow-list, not from an Employee test`);
    assert.doesNotMatch(source, duplicatedList, `${file} must use isPrivileged, not a copied role list`);
  }
});

test('the allow-list and the authorize() role list cannot drift apart', () => {
  const { PRIVILEGED_ROLES } = require('../utils/access');
  const authorizeSource = fs.readFileSync(path.join(SERVER_ROOT, 'middleware', 'auth.js'), 'utf8');

  assert.match(authorizeSource, /roles\.includes\(req\.user\.role\)/, 'authorize stays an allow-list');
  assert.deepEqual([...PRIVILEGED_ROLES].sort(), ['Admin', 'Manager']);
  assert.equal(PRIVILEGED_ROLES.has('Employee'), false, 'an Employee is never privileged');
});
