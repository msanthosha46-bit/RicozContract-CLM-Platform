// Issue 34 - Contract creation and editing: validation, lifecycle and mass
// assignment.
//
// WHAT THIS COVERS
// ----------------
// `POST /contracts` and `PUT /contracts/:id` are the only two routes that write
// a contract's commercial terms, and they are the routes a client - including a
// hostile one - reaches directly. The cases below are grouped by the property
// they defend:
//
//   1. Creation lifecycle. A contract may only be born as a Draft. `status`,
//      `createdBy`, `isArchived` and `contractNumber` are all server-derived;
//      a forged value in the body must be ignored rather than honoured.
//   2. Vocabulary agreement. The create and edit forms offer exactly four
//      currencies and seven contract types. The schema enforced the type enum
//      but not the currency one, so a forged currency persisted and then fed
//      the dashboard totals and the report grouping.
//   3. Coercion. `new Date(null)` is the epoch and `Number('')` is 0. A field
//      that is supposed to be refused was instead silently turned into a real
//      value, which is worse than a validation error because nothing reports it.
//   4. Whitespace. `title` was trimmed by the schema, `partyName` was not, so a
//      required business field accepted "   " and stored a blank counterparty.
//   5. Amount semantics. Zero and decimals are legal; negative, non-numeric and
//      absent values are not.
//   6. Role and ownership. An Employee cannot write to a contract they cannot
//      open, cannot move status, and cannot rewrite the terms of a contract that
//      has already been approved.
//   7. Archived freeze and the edit lock, re-checked here so a change to the
//      creation/update validation cannot quietly reopen either hole.
//
// Every fixture lives in this file's own disposable database. No production or
// development data is read or written.

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

const contractRoutes = require('../routes/contractRoutes');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_issue34_write_test');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The vocabulary the create and edit forms actually offer, and the only one the
// dashboard's currency handling and the report grouping were written for.
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR'];
const TYPES = ['Vendor', 'Client', 'NDA', 'SLA', 'Employment', 'Partnership', 'Other'];

let server;
let baseURL;
let userSeed = 0;
let numberSeed = 0;

const utcDay = (daysFromToday) => new Date(Date.UTC(
  new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
) + daysFromToday * MS_PER_DAY);

