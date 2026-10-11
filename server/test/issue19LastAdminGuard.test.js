// Issue 19 regression: the last-active-administrator guard.
//
// PUT /api/users/:id/role refuses to demote or deactivate the only active
// administrator. That guard was a read-then-write: it counted the other active
// admins and then saved. Two administrators demoting or deactivating themselves
// at the same moment each observed the other as an open slot and both
// committed, leaving the workspace with zero administrators and no API path
// back (registration can only create Employees). These tests pin both the
// sequential protection and its concurrency safety.
//
// Runs against a disposable loopback database through the shared helper and a
// mocked storage adapter, so nothing here can reach real data.
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'https://app.ricoz.test';

const mongoose = require('mongoose');

const User = require('../models/User');
const { createApp } = require('../app');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const { createMockStorage } = require('./helpers/mockStorage');
const { disposableTestDatabaseUri } = require('./helpers/testDatabase');

const TEST_DB_URI = disposableTestDatabaseUri('ricozcontract_issue19_test');

let server;
let baseURL;
let mockStorage;
let userSeed = 0;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createAdmin = async (label) => {
  userSeed += 1;
  return User.create({
    name: `${label} ${userSeed}`,
    email: `issue19.${userSeed}.${Date.now()}@ricoz.test`,
    password: 'Password123!',
    role: 'Admin',
    status: 'Active'
  });
};

const activeAdminCount = () => User.countDocuments({ role: 'Admin', status: 'Active' });

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

test.before(async () => {
  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);
  await mongoose.connect(TEST_DB_URI);
  await mongoose.connection.dropDatabase();

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await User.deleteMany({});
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

test('the only active administrator cannot be demoted or deactivated', async () => {
  const only = await createAdmin('Sole');
  const token = signToken(only);

  const demote = await api('PUT', `/api/users/${only._id}/role`, { token, body: { role: 'Employee' } });
  assert.equal(demote.status, 400);
  assert.match(demote.data.message, /only active administrator/);

  const deactivate = await api('PUT', `/api/users/${only._id}/role`, { token, body: { status: 'Inactive' } });
  assert.equal(deactivate.status, 400);
  assert.match(deactivate.data.message, /only active administrator/);

  const stored = await User.findById(only._id);
  assert.equal(stored.role, 'Admin', 'a refused change must not be persisted');
  assert.equal(stored.status, 'Active');
});

test('concurrent self-demotions never empty the administrator census', async () => {
  const ADMINS = 8;
  const TRIALS = 5;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    await User.deleteMany({});
    const admins = [];
    for (let i = 0; i < ADMINS; i += 1) admins.push(await createAdmin(`Demote ${i}`));

    const responses = await Promise.all(admins.map((admin) => api('PUT', `/api/users/${admin._id}/role`, {
      token: signToken(admin),
      body: { role: 'Employee' }
    })));

    assert.ok(
      responses.every((response) => response.status === 200 || response.status === 400),
      `trial ${trial}: unexpected response statuses ${responses.map((r) => r.status).join(',')}`
    );
    const remaining = await activeAdminCount();
    assert.ok(
      remaining >= 1,
      `trial ${trial}: ${remaining} active administrators remain; the guard must never empty the census`
    );
  }
});

test('concurrent self-deactivations never empty the active-administrator census', async () => {
  const ADMINS = 8;
  const TRIALS = 5;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    await User.deleteMany({});
    const admins = [];
    for (let i = 0; i < ADMINS; i += 1) admins.push(await createAdmin(`Deactivate ${i}`));

    const responses = await Promise.all(admins.map((admin) => api('PUT', `/api/users/${admin._id}/role`, {
      token: signToken(admin),
      body: { status: 'Inactive' }
    })));

    assert.ok(
      responses.every((response) => response.status === 200 || response.status === 400),
      `trial ${trial}: unexpected response statuses ${responses.map((r) => r.status).join(',')}`
    );
    const remaining = await activeAdminCount();
    assert.ok(
      remaining >= 1,
      `trial ${trial}: ${remaining} active administrators remain; the guard must never empty the census`
    );
  }
});
