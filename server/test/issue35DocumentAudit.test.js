'use strict';

// Issue 35 - Contract Document Management: server-side guarantees.
//
// WHAT THIS COVERS
// ----------------
// The upload path writes to object storage first and only then records
// metadata, so the interesting questions are all about what happens when one of
// those two steps fails, and about who may read the result. The cases here were
// found by probing the live router during the audit; each one is now pinned
// down as an assertion so it cannot regress unnoticed.
//
// The defect fixed for Issue 35 was in the browser, not here. This file exists
// because the audit concluded the server is sound, and that conclusion needs
// to be re-checkable rather than taken on trust.
//
// Storage is the in-memory Supabase double in ./helpers/mockStorage, which
// speaks the same REST shape as the real service, so the adapter's URL
// building, auth headers and status mapping are all exercised.

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
const { sanitizeOriginalName, extensionFor } = require('../middleware/upload');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_i35audit_test';
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

let server;
let baseURL;
let mockStorage;

const signToken = (user, extra = {}) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0, ...extra },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

let sequence = 0;
const createUser = async (overrides = {}) => User.create({
  name: 'Probe User',
  email: `probe${Date.now()}-${(sequence += 1)}@ricoz.test`,
  password: 'Password123!',
  role: 'Employee',
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

const upload = async (url, { token, filename, content = PDF } = {}) => {
  const form = new FormData();
  form.append('document', new Blob([content]), filename);
  const res = await fetch(baseURL + url, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};

const get = async (url, token) => {
  const res = await fetch(baseURL + url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    data = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, data, headers: res.headers };
};

const objectCount = () => mockStorage.client.objects.size;

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
      if (error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'File exceeds the 10 MiB upload limit.' });
      }
      if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
        return res.status(400).json({ message: error.message });
      }
      if (error.status >= 400 && error.status < 500 && error.expose) {
        return res.status(error.status).json({ message: error.message });
      }
      if (error.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation failed' });
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

/* ------------------------------------------------------------------ */
/* versioning                                                          */
/* ------------------------------------------------------------------ */

test('the first upload on a contract is version 1', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });

  const result = await upload(`/documents/upload/${contract._id}`, {
    token: signToken(owner), filename: 'first.pdf'
  });

  assert.equal(result.status, 201);
  assert.equal(result.data.version, 1);
});

test('concurrent uploads on one contract never share a version number', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const objectsBefore = objectCount();

  // Six uploads fired at once, all reading the same "current max version".
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => upload(`/documents/upload/${contract._id}`, {
      token, filename: `concurrent-${i}.pdf`
    }))
  );

  const created = results.filter((r) => r.status === 201);
  assert.equal(created.length, 6, `every upload should succeed, got ${results.map((r) => r.status).join(',')}`);

  const versions = created.map((r) => r.data.version).sort((a, b) => a - b);
  assert.equal(new Set(versions).size, versions.length, `duplicate version allocated: ${versions.join(',')}`);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6], 'versions form an unbroken run');

  const rows = await ContractDocument.find({ contract: contract._id }).lean();
  assert.equal(rows.length, 6, 'one row per upload');
  assert.equal(objectCount() - objectsBefore, 6, 'and one stored object per upload');
});

test('a legacy row with no version does not collide with the next upload', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const first = await upload(`/documents/upload/${contract._id}`, { token, filename: 'v1.pdf' });
  assert.equal(first.data.version, 1);

  // A row written before versioning existed: no version field at all.
  await ContractDocument.collection.insertOne({
    contract: contract._id,
    filename: 'legacy.bin',
    originalname: 'legacy.pdf',
    storageBackend: 'supabase',
    storageKey: 'documents/legacy.pdf',
    checksum: 'x',
    fileSize: 10,
    fileType: 'application/pdf',
    uploadedBy: owner._id
  });

  const second = await upload(`/documents/upload/${contract._id}`, { token, filename: 'v2.pdf' });
  assert.equal(second.status, 201, 'a version-less row must not block new uploads');
  assert.ok(second.data.version >= 1);

  const rows = await ContractDocument.find({ contract: contract._id }).lean();
  const versions = rows.map((r) => r.version).filter((v) => typeof v === 'number');
  assert.equal(new Set(versions).size, versions.length, 'and must not duplicate a version');
});