// A calendar day as the client sends it: an <input type="date"> produces
// "YYYY-MM-DD", which `new Date()` reads as UTC midnight.
const calendarDay = (daysFromToday) => utcDay(daysFromToday).toISOString().slice(0, 10);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, role = 'Employee' } = {}) => {
  userSeed += 1;
  return User.create({
    name: name || `Issue34 User ${userSeed}`,
    email: `issue34.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role,
    status: 'Active'
  });
};

// Any field not listed here is passed straight to the model, so a test can set
// startDate/amount/etc. without going through `overrides`.
const makeContract = async ({ createdBy, assignedUser, status = 'Draft', isArchived = false, ...overrides } = {}) => {
  numberSeed += 1;
  return Contract.create({
    contractNumber: `I34-${Date.now()}-${numberSeed}`,
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

// A complete, valid creation body. Callers override a single field so a test
// can never accidentally pass because of an unrelated omission.
const validBody = (overrides = {}) => ({
  title: 'Warehouse services agreement',
  type: 'Vendor',
  partyName: 'Northwind Logistics',
  description: 'Freight services for the EU region.',
  startDate: calendarDay(1),
  endDate: calendarDay(365),
  amount: 250000,
  currency: 'USD',
  ...overrides
});

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/contracts', contractRoutes);
  // Mirrors the production error handler in server/app.js, because the status
  // codes asserted below are the ones a real client sees.
  app.use((error, req, res, next) => {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', details: Object.values(error.errors || {}).map((d) => d.message) });
    }
    if (error.name === 'CastError') return res.status(400).json({ message: `Invalid value for '${error.path}'` });
    if (error.code === 11000) return res.status(409).json({ message: 'A record with the same unique value already exists' });
    return res.status(500).json({ message: 'Internal server error' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

/* ---------------- authentication ---------------- */

test('creating a contract requires a session', async () => {
  const res = await api('POST', '/api/contracts', { body: validBody() });
  assert.equal(res.status, 401);
  assert.equal(await Contract.countDocuments(), 0, 'nothing may be created anonymously');
});

test('an invalid or expired token cannot create a contract either', async () => {
  const res = await api('POST', '/api/contracts', { body: validBody(), token: 'not-a-real-token' });
  assert.equal(res.status, 401);
  assert.equal(await Contract.countDocuments(), 0);
});

/* ---------------- creation lifecycle ---------------- */

test('any authenticated role may create a contract, and it is always a Draft', async () => {
  for (const role of ['Employee', 'Manager', 'Admin']) {
    const user = await createUser({ role });
    const res = await api('POST', '/api/contracts', { body: validBody(), token: signToken(user) });
    assert.equal(res.status, 201, `role ${role} should be able to create a contract`);
    assert.equal(res.data.status, 'Draft', `role ${role} must not land in another state`);
  }
});

test('a forged status in the creation body is ignored', async () => {
  const user = await createUser();
  for (const forged of ['Active', 'Approved', 'Pending Approval', 'Closed']) {
    const res = await api('POST', '/api/contracts', { body: validBody({ status: forged }), token: signToken(user) });
    assert.equal(res.status, 201);
    assert.equal(res.data.status, 'Draft', `body status '${forged}' must not take effect`);
    assert.equal((await Contract.findById(res.data._id).lean()).status, 'Draft');
  }
});

test('ownership, archive state and the contract number are server-derived', async () => {
  const creator = await createUser();
  const victim = await createUser({ name: 'Victim Owner' });

  const res = await api('POST', '/api/contracts', {
    token: signToken(creator),
    body: validBody({
      createdBy: victim._id.toString(),
      isArchived: true,
      contractNumber: 'CNT-1999-9999'
    })
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.createdBy, creator._id.toString(), 'createdBy must come from the session');
  assert.equal(res.data.isArchived, false, 'a contract cannot be born archived');
  assert.notEqual(res.data.contractNumber, 'CNT-1999-9999', 'the number is generated');
  assert.match(res.data.contractNumber, /^CNT-\d{4}-\d{4}$/);
});

/* ---------------- creation vocabulary ---------------- */

test('every contract type the form offers is accepted and anything else is refused', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const type of TYPES) {
    const res = await api('POST', '/api/contracts', { body: validBody({ type }), token });
    assert.equal(res.status, 201, `type '${type}' is offered by the form and must be accepted`);
  }
  for (const type of ['vendor', 'VENDOR', 'Invoice', 'Subscription', '']) {
    const res = await api('POST', '/api/contracts', { body: validBody({ type }), token });
    assert.equal(res.status, 400, `type '${type}' is not in the form and must be refused`);
  }
});

test('every currency the form offers is accepted and anything else is refused', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const currency of CURRENCIES) {
    const res = await api('POST', '/api/contracts', { body: validBody({ currency }), token });
    assert.equal(res.status, 201, `currency '${currency}' is offered by the form and must be accepted`);
    assert.equal(res.data.currency, currency);
  }
  // The schema enforced the type enum but not the currency one, so these were
  // persisted and then fed straight into the dashboard totals and the report
  // grouping, which switch formatting on the currency code.
  for (const currency of ['BTC', 'usd', 'Dollars', '<script>alert(1)</script>', 'US Dollars']) {
    const res = await api('POST', '/api/contracts', { body: validBody({ currency }), token });
    assert.equal(res.status, 400, `currency '${currency}' must be refused, not stored`);
  }
});

/* ---------------- creation: required fields ---------------- */

test('every required field is genuinely required', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const field of ['title', 'type', 'partyName', 'startDate', 'endDate', 'amount']) {
    const body = validBody();
    delete body[field];
    const res = await api('POST', '/api/contracts', { body, token });
    assert.equal(res.status, 400, `omitting '${field}' must be refused`);
  }
  for (const [field, value] of [['title', ''], ['partyName', ''], ['startDate', ''], ['endDate', ''], ['amount', '']]) {
    const res = await api('POST', '/api/contracts', { body: validBody({ [field]: value }), token });
    assert.equal(res.status, 400, `'${field}' sent as an empty string must be refused`);
  }
});

test('a required field made only of whitespace is refused, not stored blank', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const field of ['title', 'partyName']) {
    const res = await api('POST', '/api/contracts', { body: validBody({ [field]: '   ' }), token });
    assert.equal(res.status, 400, `'${field}' of "   " is not a value and must be refused`);
  }
  assert.equal(await Contract.countDocuments({ partyName: /^\s*$/ }), 0, 'no blank counterparty may be stored');
});

/* ---------------- creation: dates ---------------- */

test('a null or absent date is refused instead of becoming the epoch', async () => {
  const user = await createUser();
  const token = signToken(user);
  // new Date(null) is 1970-01-01, a perfectly valid Date, so a null slipped
  // through validateContractDates and produced a contract with no real dates.
  for (const [field, value] of [['startDate', null], ['endDate', null], ['startDate', ''], ['endDate', '']]) {
    const res = await api('POST', '/api/contracts', { body: validBody({ [field]: value }), token });
    assert.equal(res.status, 400, `'${field}' sent as ${JSON.stringify(value)} must be refused`);
  }
  const both = await api('POST', '/api/contracts', { body: validBody({ startDate: null, endDate: null }), token });
  assert.equal(both.status, 400);
  assert.equal(await Contract.countDocuments({ startDate: { $lt: utcDay(-3650) } }), 0, 'no 1970 contract may be stored');
});

test('an unparseable date is refused', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const value of ['not-a-date', '2027-13-45', '01/02/2027 25:00']) {
    const res = await api('POST', '/api/contracts', { body: validBody({ startDate: value }), token });
    assert.equal(res.status, 400, `'${value}' is not a date`);
  }
});

test('the end date must not precede the start date, and may equal it', async () => {
  const user = await createUser();
  const token = signToken(user);

  const reversed = await api('POST', '/api/contracts', {
    token, body: validBody({ startDate: calendarDay(30), endDate: calendarDay(10) })
  });
  assert.equal(reversed.status, 400);

  const same = await api('POST', '/api/contracts', {
    token, body: validBody({ startDate: calendarDay(30), endDate: calendarDay(30) })
  });
  assert.equal(same.status, 201, 'a one-day contract is a real contract, not an error');
  assert.equal(same.data.startDate.slice(0, 10), same.data.endDate.slice(0, 10));
});

test('a submitted calendar date is stored at UTC midnight, not shifted', async () => {
  const user = await createUser();
  const start = calendarDay(10);
  const res = await api('POST', '/api/contracts', { token: signToken(user), body: validBody({ startDate: start, endDate: calendarDay(20) }) });
  assert.equal(res.status, 201);
  assert.equal(res.data.startDate, `${start}T00:00:00.000Z`, 'the calendar day must survive the round trip unchanged');
});

/* ---------------- creation: amount ---------------- */

test('zero and decimal amounts are real amounts and are accepted', async () => {
  const user = await createUser();
  const token = signToken(user);

  const zero = await api('POST', '/api/contracts', { token, body: validBody({ amount: 0 }) });
  assert.equal(zero.status, 201);
  assert.equal(zero.data.amount, 0);

  const decimal = await api('POST', '/api/contracts', { token, body: validBody({ amount: 1234.56 }) });
  assert.equal(decimal.status, 201, 'the server accepts decimals, so the form must be able to send one');
  assert.equal(decimal.data.amount, 1234.56);
});

test('a negative, non-numeric or missing amount is refused', async () => {
  const user = await createUser();
  const token = signToken(user);
  for (const amount of [-1, -0.01, 'abc', '12abc', null, '', {}, NaN]) {
    const res = await api('POST', '/api/contracts', { token, body: validBody({ amount }) });
    assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must be refused`);
  }
});

