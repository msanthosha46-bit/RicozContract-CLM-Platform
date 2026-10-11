'use strict';

// Issue 23 - Document endpoint regression coverage: the request-validation
// branch of POST /documents/upload that fires when a request carries no file.
//
// The Issue 35 audit and phase4 suite pin the upload, download, authorization,
// metadata-privacy and failure-cleanup paths, but every one of their helpers
// always attaches a file. The route's `if (!req.file?.buffer)` guard
// (server/routes/documentRoutes.js) therefore had no regression test: a caller
// that reaches the endpoint without a file must be told so with a 400 and must
// leave no metadata row and no stored object behind. This file holds that one
// branch down and deliberately duplicates nothing else.

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
const ContractDocument = require('../models/ContractDocument');
const documentRoutes = require('../routes/documentRoutes');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const { createMockStorage } = require('./helpers/mockStorage');
const { syncDocumentVersionIndex } = require('../utils/documentIndexes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_i23doc_test';

let server;
let baseURL;
let mockStorage;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

let sequence = 0;
const createUser = (overrides = {}) => User.create({
  name: 'Probe User',
  email: `i23probe${Date.now()}-${(sequence += 1)}@ricoz.test`,
  password: 'Password123!',
  role: 'Admin',
  status: 'Active',
  ...overrides
});

const createContract = (overrides = {}) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${(sequence += 1)}`,
  title: 'Probe contract',
  type: 'Vendor',
  partyName: 'Probe vendor',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-12-31'),
  amount: 1000,
  createdBy: new mongoose.Types.ObjectId(),
  ...overrides
});

// Posts a multipart form for the given fields. A field whose value is a string
// is sent as a plain form field, never as a file, which is exactly the request
// shape multer lets through with `req.file` left undefined.
const postForm = async (url, { token, fields = [] } = {}) => {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  const res = await fetch(baseURL + url, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  await mongoose.syncIndexes();
  await syncDocumentVersionIndex(mongoose.model('ContractDocument'), { maxTimeMS: 10000 });

  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);

  await new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/documents', documentRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    app.use((error, req, res, next) => {
      if (error.name === 'MulterError') {
        return res.status(400).json({ message: error.message });
      }
      if (error.status >= 400 && error.status < 500 && error.expose) {
        return res.status(error.status).json({ message: error.message });
      }
      return res.status(500).json({ message: 'Internal server error' });
    });
    server = app.listen(0, resolve);
  });
  baseURL = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  resetStorageAdapter();
  if (mockStorage) mockStorage.cleanup();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (server) server.close();
});

test('an upload with no file is refused before anything is stored', async () => {
  const owner = await createUser();
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const objectsBefore = mockStorage.client.objects.size;

  const empty = await postForm(`/documents/upload/${contract._id}`, { token });
  assert.equal(empty.status, 400, 'an empty multipart body is a bad request, not a success');
  assert.match(empty.data.message, /Please upload a file/);

  // A form field that happens to be named `document` is not a file either, so it
  // must take the same branch rather than reaching the storage adapter.
  const textField = await postForm(`/documents/upload/${contract._id}`, {
    token, fields: [['document', 'not-a-file']]
  });
  assert.equal(textField.status, 400);
  assert.match(textField.data.message, /Please upload a file/);

  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0,
    'a request with no file must not record metadata');
  assert.equal(mockStorage.client.objects.size, objectsBefore,
    'and must not reach object storage');
});