/* ------------------------------------------------------------------ */
/* authorization                                                       */
/* ------------------------------------------------------------------ */

test('a document cannot be downloaded across contracts', async () => {
  const alice = await createUser({ name: 'Alice' });
  const bob = await createUser({ name: 'Bob' });
  const aliceContract = await createContract({ createdBy: alice._id, assignedUser: alice._id });
  const bobContract = await createContract({ createdBy: bob._id, assignedUser: bob._id });

  const bobUpload = await upload(`/documents/upload/${bobContract._id}`, {
    token: signToken(bob), filename: 'bob-confidential.pdf'
  });
  assert.equal(bobUpload.status, 201);

  const stolen = await get(`/documents/download/${bobUpload.data._id}`, signToken(alice));
  assert.equal(stolen.status, 403, 'knowing the document id must not be enough');

  const bobList = await get(`/documents/contract/${bobContract._id}`, signToken(alice));
  assert.equal(bobList.status, 403, 'and the contract listing is refused too');
});

test('every document endpoint refuses an unauthenticated caller', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const stored = await upload(`/documents/upload/${contract._id}`, { token, filename: 'private.pdf' });
  const objectsBefore = objectCount();

  const anonymousDownload = await get(`/documents/download/${stored.data._id}`);
  assert.equal(anonymousDownload.status, 401);

  const anonymousList = await get(`/documents/contract/${contract._id}`);
  assert.equal(anonymousList.status, 401);

  const anonymousUpload = await upload(`/documents/upload/${contract._id}`, { filename: 'sneaky.pdf' });
  assert.equal(anonymousUpload.status, 401);
  assert.equal(objectCount(), objectsBefore, 'and nothing was stored');
});

test('a forged role claim in the token grants nothing', async () => {
  // The role used for every decision is read from the user row, not the token,
  // so a token that claims a higher role must not widen access.
  const owner = await createUser({ role: 'Employee' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const stored = await upload(`/documents/upload/${contract._id}`, { token, filename: 'owned.pdf' });
  assert.equal(stored.status, 201);

  const forged = signToken(owner, { role: 'SuperAdmin' });
  assert.equal((await get(`/documents/download/${stored.data._id}`, forged)).status, 200,
    'the real owner still gets their own file');
  assert.equal((await get(`/documents/download/${stored.data._id}`, signToken(owner, { role: 'Admin' }))).status, 200);

  // And a different user whose token claims Admin still cannot read it.
  const stranger = await createUser({ role: 'Employee' });
  const escalated = signToken(stranger, { role: 'Admin' });
  assert.equal((await get(`/documents/download/${stored.data._id}`, escalated)).status, 403,
    'a claimed Admin role must not reach another user\'s document');
});

/* ------------------------------------------------------------------ */
/* filenames and header injection                                      */
/* ------------------------------------------------------------------ */

test('a filename cannot inject a response header', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const result = await upload(`/documents/upload/${contract._id}`, {
    token, filename: 'a"b\r\nX-Injected: 1.pdf'
  });
  assert.equal(result.status, 201);

  const download = await get(`/documents/download/${result.data._id}`, token);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-injected'), null, 'the injected header must not exist');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
});

test('path traversal in a filename cannot reach the filesystem', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const attempts = [
    '../../../../etc/passwd.pdf',
    '..\\..\\windows\\system32\\evil.pdf',
    'C:\\evil.pdf',
    '/etc/passwd.pdf'
  ];

  for (const filename of attempts) {
    const result = await upload(`/documents/upload/${contract._id}`, { token, filename });
    assert.equal(result.status, 201, `${filename} should still upload as a normal document`);

    // The name shown to the user is reduced to a bare file name.
    assert.doesNotMatch(result.data.originalname, /[\\/]/, `${filename} kept a path separator`);
    assert.match(result.data.originalname, /\.pdf$/i, `${filename} lost its extension`);

    // The stored object name is a generated identifier, never the client's.
    assert.notEqual(result.data.filename, filename);
    assert.doesNotMatch(result.data.filename, /[\\/]/, `${filename} reached the storage key`);

    assert.equal((await get(`/documents/download/${result.data._id}`, token)).status, 200);
  }
});