test('a non-number JSON type cannot become an amount by coercion', async () => {
  const user = await createUser();
  const token = signToken(user);
  // Number(true) is 1 and Number([]) is 0, so these became real amounts.
  for (const amount of [true, false, [], ['1000']]) {
    const res = await api('POST', '/api/contracts', { token, body: validBody({ amount }) });
    assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} is not a number and must be refused`);
  }
});

/* ---------------- creation: text fields ---------------- */

test('text is stored as sent, including markup, and is not executed anywhere', async () => {
  const user = await createUser();
  const payload = '<script>alert("xss")</script>';
  const res = await api('POST', '/api/contracts', {
    token: signToken(user), body: validBody({ title: payload, partyName: payload, description: payload })
  });
  assert.equal(res.status, 201);
  // Stored verbatim: React escapes on render, so neutralising it here would be
  // a data-integrity change with no security benefit.
  assert.equal(res.data.title, payload);
});

/* ---------------- creation: assignee ---------------- */

test('the assignee must be a real user, and an absent assignee is legal', async () => {
  const user = await createUser();
  const other = await createUser({ name: 'Assignable Colleague' });
  const token = signToken(user);

  const unassigned = await api('POST', '/api/contracts', { token, body: validBody() });
  assert.equal(unassigned.status, 201);
  assert.equal(unassigned.data.assignedUser, undefined, 'no assignee was sent, so none is set');

  const assigned = await api('POST', '/api/contracts', { token, body: validBody({ assignedUser: other._id.toString() }) });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.data.assignedUser, other._id.toString());

  const bad = await api('POST', '/api/contracts', { token, body: validBody({ assignedUser: 'not-an-object-id' }) });
  assert.equal(bad.status, 400);

  const missing = await api('POST', '/api/contracts', {
    token, body: validBody({ assignedUser: new mongoose.Types.ObjectId().toString() })
  });
  assert.equal(missing.status, 404, 'an assignee that does not exist is not silently dropped');
});

/* ---------------- editing: ownership and role ---------------- */

test('editing a contract needs a session and contract access', async () => {
  const owner = await createUser();
  const stranger = await createUser({ name: 'Unrelated Employee' });
  const contract = await makeContract({ createdBy: owner._id });

  const anonymous = await api('PUT', `/api/contracts/${contract._id}`, { body: { title: 'x' } });
  assert.equal(anonymous.status, 401);

  const foreign = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { title: 'x' }, token: signToken(stranger)
  });
  assert.equal(foreign.status, 403, 'an Employee must not write to a contract they cannot open');

  const own = await api('PUT', `/api/contracts/${contract._id}`, { body: { title: 'Renamed' }, token: signToken(owner) });
  assert.equal(own.status, 200);
});

test('the assigned user may edit, and losing the assignment revokes it', async () => {
  const owner = await createUser();
  const assignee = await createUser({ name: 'Assigned Employee' });
  const contract = await makeContract({ createdBy: owner._id, assignedUser: assignee._id });

  const whileAssigned = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { description: 'Noted by the assignee' }, token: signToken(assignee)
  });
  assert.equal(whileAssigned.status, 200);

  await api('PUT', `/api/contracts/${contract._id}`, { body: { assignedUser: null }, token: signToken(owner) });
  const afterRemoval = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { description: 'Still trying' }, token: signToken(assignee)
  });
  assert.equal(afterRemoval.status, 403, 'clearing the assignment must revoke the access it granted');
});

test('an unknown role is scoped like an Employee, never like a manager', async () => {
  const owner = await createUser();
  const oddity = await createUser({ name: 'Unrecognised Role' });
  await User.collection.updateOne({ _id: oddity._id }, { $set: { role: 'Superuser' } });
  const contract = await makeContract({ createdBy: owner._id });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { status: 'Closed' }, token: signToken(oddity)
  });
  assert.equal(res.status, 403, 'an unrecognised role must not reach the status field');
  assert.equal((await Contract.findById(contract._id).lean()).status, 'Draft');
});

/* ---------------- editing: mass assignment ---------------- */

test('ownership, archive and number cannot be written through the update route', async () => {
  const owner = await createUser();
  const victim = await createUser({ name: 'Ownership Victim' });
  const admin = await createUser({ role: 'Admin' });
  const contract = await makeContract({ createdBy: owner._id });

  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    token: signToken(admin),
    body: {
      title: 'Legitimate rename',
      createdBy: victim._id.toString(),
      isArchived: true,
      contractNumber: 'CNT-1999-1234'
    }
  });

  assert.equal(res.status, 200);
  const stored = await Contract.findById(contract._id).lean();
  assert.equal(stored.title, 'Legitimate rename', 'the permitted field is applied');
  assert.equal(stored.createdBy.toString(), owner._id.toString(), 'createdBy is not client-writable');
  assert.equal(stored.isArchived, false, 'archiving is not a side effect of an edit');
  assert.notEqual(stored.contractNumber, 'CNT-1999-1234');
});

/* ---------------- editing: dates and amount ---------------- */

test('a null date in an update is refused instead of rewriting the contract to 1970', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id });
  const before = await Contract.findById(contract._id).lean();

  for (const [field, value] of [['startDate', null], ['endDate', null], ['startDate', ''], ['endDate', '']]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      body: { [field]: value }, token: signToken(owner)
    });
    assert.equal(res.status, 400, `'${field}' sent as ${JSON.stringify(value)} must be refused`);
  }

  const after = await Contract.findById(contract._id).lean();
  assert.equal(after.startDate.getTime(), before.startDate.getTime(), 'the start date is untouched');
  assert.equal(after.endDate.getTime(), before.endDate.getTime(), 'the end date is untouched');
});

test('an empty amount in an update is refused, not silently stored as zero', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id, amount: 5000 });

  // Creation refuses an empty amount, so an update that quietly turned one into
  // 0 was the only way to zero a contract without saying so.
  for (const amount of ['', null, '   ', true, []]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      body: { amount }, token: signToken(owner)
    });
    assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must be refused`);
  }
  assert.equal((await Contract.findById(contract._id).lean()).amount, 5000, 'the amount is untouched');
});

