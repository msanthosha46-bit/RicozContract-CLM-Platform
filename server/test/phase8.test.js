// Phase-8 tests: dashboard/report accuracy against the lists a user is
// actually sent to, and deterministic ordering of the breakdowns.
//
// The bugs these guard:
//  1. `expiringSoon` used `endDate: { $gte: new Date() }`, so a contract
//     expiring *today* (stored as today-at-00:00Z) was already in the past
//     and was excluded -- off by one, and shifted by the server's UTC offset.
//  2. It counted only `status: 'Active'` while the renewal screen lists
//     `['Active', 'Approved']`, so the dashboard figure was lower than the
//     list the card sends you to.
//  3. `$group` output was unsorted, so the chart and the two report tables
//     reshuffled between requests for identical data.
//  4. The dashboard total and the Contracts page total came from different
//     queries and could disagree.
//
// Uses its own database so it never touches real data.
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
const Milestone = require('../models/Milestone');
const Renewal = require('../models/Renewal');

const reportRoutes = require('../routes/reportRoutes');
const contractRoutes = require('../routes/contractRoutes');
const renewalRoutes = require('../routes/renewalRoutes');
const { expiringWindow, EXPIRING_STATUSES } = require('../utils/dateWindow');
const { VALID_STATUSES, RENEWABLE_FROM } = require('../utils/contractTransitions');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_phase8_test';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;
let contractSeq = 0;