test('the name sanitiser reduces hostile input to a bare, bounded file name', () => {
  const ALLOWED = ['.pdf', '.docx', '.doc'];
  const inputs = [
    'a"b\r\nX-Injected: 1.pdf',
    '../../etc/passwd.pdf',
    '..\\..\\win.pdf',
    'C:\\Windows\\evil.pdf',
    '/absolute/evil.pdf',
    '',
    '   '
  ];
  for (const input of inputs) {
    const safe = sanitizeOriginalName(input);
    assert.doesNotMatch(safe, /[\r\n]/, `${JSON.stringify(input)} kept a line break`);
    assert.doesNotMatch(safe, /[\\/]/, `${JSON.stringify(input)} kept a path separator`);
    assert.ok(safe.length <= 255, `${JSON.stringify(input)} is ${safe.length} chars`);
  }

  // A name that sanitises to nothing still yields a usable, extension-less
  // placeholder rather than an empty string.
  assert.equal(sanitizeOriginalName(''), 'document');
  assert.equal(sanitizeOriginalName('   '), 'document');
  assert.equal(extensionFor('document'), '', 'so it carries no extension and is refused');

  // The extension is read from the sanitised name, so a double extension is
  // judged on its last part, and a name that sanitises to nothing is refused.
  assert.equal(extensionFor('report.pdf.exe'), '.exe');
  assert.equal(extensionFor('a"b\r\nX-Injected: 1.pdf'), '.pdf');
  assert.equal(extensionFor('noextension'), '');

  // Nothing above can produce an allowed extension without the name really
  // ending in one.
  for (const hostile of inputs) {
    const extension = extensionFor(hostile);
    if (ALLOWED.includes(extension)) {
      assert.match(String(hostile).toLowerCase(), new RegExp(`\\${extension}$`),
        `${JSON.stringify(hostile)} was accepted as ${extension} without ending in it`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* the response body                                                   */
/* ------------------------------------------------------------------ */

test('a stored document never reports its storage location', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const uploaded = await upload(`/documents/upload/${contract._id}`, { token, filename: 'private.pdf' });
  const listed = await get(`/documents/contract/${contract._id}`, token);
  assert.equal(listed.status, 200);

  for (const body of [uploaded.data, ...listed.data]) {
    // These three are what would let a caller address the object directly.
    assert.equal(body.storageKey, undefined, 'storageKey must not be exposed');
    assert.equal(body.storageBackend, undefined, 'storageBackend must not be exposed');
    assert.equal(body.filePath, undefined, 'filePath must not be exposed');
    // `_id` is returned because the client downloads by it; it is useless on
    // its own, which the cross-contract case above pins down.
    assert.ok(body._id, 'the download handle is present');
    assert.equal(body.originalname, 'private.pdf');
    assert.equal(body.version, 1);
  }

  // The server keeps the key it needs to serve the file, and that key is a
  // generated, dated, non-guessable path rather than anything the client chose.
  // These fields are `select: false`, so an ordinary query does not even return
  // them; the route opts in explicitly when it needs to read the object.
  const plain = await ContractDocument.findById(uploaded.data._id).lean();
  assert.equal(plain.storageKey, undefined, 'an ordinary read does not return the key at all');
  assert.equal(plain.filePath, undefined, 'nor the legacy path');

  const row = await ContractDocument.findById(uploaded.data._id).select('+storageKey +storageBackend +filePath').lean();
  assert.ok(row.storageKey, 'the server keeps the key it needs to serve the file');
  assert.match(row.storageKey, /^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/,
    'and that key is a generated, dated, non-guessable path');
  assert.notEqual(row.storageKey, row.originalname, 'never the name the client supplied');
  assert.equal(row.storageBackend, 'supabase', 'and the backend is recorded explicitly');
});

/* ------------------------------------------------------------------ */
/* archived contracts                                                  */
/* ------------------------------------------------------------------ */

test('an archived contract refuses new uploads but keeps serving its documents', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const before = await upload(`/documents/upload/${contract._id}`, { token, filename: 'before-archive.pdf' });
  assert.equal(before.status, 201);

  await Contract.updateOne({ _id: contract._id }, { $set: { isArchived: true } });
  const objectsBefore = objectCount();

  const late = await upload(`/documents/upload/${contract._id}`, { token, filename: 'after-archive.pdf' });
  assert.equal(late.status, 400, 'an archived contract is closed to new documents');
  assert.equal(objectCount(), objectsBefore, 'and the refusal happens before anything is stored');

  // Reading what already exists must keep working; archiving is not deletion.
  const listed = await get(`/documents/contract/${contract._id}`, token);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.length, 1);
  assert.equal((await get(`/documents/download/${before.data._id}`, token)).status, 200);
});

/* ------------------------------------------------------------------ */
/* failure handling: no half-written documents                         */
/* ------------------------------------------------------------------ */

test('a storage failure records no document', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  mockStorage.client.failUploads = true;
  const failed = await upload(`/documents/upload/${contract._id}`, { token, filename: 'un-storable.pdf' });
  mockStorage.client.failUploads = false;

  assert.equal(failed.status, 503, 'an unavailable store is reported as temporary, not as a server fault');
  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0,
    'and no metadata row survives a failed store');
});