test('an update may still set a real zero, and a real decimal', async () => {
  const owner = await createUser();
  const token = signToken(owner);

  const zeroed = await makeContract({ createdBy: owner._id, amount: 5000 });
  const toZero = await api('PUT', `/api/contracts/${zeroed._id}`, { body: { amount: 0 }, token });
  assert.equal(toZero.status, 200);
  assert.equal((await Contract.findById(zeroed._id).lean()).amount, 0);

  const fraction = await makeContract({ createdBy: owner._id, amount: 5000 });
  const toDecimal = await api('PUT', `/api/contracts/${fraction._id}`, { body: { amount: 99.99 }, token });
  assert.equal(toDecimal.status, 200);
  assert.equal((await Contract.findById(fraction._id).lean()).amount, 99.99);
});

test('an update may not invert the date range', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id, startDate: utcDay(10), endDate: utcDay(20) });
  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { endDate: utcDay(5).toISOString() }, token: signToken(owner)
  });
  assert.equal(res.status, 400);
});

test('an update may not introduce a currency the form does not offer', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id });
  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { currency: 'BTC' }, token: signToken(owner)
  });
  assert.equal(res.status, 400);
  assert.equal((await Contract.findById(contract._id).lean()).currency, 'USD');
});

test('a null or empty currency is a bad request, not an omission', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id });

  // Both used to reach a `.trim()` on the amendment path and throw a TypeError,
  // which the error handler turned into a 500. A malformed value is a 400 on
  // every path, and the stored currency has to survive untouched.
  for (const currency of [null, '', '  ', 'usd', 42, ['USD']]) {
    const res = await api('PUT', `/api/contracts/${contract._id}`, {
      body: { currency }, token: signToken(owner)
    });
    assert.equal(res.status, 400, `currency=${JSON.stringify(currency)} must be refused`);
    assert.equal(
      (await Contract.findById(contract._id).lean()).currency,
      'USD',
      'the stored currency is unchanged'
    );
  }

  // The same on creation.
  const created = await api('POST', '/api/contracts', {
    body: validBody({ currency: null }), token: signToken(owner)
  });
  assert.equal(created.status, 400);

  // Omitting it entirely is still legal, and falls back to the default.
  const omitted = validBody();
  delete omitted.currency;
  const defaulted = await api('POST', '/api/contracts', {
    body: omitted, token: signToken(owner)
  });
  assert.equal(defaulted.status, 201);
  assert.equal(defaulted.data.currency, 'USD');
});