/** Today at UTC midnight, the shape a date picker stores. */
const todayUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const daysFromTodayUtc = (days) => new Date(todayUtc().getTime() + days * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

const makeContract = ({ overrides = {}, createdBy, assignedUser }) => Contract.create({
  contractNumber: `P8-${Date.now()}-${contractSeq += 1}`,
  title: 'Phase 8 contract',
  type: 'Vendor',
  partyName: 'Phase 8 vendor',
  startDate: daysFromTodayUtc(-365),
  endDate: daysFromTodayUtc(365),
  amount: 1000,
  currency: 'USD',
  createdBy,
  assignedUser,
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
    app.use('/api/contracts', contractRoutes);
    app.use('/api/reports', reportRoutes);
    app.use('/api/renewals', renewalRoutes);
    app.use((error, req, res, next) => {
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

/* ---------------- the window itself ---------------- */

test('expiringWindow covers today through the end of today + N days', () => {
  const window = expiringWindow(30);
  const today = todayUtc();
  const lastDay = daysFromTodayUtc(30);

  // Lower bound is inclusive of today-at-midnight: a contract expiring today
  // must be inside the window, which is exactly what `{$gte: new Date()}` got
  // wrong.
  assert.equal(window.$gte.getTime(), today.getTime());

  // Upper bound is exclusive at the end of day N+1, so a date-only end date
  // on day N still matches.
  assert.equal(window.$lt.getTime(), daysFromTodayUtc(31).getTime());
  assert.ok(lastDay < window.$lt, 'day 30 must be inside the window');
  assert.ok(daysFromTodayUtc(31) >= window.$lt, 'day 31 must be outside the window');
});

test('every status the report counts as expiring is one the renewal screen will accept', () => {
  // A contract must never be counted as "expiring soon" while the renewal
  // screen refuses to list or renew it.
  for (const status of EXPIRING_STATUSES) {
    assert.ok(RENEWABLE_FROM.has(status), `${status} is counted as expiring but canRenewContract rejects it`);
    assert.ok(VALID_STATUSES.has(status), `${status} is not a real contract status`);
  }
});

/* ---------------- expiringSoon matches the renewal list ---------------- */

test('expiringSoon counts a contract that expires today', async () => {
  const admin = await createUser({ name: 'Today Admin', email: 'p8.today.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({
    createdBy: admin._id,
    assignedUser: admin._id,
    overrides: { status: 'Active', endDate: todayUtc() }
  });

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.metrics.expiringSoon, 1, 'a contract expiring today is not overdue yet');
});

test('expiringSoon agrees with the renewal list for the same window', async () => {
  const admin = await createUser({ name: 'Parity Admin', email: 'p8.parity.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(0) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(15) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(30) } });
  // Outside the window.
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(31) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(200) } });
  // Not renewable, so the renewal screen would not list it either.
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Draft', endDate: daysFromTodayUtc(5) } });
  // Expired contracts are renewable but the renewal screen does not list
  // them, so they must not inflate the dashboard figure either.
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Expired', endDate: daysFromTodayUtc(10) } });

  const dash = await api('GET', '/api/reports/dashboard', { token });
  const list = await api('GET', '/api/renewals/expiring?window=30', { token });

  assert.equal(dash.status, 200);
  assert.equal(list.status, 200);
  assert.equal(dash.data.metrics.expiringSoon, 3, 'today, +15 and +30 are inside the 30-day window');
  assert.equal(
    dash.data.metrics.expiringSoon,
    list.data.length,
    'the dashboard figure and the renewal list must count the same contracts'
  );
});

test('expiringSoon includes approved contracts, which the renewal screen lists', async () => {
  const admin = await createUser({ name: 'Approved Admin', email: 'p8.approved.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Approved', endDate: daysFromTodayUtc(7) } });

  const dash = await api('GET', '/api/reports/dashboard', { token });
  const list = await api('GET', '/api/renewals/expiring?window=30', { token });

  assert.equal(dash.data.metrics.expiringSoon, 1, 'an approved contract ending in 7 days needs attention');
  assert.equal(list.data.length, 1);
});

test('the summary and dashboard endpoints report the same expiringSoon', async () => {
  const admin = await createUser({ name: 'Agree Admin', email: 'p8.agree.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(2) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Approved', endDate: daysFromTodayUtc(20) } });

  const summary = await api('GET', '/api/reports/summary', { token });
  const dash = await api('GET', '/api/reports/dashboard', { token });

  assert.equal(summary.status, 200);
  assert.equal(summary.data.metrics.expiringSoon, dash.data.metrics.expiringSoon);
  assert.equal(summary.data.metrics.expiringSoon, 2);
});

test('expiringSoon excludes archived contracts', async () => {
  const admin = await createUser({ name: 'Archived Admin', email: 'p8.archived.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({
    createdBy: admin._id,
    assignedUser: admin._id,
    overrides: { status: 'Active', endDate: daysFromTodayUtc(3), isArchived: true }
  });

  const dash = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(dash.data.metrics.expiringSoon, 0);
  assert.equal(dash.data.metrics.total, 0, 'archived contracts are out of the repository entirely');
});

test('an employee expiringSoon count is scoped to their own contracts', async () => {
  const admin = await createUser({ name: 'Scope Admin', email: 'p8.scope.admin@ricoz.test', role: 'Admin' });
  const employee = await createUser({ name: 'Scope Employee', email: 'p8.scope.employee@ricoz.test', role: 'Employee' });

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(3) } });
  await makeContract({ createdBy: employee._id, assignedUser: employee._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(3) } });
  await makeContract({ createdBy: employee._id, assignedUser: employee._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(9) } });

  const dash = await api('GET', '/api/reports/dashboard', { token: signToken(employee) });
  assert.equal(dash.data.metrics.expiringSoon, 2, "the admin's expiring contract is not visible to the employee");
});

/* ---------------- dashboard total vs the contract list ---------------- */

test('the dashboard total equals the contracts page total for the same user', async () => {
  const admin = await createUser({ name: 'Parity2 Admin', email: 'p8.parity2.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  // A spread across statuses so the total is not a single bucket.
  for (const [index, status] of ['Draft', 'Active', 'Active', 'Closed', 'Rejected'].entries()) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status, endDate: daysFromTodayUtc(100 + index) } });
  }
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Draft', isArchived: true } });

  const dash = await api('GET', '/api/reports/dashboard', { token });
  const list = await api('GET', '/api/contracts?page=1&limit=100', { token });

  assert.equal(dash.data.metrics.total, 5);
  assert.equal(dash.data.metrics.total, list.data.total, 'dashboard and repository totals must not disagree');
});