test('a metadata failure removes the object it had already stored', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const objectsBefore = objectCount();

  // The object is stored first, so the write that fails is the second one.
  const realCreate = ContractDocument.create.bind(ContractDocument);
  let armed = true;
  ContractDocument.create = async (...args) => {
    if (armed) { armed = false; throw new Error('simulated metadata failure'); }
    return realCreate(...args);
  };
  let failed;
  try {
    failed = await upload(`/documents/upload/${contract._id}`, { token, filename: 'orphan.pdf' });
  } finally {
    ContractDocument.create = realCreate;
  }

  assert.equal(failed.status, 500);
  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0, 'no row was written');
  assert.equal(objectCount(), objectsBefore, 'and the object it had already stored was removed');

  // The contract is still usable afterwards, and still starts at version 1.
  const retry = await upload(`/documents/upload/${contract._id}`, { token, filename: 'retry.pdf' });
  assert.equal(retry.status, 201, 'a failed upload must not leave the contract wedged');
  assert.equal(retry.data.version, 1);
});

/* ------------------------------------------------------------------ */
/* dangling records and missing objects                                */
/* ------------------------------------------------------------------ */

test('a document whose contract no longer exists is not served', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const stored = await upload(`/documents/upload/${contract._id}`, { token, filename: 'orphan.pdf' });

  await Contract.deleteOne({ _id: contract._id });

  // Fail closed: with no contract there is no way to prove access, so the
  // request is refused rather than served on the strength of the token alone.
  assert.equal((await get(`/documents/download/${stored.data._id}`, token)).status, 403);
});

test('a document whose object has gone reports a clear 404', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);
  const stored = await upload(`/documents/upload/${contract._id}`, { token, filename: 'vanishing.pdf' });

  mockStorage.client.objects.clear();

  const download = await get(`/documents/download/${stored.data._id}`, token);
  assert.equal(download.status, 404);
  assert.match(download.data.message, /no longer stored|unavailable/i,
    'the user is told the file is gone rather than shown a server fault');
});

/* ------------------------------------------------------------------ */
/* content is stored, not interpreted                                   */
/* ------------------------------------------------------------------ */

test('the bytes that come back are the bytes that went in', async () => {
  const owner = await createUser({ role: 'Admin' });
  const contract = await createContract({ createdBy: owner._id, assignedUser: owner._id });
  const token = signToken(owner);

  const content = new TextEncoder().encode('%PDF-1.7\nbinary\x00\xff\xfe payload\n%%EOF');
  const stored = await upload(`/documents/upload/${contract._id}`, { token, filename: 'exact.pdf', content });
  assert.equal(stored.status, 201);
  assert.equal(stored.data.fileSize, content.length, 'the recorded size is the real size');

  const download = await get(`/documents/download/${stored.data._id}`, token);
  assert.equal(download.status, 200);
  assert.deepEqual(download.data, Buffer.from(content), 'the download is byte-identical to the upload');
});