test('a resubmitted unchanged amount is accepted, so the always-full form still saves', async () => {
  const owner = await createUser();
  const contract = await makeContract({ createdBy: owner._id, amount: 5000 });
  // The edit form posts every field on every save, so unchanged locked values
  // must compare equal rather than tripping the edit lock.
  const res = await api('PUT', `/api/contracts/${contract._id}`, {
    body: { amount: 5000, title: 'Renamed only' }, token: signToken(owner)
  });
  assert.equal(res.status, 200);
});

/* ---------------- editing: lifecycle ---------------- */

test('only a manager or admin may move status, and only along an allowed transition', async () => {
  const owner = await createUser();
  const manager = await createUser({ role: 'Manager' });
  const draft = await makeContract({ createdBy: owner._id, status: 'Draft' });

  const byEmployee = await api('PUT', `/api/contracts/${draft._id}`, { body: { status: 'Closed' }, token: signToken(owner) });
  assert.equal(byEmployee.status, 403);
  assert.equal((await Contract.findById(draft._id).lean()).status, 'Draft');

  const illegal = await api('PUT', `/api/contracts/${draft._id}`, { body: { status: 'Active' }, token: signToken(manager) });
  assert.equal(illegal.status, 400, 'reaching Active requires the approval decision route');

  const legal = await api('PUT', `/api/contracts/${draft._id}`, { body: { status: 'Pending Approval' }, token: signToken(manager) });
  assert.equal(legal.status, 200);
  assert.equal((await Contract.findById(draft._id).lean()).status, 'Pending Approval');
});