test('the status breakdown sums to the dashboard total', async () => {
  const admin = await createUser({ name: 'Sum Admin', email: 'p8.sum.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  for (const status of ['Draft', 'Pending Review', 'Pending Approval', 'Approved', 'Active']) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status } });
  }

  const dash = await api('GET', '/api/reports/dashboard', { token });
  const sum = dash.data.statusBreakdown.reduce((total, row) => total + row.count, 0);
  assert.equal(sum, dash.data.metrics.total);
});

/* ---------------- deterministic ordering ---------------- */

test('statusBreakdown is returned in lifecycle order, not group order', async () => {
  const admin = await createUser({ name: 'Order Admin', email: 'p8.order.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  // Inserted in an order that is neither lifecycle nor alphabetical, so a
  // `$group` with no `$sort` has a real chance of returning it as given.
  for (const status of ['Renewed', 'Active', 'Pending Approval', 'Draft', 'Closed', 'Expired', 'Approved', 'Rejected', 'Pending Review']) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status } });
  }

  const expected = [...VALID_STATUSES];
  for (const url of ['/api/reports/dashboard', '/api/reports/summary']) {
    const res = await api('GET', url, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.statusBreakdown.map((row) => row._id), expected, `${url} status order`);
  }
});

test('typeBreakdown is ordered by descending count, then name', async () => {
  const admin = await createUser({ name: 'TypeOrder Admin', email: 'p8.typeorder.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  for (const type of ['Vendor', 'Vendor', 'Vendor', 'NDA', 'NDA', 'SLA']) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { type } });
  }

  const res = await api('GET', '/api/reports/summary', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.typeBreakdown, [
    { _id: 'Vendor', count: 3 },
    { _id: 'NDA', count: 2 },
    { _id: 'SLA', count: 1 }
  ]);
});

test('the breakdown order is stable across repeated identical requests', async () => {
  const admin = await createUser({ name: 'Stable Admin', email: 'p8.stable.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  for (const status of ['Draft', 'Active', 'Active', 'Closed']) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status } });
  }

  const first = await api('GET', '/api/reports/summary', { token });
  for (let i = 0; i < 4; i += 1) {
    const again = await api('GET', '/api/reports/summary', { token });
    assert.deepEqual(again.data.statusBreakdown, first.data.statusBreakdown);
    assert.deepEqual(again.data.typeBreakdown, first.data.typeBreakdown);
  }
});

/* ---------------- payload robustness ---------------- */

test('a contract with no currency is grouped under the schema default', async () => {
  const admin = await createUser({ name: 'Currency Admin', email: 'p8.currency.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  // Saved before `currency` existed, so the field is absent. The dashboard
  // labels each value line with the currency, and a null key rendered as
  // "null 1,000.00".
  await Contract.create({
    contractNumber: `P8-${Date.now()}-nocurrency`,
    title: 'Legacy contract without a currency',
    type: 'Vendor',
    partyName: 'Legacy vendor',
    startDate: daysFromTodayUtc(-30),
    endDate: daysFromTodayUtc(30),
    amount: 250,
    createdBy: admin._id,
    assignedUser: admin._id,
    status: 'Active'
  });

  const res = await api('GET', '/api/reports/dashboard', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.valueByCurrency, [{ currency: 'USD', total: 250, active: 250 }]);
});

test('the report summary stays admin/manager-only and role behaviour is unchanged', async () => {
  const manager = await createUser({ name: 'Role Manager', email: 'p8.role.manager@ricoz.test', role: 'Manager' });
  const employee = await createUser({ name: 'Role Employee', email: 'p8.role.employee@ricoz.test', role: 'Employee' });

  await makeContract({ createdBy: manager._id, assignedUser: manager._id });

  assert.equal((await api('GET', '/api/reports/summary', { token: signToken(manager) })).status, 200);
  assert.equal((await api('GET', '/api/reports/summary', { token: signToken(employee) })).status, 403);
  // The dashboard is available to every authenticated role, unchanged.
  assert.equal((await api('GET', '/api/reports/dashboard', { token: signToken(employee) })).status, 200);
  assert.equal((await api('GET', '/api/reports/dashboard', {})).status, 401);
});

test('the renewal window validation and default are unchanged', async () => {
  const admin = await createUser({ name: 'Window Admin', email: 'p8.window.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(70) } });

  const defaulted = await api('GET', '/api/renewals/expiring', { token });
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.data.length, 1, 'the default window is still 90 days');

  const narrow = await api('GET', '/api/renewals/expiring?window=30', { token });
  assert.equal(narrow.data.length, 0, '70 days is outside the 30-day window');

  const invalid = await api('GET', '/api/renewals/expiring?window=45', { token });
  assert.equal(invalid.status, 400);
});

/* ---------------- renewal eligibility ---------------- */

// The bug: `canRenewContract` permits Active, Approved, Expired and Renewed,
// and POST /renew/:contractId accepts all four. But the only UI entry point is
// the renewal screen, whose list came solely from /renewals/expiring -- a
// *forward-looking* window restricted to Active/Approved. An Expired contract
// has, by definition, an end date in the past, so it can never match a forward
// window; expireEligibleContracts() moves Active -> Expired on an hourly timer,
// which meant contracts were being stranded in a state the business rules say
// is renewable but no user could reach. Renewed was unreachable for the
// mirror-image reason: a future end date, but a status the expiring list never
// selects.

test('every status canRenewContract permits is offered by GET /renewals/renewable', async () => {
  const admin = await createUser({ name: 'Renewable Admin', email: 'p8.renewable.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  // One contract per permitted state. The end date is deliberately in the past
  // for the states a forward window cannot reach.
  for (const status of RENEWABLE_FROM) {
    await makeContract({
      createdBy: admin._id,
      assignedUser: admin._id,
      overrides: { status, endDate: daysFromTodayUtc(-10) }
    });
  }

  const res = await api('GET', '/api/renewals/renewable', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.data.map((c) => c.status).sort(),
    [...RENEWABLE_FROM].sort(),
    'the eligibility queue must cover every state canRenewContract accepts'
  );
});

test('the expiring list and the eligible list together reach every renewable contract', async () => {
  const admin = await createUser({ name: 'Coverage Admin', email: 'p8.coverage.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  // A contract in each renewable state, half of them already past their end
  // date. This is the partition the renewal page renders: the reminder list
  // plus whatever the eligible list adds.
  const renewable = [...RENEWABLE_FROM];
  for (const [index, status] of renewable.entries()) {
    await makeContract({
      createdBy: admin._id,
      assignedUser: admin._id,
      overrides: { status, endDate: daysFromTodayUtc(index % 2 === 0 ? 20 : -20) }
    });
  }
  // Not renewable, so it must appear in neither list.
  await makeContract({
    createdBy: admin._id,
    assignedUser: admin._id,
    overrides: { status: 'Closed', endDate: daysFromTodayUtc(20) }
  });

  const expiring = await api('GET', '/api/renewals/expiring?window=90', { token });
  const eligible = await api('GET', '/api/renewals/renewable', { token });

  const reached = new Set([...expiring.data, ...eligible.data].map((c) => c._id.toString()));
  for (const contract of await Contract.find({ status: { $in: [...RENEWABLE_FROM] } })) {
    assert.ok(
      reached.has(contract._id.toString()),
      `${contract.status} contract ${contract.contractNumber} is renewable but unreachable in the UI`
    );
  }

  // The two lists overlap by design -- /renewable is the whole eligible set,
  // and /renewing is a forward-window view inside it. What must hold is
  // containment: everything the reminder feed shows is also renewable, so the
  // page can render the reminder list plus "eligible but not listed" without
  // ever showing a contract it could not renew. The page then de-duplicates on
  // _id; see client/test/renewalEligibility.test.js.
  const expiringIds = new Set(expiring.data.map((c) => c._id.toString()));
  const eligibleIds = new Set(eligible.data.map((c) => c._id.toString()));
  for (const id of expiringIds) {
    assert.ok(eligibleIds.has(id), '/expiring returned a contract outside the eligible set');
  }
  // Every non-lapsed eligible contract really is inside the forward window;
  // every lapsed one is not. The dates arrive as ISO strings over JSON, so they
  // have to be re-parsed before they can be compared -- `'2026-...' >= new
  // Date()` is NaN, not true.
  for (const contract of eligible.data) {
    const inWindow = new Date(contract.endDate) >= todayUtc();
    assert.equal(contract.lapsed, !inWindow, `${contract.status} lapsed flag disagrees with its end date`);
  }

  // The completeness claim is about the *difference*: anything eligible that
  // the reminder feed omits is there precisely because it is past its end date
  // or in a state the window does not select. That difference is the set the
  // renewal page used to have no way to show.
  const shownByWindow = new Set(expiring.data.map((c) => c._id.toString()));
  const omitted = eligible.data.filter((c) => !shownByWindow.has(c._id.toString()));
  assert.ok(omitted.length > 0, 'this fixture must leave something the window cannot show');
  for (const contract of omitted) {
    const pastItsEnd = new Date(contract.endDate) < todayUtc();
    const stateTheWindowSkips = !EXPIRING_STATUSES.includes(contract.status);
    assert.ok(
      pastItsEnd || stateTheWindowSkips,
      `${contract.status} is omitted from the window yet is neither lapsed nor a status the window skips`
    );
  }

  // Closed is not renewable, so it must be absent from the eligible queue.
  assert.ok(!eligible.data.some((c) => c.status === 'Closed'), 'a closed contract is not renewable');
});

test('an archived or non-renewable contract is never offered for renewal', async () => {
  const admin = await createUser({ name: 'Archive Admin', email: 'p8.archive.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Expired', isArchived: true } });
  for (const status of ['Draft', 'Pending Review', 'Pending Approval', 'Rejected', 'Closed']) {
    await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status } });
  }

  const res = await api('GET', '/api/renewals/renewable', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, [], 'only non-archived, permitted states may be offered');
});

test('the eligible list is admin/manager-only, like the rest of the renewal surface', async () => {
  const manager = await createUser({ name: 'Eligible Manager', email: 'p8.eligible.manager@ricoz.test', role: 'Manager' });
  const employee = await createUser({ name: 'Eligible Employee', email: 'p8.eligible.employee@ricoz.test', role: 'Employee' });

  assert.equal((await api('GET', '/api/renewals/renewable', { token: signToken(manager) })).status, 200);
  assert.equal((await api('GET', '/api/renewals/renewable', { token: signToken(employee) })).status, 403);
  assert.equal((await api('GET', '/api/renewals/renewable', {})).status, 401);
});

test('the eligible list reports day counts and reminder tiers like the expiring list', async () => {
  const admin = await createUser({ name: 'Tier Admin', email: 'p8.tier.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const soon = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(10) } });
  const lapsed = await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Expired', endDate: daysFromTodayUtc(-5) } });

  const res = await api('GET', '/api/renewals/renewable', { token });
  const byNumber = Object.fromEntries(res.data.map((c) => [c.contractNumber, c]));

  const soonRow = byNumber[soon.contractNumber];
  assert.equal(soonRow.daysRemaining, 10);
  assert.equal(soonRow.lapsed, false);
  assert.equal(soonRow.reminder, 30, '10 days out is a 30-day reminder');

  const lapsedRow = byNumber[lapsed.contractNumber];
  assert.equal(lapsedRow.daysRemaining, -5);
  assert.equal(lapsedRow.lapsed, true);
  // The tier still floors at 30 rather than reporting a negative reminder.
  assert.equal(lapsedRow.reminder, 30);
});

test('the expiring list is unchanged by the new endpoint', async () => {
  // The dashboard's `expiringSoon` KPI is derived from the same window, so
  // /expiring must keep its old meaning: a forward reminder feed, not the
  // full eligibility set. Widening it would silently inflate that KPI.
  const admin = await createUser({ name: 'Unchanged Admin', email: 'p8.unchanged.admin@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Active', endDate: daysFromTodayUtc(20) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Expired', endDate: daysFromTodayUtc(-20) } });
  await makeContract({ createdBy: admin._id, assignedUser: admin._id, overrides: { status: 'Approved', endDate: daysFromTodayUtc(200) } });

  const res = await api('GET', '/api/renewals/expiring?window=90', { token });
  assert.equal(res.data.length, 1, '/expiring must stay a 90-day forward window');
  assert.equal(res.data[0].status, 'Active');
  assert.ok(res.data[0].reminder, 'the reminder tier is still present');
  assert.equal(res.data[0].lapsed, undefined, 'the expiring payload shape is unchanged');
});
