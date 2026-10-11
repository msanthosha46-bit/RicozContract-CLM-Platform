'use strict';

// Issue 22 - obligation title/description trimming consistency (server side).
//
// `server/models/Milestone.js` declared `trim: true` on title and description,
// but `server/models/Obligation.js` did not. The obligation POST route trims
// `title` itself while forwarding `description` verbatim, so an obligation
// created with a padded (or whitespace-only) description persisted the padding
// while the equivalent milestone did not. The two models are the same
// work-item shape and the shared PUT helper trims both fields, so the schema
// now trims them too.
//
// The model-level assertions need no database: Mongoose applies `trim` as a
// schema setter at assignment time. The route round-trip pins the end-to-end
// creation behavior that a user actually hits.

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

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_i22trimming_test';
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
  email: `i22-${Date.now()}-${(seq += 1)}@ricoz.test`,
  password: 'Password123!',
  role: 'Employee',
  status: 'Active',
  ...overrides
});

const createContract = async (overrides = {}) => Contract.create({
  contractNumber: `I22-${Date.now()}-${(seq += 1)}`,
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
 * Schema setters (no database required)
 * ------------------------------------------------------------------ */

test('the Obligation schema trims title and description like Milestone', () => {
  const obligation = new Obligation({ title: '  Padded title  ', description: '  Padded description  ' });
  const milestone = new Milestone({ title: '  Padded title  ', description: '  Padded description  ' });

  assert.equal(obligation.title, 'Padded title', 'title must not retain the padding');
  assert.equal(obligation.description, 'Padded description', 'description must not retain the padding');
  assert.equal(obligation.title, milestone.title, 'the two work-item models must agree on title');
  assert.equal(obligation.description, milestone.description, 'and on description');
});

test('a whitespace-only description is stored empty on both models', () => {
  assert.equal(new Obligation({ title: 'x', description: '     ' }).description, '');
  assert.equal(new Milestone({ title: 'x', description: '     ' }).description, '');
});

test('an absent description still defaults to undefined on both models', () => {
  assert.equal(new Obligation({ title: 'x' }).description, undefined);
  assert.equal(new Milestone({ title: 'x' }).description, undefined);
});

/* ------------------------------------------------------------------ *
 * The creation path a user actually hits
 * ------------------------------------------------------------------ */

test('creating an obligation trims a padded description just like a milestone', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);
  const common = { contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' };

  const obligation = await api('POST', '/api/obligations', {
    token, body: { ...common, title: '  Obligation title  ', description: '  Obligation description  ' }
  });
  assert.equal(obligation.status, 201);
  assert.equal(obligation.data.title, 'Obligation title');
  assert.equal(obligation.data.description, 'Obligation description');

  const stored = await Obligation.findById(obligation.data._id);
  assert.equal(stored.title, 'Obligation title');
  assert.equal(stored.description, 'Obligation description', 'persisted value matches the returned value');

  const milestone = await api('POST', '/api/milestones', {
    token, body: { ...common, title: '  Milestone title  ', description: '  Milestone description  ' }
  });
  assert.equal(milestone.status, 201);
  assert.equal(milestone.data.title, 'Milestone title');
  assert.equal(milestone.data.description, 'Milestone description');

  assert.equal(
    obligation.data.description.length,
    'Obligation description'.length,
    'no padding survives on the obligation description'
  );
});

test('creating an obligation with a whitespace-only description stores an empty string', async () => {
  const admin = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: admin._id, assignedUser: admin._id });
  const token = signToken(admin);

  const created = await api('POST', '/api/obligations', {
    token,
    body: { title: 'Whitespace', description: '     ', contract: String(contract._id), assignedTo: String(admin._id), dueDate: '2026-11-30' }
  });
  assert.equal(created.status, 201);

  const stored = await Obligation.findById(created.data._id);
  assert.equal(stored.description, '', 'a whitespace-only description is not kept as blank-looking text');
});