test('the approved terms are locked for every role, including admin', async () => {
  const owner = await createUser();
  const admin = await createUser({ role: 'Admin' });
  const colleague = await createUser({ name: 'Would-Be Assignee' });
  const active = await makeContract({ createdBy: owner._id, status: 'Active', amount: 1000, endDate: utcDay(300) });

  // Two classes of refusal, deliberately kept apart. A WELL-FORMED change to a
  // locked field is a lifecycle conflict (409, with the amendment route named).
  // A MALFORMED value is a bad request whatever the contract's state (400) -
  // an empty amount was never a "change to the amount", it was no amount at all,
  // and it used to pass the lock because Number('') is 0.
  const wellFormed = [
    { amount: 999999 },
    { currency: 'EUR' },
    { endDate: utcDay(3000).toISOString() },
    { assignedUser: colleague._id.toString() }
  ];
  const malformed = [{ amount: '' }, { amount: null }, { startDate: null }, { currency: 'Dollars' }];

  for (const [who, token] of [['owner', signToken(owner)], ['admin', signToken(admin)]]) {
    for (const body of wellFormed) {
      const label = Object.entries(body).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',');
      const res = await api('PUT', `/api/contracts/${active._id}`, { body, token });
      assert.equal(res.status, 409, `${who} sending ${label} on an Active contract must be refused`);
    }
    for (const body of malformed) {
      const label = Object.entries(body).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',');
      const res = await api('PUT', `/api/contracts/${active._id}`, { body, token });
      assert.equal(res.status, 400, `${who} sending ${label} is malformed and must be a bad request`);
    }
  }

  // Clearing an assignee that was never set is a no-op rather than a change, so
  // the lock lets it through - and it must not smuggle in a real assignment.
  const noop = await api('PUT', `/api/contracts/${active._id}`, { body: { assignedUser: null }, token: signToken(owner) });
  assert.equal(noop.status, 200);
  const cleared = (await Contract.findById(active._id).lean()).assignedUser;
  assert.ok(!cleared, 'no assignee appeared');

  // Descriptive fields stay open, which is what keeps the editor usable.
  const renamed = await api('PUT', `/api/contracts/${active._id}`, { body: { title: 'Corrected title' }, token: signToken(owner) });
  assert.equal(renamed.status, 200);

  const stored = await Contract.findById(active._id).lean();
  assert.equal(stored.amount, 1000);
  assert.equal(stored.currency, 'USD');
});

test('a closed contract is terminal', async () => {
  const admin = await createUser({ role: 'Admin' });
  const closed = await makeContract({ createdBy: admin._id, status: 'Closed' });
  const res = await api('PUT', `/api/contracts/${closed._id}`, { body: { status: 'Active' }, token: signToken(admin) });
  assert.equal(res.status, 400);
});

/* ---------------- editing: archived ---------------- */

test('an archived contract is frozen, except for a status change', async () => {
  const admin = await createUser({ role: 'Admin' });
  const archived = await makeContract({ createdBy: admin._id, status: 'Active', isArchived: true });

  for (const body of [
    { title: 'x' }, { type: 'NDA' }, { partyName: 'x' }, { description: 'x' },
    { amount: 1 }, { currency: 'EUR' }, { amount: '' },
    { startDate: utcDay(1).toISOString() }, { endDate: utcDay(2).toISOString() },
    { assignedUser: null }
  ]) {
    const res = await api('PUT', `/api/contracts/${archived._id}`, { body, token: signToken(admin) });
    assert.equal(res.status, 400, `archived contract must refuse ${Object.keys(body)[0]}`);
  }

  const statusOnly = await api('PUT', `/api/contracts/${archived._id}`, { body: { status: 'Closed' }, token: signToken(admin) });
  assert.equal(statusOnly.status, 200, 'closing an archived contract is the last legitimate act on it');
});

test('only an admin may archive, and archiving is one-way', async () => {
  const manager = await createUser({ role: 'Manager' });
  const contract = await makeContract({ createdBy: manager._id });

  const byManager = await api('PATCH', `/api/contracts/${contract._id}/archive`, { token: signToken(manager) });
  assert.equal(byManager.status, 403);

  const byAdmin = await api('PATCH', `/api/contracts/${contract._id}/archive`, {
    token: signToken(await createUser({ role: 'Admin' }))
  });
  assert.equal(byAdmin.status, 200);
  assert.equal((await Contract.findById(contract._id).lean()).isArchived, true);

  // There is no unarchive route, and `isArchived` is not an editable field, so
  // a caller asking to clear it gets a no-op rather than a way back in.
  const unarchive = await api('PUT', `/api/contracts/${contract._id}`, { body: { isArchived: false }, token: signToken(manager) });
  assert.ok(unarchive.status === 200 || unarchive.status === 400, `unexpected ${unarchive.status}`);
  assert.equal((await Contract.findById(contract._id).lean()).isArchived, true, 'the archive is a freeze, not a toggle');
  assert.equal(await Contract.countDocuments({ isArchived: false, contractNumber: contract.contractNumber }), 0);
});

/* ---------------- error surface ---------------- */

test('a missing or malformed contract id is a 4xx, never a 500', async () => {
  const user = await createUser();
  const token = signToken(user);
  const bogus = await api('GET', '/api/contracts/not-an-object-id', { token });
  assert.equal(bogus.status, 400);
  const gone = await api('GET', `/api/contracts/${new mongoose.Types.ObjectId()}`, { token });
  assert.equal(gone.status, 404);
});

test('creation never echoes a server-side failure detail to the client', async () => {
  const user = await createUser();
  const res = await api('POST', '/api/contracts', { body: validBody({ amount: 'abc' }), token: signToken(user) });
  assert.equal(res.status, 400);
  const text = JSON.stringify(res.data).toLowerCase();
  for (const leak of ['mongo', 'at object.', '/api/', 'node_modules', 'validationerror']) {
    assert.equal(text.includes(leak), false, `the response leaked '${leak}'`);
  }
});

test('a successful creation records one activity entry naming the creator', async () => {
  const user = await createUser();
  const before = await ActivityLog.countDocuments();
  const res = await api('POST', '/api/contracts', { token: signToken(user), body: validBody() });
  assert.equal(res.status, 201);
  const entries = await ActivityLog.find({ contract: res.data._id }).lean();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user.toString(), user._id.toString());
  assert.equal(entries[0].action, 'Contract Created');
  assert.ok(await ActivityLog.countDocuments() > before);
});
