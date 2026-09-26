// PHASE-4 tests: contract approval lifecycle (submit/decide, duplicate, no
// self-approval, backend enforcement), private Supabase Storage documents (structure
// validation, size/extension policy, contract permissions, downloads, provider
// failures, concurrent versions, legacy local fallback, no orphan uploads), the
// automatic expiry scheduled job (UTC calendar-day rule, excludes
// archived/Closed/Renewed, preserves renewals, logs once), RBAC regression
// (Admin/Manager/Employee direct API, invalid ids, employee isolation) and
// activity-history hygiene (no sensitive data in log entries).
// Uses its own database and a mocked Supabase Storage API so it never touches real data.
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
const ActivityLog = require('../models/ActivityLog');

const approvalRoutes = require('../routes/approvalRoutes');
const documentRoutes = require('../routes/documentRoutes');
const expireEligibleContracts = require('../utils/expiryUpdater');
const { setStorageAdapter, resetStorageAdapter } = require('../services/storage');
const {
  syncDocumentVersionIndex,
  readDocumentVersionIndexReport,
  readIndexState,
  describeDocumentIndexReport
} = require('../utils/documentIndexes');
const { createMockStorage } = require('./helpers/mockStorage');
const { canAccessContract, employeeContractScope } = require('../utils/access');
const { canTransition, canSubmitForApproval, canRenewContract } = require('../utils/contractTransitions');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_phase4_test';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let server;
let baseURL;
let mockStorage;

const startOfUtcDay = (value) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Calendar dates (UTC midnight) N days from today, matching what a date
// picker sends and what the expiry updater compares against.
const utcDay = (daysFromToday) => new Date(startOfUtcDay(new Date()) + daysFromToday * MS_PER_DAY);

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

const makeContract = ({ overrides = {}, createdBy, assignedUser, isArchived = false, status = 'Draft' }) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Phase 4 contract',
  type: 'Vendor',
  partyName: 'Test vendor',
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

const uploadDoc = async (url, token, fileBuffer, filename, mimeType) => {
  const form = new FormData();
  form.append('document', new Blob([fileBuffer], { type: mimeType }), filename);
  const response = await fetch(baseURL + url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { status: response.status, data };
};

const startTestApp = () =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/approvals', approvalRoutes);
    app.use('/api/documents', documentRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    app.use((error, req, res, next) => {
      if (error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'File exceeds the 10 MiB upload limit.' });
      }
      if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
        return res.status(400).json({ message: error.message });
      }
      if (error.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation failed' });
      }
      if (error.name === 'CastError') {
        return res.status(400).json({ message: `Invalid value for '${error.path}'` });
      }
      console.error(error);
      return res.status(500).json({ message: 'Internal server error' });
    });
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

test.before(async () => {
  mockStorage = createMockStorage();
  setStorageAdapter(mockStorage.adapter);
  await mongoose.connect(TEST_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  const indexBootstrap = await syncDocumentVersionIndex(ContractDocument, { maxTimeMS: 10000 });
  assert.equal(indexBootstrap.created, true, 'the explicit index procedure creates the unique index');
  await startTestApp();
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  mockStorage.reset();
  await Contract.deleteMany({});
  await ContractDocument.deleteMany({});
  await ActivityLog.deleteMany({});
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
// Contract approval lifecycle
// ---------------------------------------------------------------------------

test('submit -> Pending Approval creates an approval record and logs activity', async () => {
  const employee = await createUser({ name: 'P4 Emp A', email: 'p4.emp.a@ricoz.test' });
  const token = signToken(employee);
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Draft' });

  const res = await api('POST', `/api/approvals/submit/${contract._id}`, { token });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'Pending');
  assert.equal(res.data.requestedBy, employee._id.toString());

  const reloaded = await Contract.findById(contract._id);
  assert.equal(reloaded.status, 'Pending Approval');

  const logs = await ActivityLog.find({ contract: contract._id });
  assert.ok(logs.some((log) => log.action === 'Submitted for Approval'), 'submission is logged');
});

test('duplicate submission while pending is rejected with 409', async () => {
  const employee = await createUser({ name: 'P4 Emp B', email: 'p4.emp.b@ricoz.test' });
  const token = signToken(employee);
  // The 409 branch fires when the contract is still in a submittable state but
  // a Pending approval already exists (double-submit / stale-draft case).
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Draft' });
  await require('../models/Approval').create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });

  const res = await api('POST', `/api/approvals/submit/${contract._id}`, { token });
  assert.equal(res.status, 409);
  assert.match(res.data.message, /already pending approval/);
});

test('self-approval is blocked: requester cannot decide their own contract', async () => {
  // The decision endpoint requires an Admin/Manager role in authorization
  // middleware first, so the requester must be allowed to decide but still be
  // blocked from deciding their own contract.
  const manager = await createUser({ name: 'P4 Emp C', email: 'p4.emp.c@ricoz.test', role: 'Manager' });
  const token = signToken(manager);
  const contract = await makeContract({ createdBy: manager._id, assignedUser: manager._id, status: 'Pending Approval' });
  const approval = await require('../models/Approval').create({ contract: contract._id, requestedBy: manager._id, status: 'Pending' });

  const res = await api('PUT', `/api/approvals/${approval._id}/action`, { token, body: { action: 'Approved' } });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /cannot approve or reject your own/);

  const after = await Contract.findById(contract._id);
  assert.equal(after.status, 'Pending Approval');
});

test('approve by an admin/manager moves contract to Active and records decision', async () => {
  const employee = await createUser({ name: 'P4 Emp D', email: 'p4.emp.d@ricoz.test' });
  const admin = await createUser({ name: 'P4 Adm A', email: 'p4.adm.a@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Pending Approval' });
  const approval = await require('../models/Approval').create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });

  const res = await api('PUT', `/api/approvals/${approval._id}/action`, {
    token: signToken(admin),
    body: { action: 'Approved', comments: '  Looks good  ' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'Approved');

  const contractAfter = await Contract.findById(contract._id);
  assert.equal(contractAfter.status, 'Active');

  const logs = await ActivityLog.find({ contract: contract._id });
  assert.ok(logs.some((log) => log.action === 'Contract Approved'), 'approval decision is logged');
  const decisionLog = logs.find((log) => log.action === 'Contract Approved');
  assert.equal(decisionLog.details.includes('Looks good'), true);
});

test('reject returns contract to Rejected and allows resubmission', async () => {
  const employee = await createUser({ name: 'P4 Emp E', email: 'p4.emp.e@ricoz.test' });
  const manager = await createUser({ name: 'P4 Mgr A', email: 'p4.mgr.a@ricoz.test', role: 'Manager' });
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Pending Approval' });
  const approval = await require('../models/Approval').create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });

  const reject = await api('PUT', `/api/approvals/${approval._id}/action`, {
    token: signToken(manager),
    body: { action: 'Rejected', comments: 'Needs better terms' }
  });
  assert.equal(reject.status, 200);

  const rejectedContract = await Contract.findById(contract._id);
  assert.equal(rejectedContract.status, 'Rejected');

  const resubmit = await api('POST', `/api/approvals/submit/${contract._id}`, { token: signToken(employee) });
  assert.equal(resubmit.status, 201, 'Rejected contracts may be resubmitted');
  assert.equal(resubmit.data.status, 'Pending');
});

test('approval action enforces the Pending state and contract state server-side', async () => {
  const employee = await createUser({ name: 'P4 Emp F', email: 'p4.emp.f@ricoz.test' });
  const manager = await createUser({ name: 'P4 Mgr B', email: 'p4.mgr.b@ricoz.test', role: 'Manager' });
  const token = signToken(manager);

  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Draft' });
  let approval = await require('../models/Approval').create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });

  // Contract is not in Pending Approval -> cannot be decided.
  const notPending = await api('PUT', `/api/approvals/${approval._id}/action`, { token, body: { action: 'Approved' } });
  assert.equal(notPending.status, 409);
  assert.match(notPending.data.message, /must be Pending Approval/);

  // Invalid action value.
  const badAction = await api('PUT', `/api/approvals/${approval._id}/action`, { token, body: { action: 'Sideways' } });
  assert.equal(badAction.status, 400);

  // A decided approval cannot be decided again.
  approval.status = 'Approved';
  await approval.save();
  const double = await api('PUT', `/api/approvals/${approval._id}/action`, { token, body: { action: 'Rejected' } });
  assert.equal(double.status, 409);
  assert.match(double.data.message, /already been decided/);
});

test('archived contracts cannot be submitted for approval', async () => {
  const employee = await createUser({ name: 'P4 Emp G', email: 'p4.emp.g@ricoz.test' });
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Draft', isArchived: true });
  const res = await api('POST', `/api/approvals/submit/${contract._id}`, { token: signToken(employee) });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /Archived/);
});

test('non-manager roles get 403 on approval admin endpoints', async () => {
  const employee = await createUser({ name: 'P4 Emp H', email: 'p4.emp.h@ricoz.test' });
  const token = signToken(employee);

  const pendingList = await api('GET', '/api/approvals/pending', { token });
  assert.equal(pendingList.status, 403);

  const actor = await api('PUT', '/api/approvals/000000000000000000000000/action', { token, body: { action: 'Approved' } });
  assert.equal(actor.status, 403);
});

// ---------------------------------------------------------------------------
// Document security
// ---------------------------------------------------------------------------

const PDF_MAGIC = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
const DOCX_FIXTURE = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml'),
  Buffer.from('word/document.xml'),
  Buffer.from([0x50, 0x4b, 0x05, 0x06])
]);

test('upload stores a validated PDF in Supabase Storage, versions it, and returns metadata without storage internals', async () => {
  const admin = await createUser({ name: 'P4 Adm B', email: 'p4.adm.b@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);

  const up = await uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'blueprint.pdf', 'application/pdf');
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.version, 1);
  assert.equal(up.data.originalname, 'blueprint.pdf');
  assert.equal(up.data.fileSize, PDF_MAGIC.length);
  assert.equal(up.data.fileType, 'application/pdf');
  assert.equal(up.data.storageKey, undefined, 'object keys are not exposed by the API');
  assert.equal(up.data.filePath, undefined, 'legacy filesystem paths are not exposed by the API');

  const stored = await ContractDocument.findById(up.data._id).select('+storageKey +storageBackend +filePath');
  assert.equal(stored.storageBackend, 'supabase');
  assert.match(stored.storageKey, /^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(stored.filePath, undefined);
  assert.equal(stored.filename, path.basename(stored.storageKey));
  assert.match(stored.checksum, /^[a-f0-9]{64}$/);
  assert.equal(stored.originalname.includes('blueprint'), true);
  assert.equal(stored.filename.startsWith('blueprint'), false, 'stored filename is randomized, not the raw original');
  assert.equal(mockStorage.client.objects.size, 1);

  const up2 = await uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'blueprint-v2.pdf', 'application/pdf');
  assert.equal(up2.status, 201);
  assert.equal(up2.data.version, 2, 'uploads are versioned per contract');

  const docs = await ContractDocument.find({ contract: contract._id }).sort({ version: 1 });
  assert.equal(docs.length, 2);
  assert.equal(docs[0].version, 1);
  assert.equal(docs[1].version, 2);
  assert.equal(mockStorage.client.objects.size, 2);
});

test('upload validates document structure and stores nothing for rejected content', async () => {
  const admin = await createUser({ name: 'P4 Adm C', email: 'p4.adm.c@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);

  const fake = await uploadDoc(`/api/documents/upload/${contract._id}`, token, Buffer.from('This is just text, not a pdf!'), 'notes.pdf', 'application/pdf');
  assert.equal(fake.status, 400);
  assert.match(fake.data.message, /content does not match/);

  const notDocx = await uploadDoc(`/api/documents/upload/${contract._id}`, token, Buffer.from('plain text claiming docx'), 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(notDocx.status, 400);

  const validDocx = await uploadDoc(`/api/documents/upload/${contract._id}`, token, DOCX_FIXTURE, 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(validDocx.status, 201, JSON.stringify(validDocx.data));
  assert.equal(validDocx.data.fileType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 1, 'only the structured DOCX is stored');
  assert.equal(mockStorage.client.objects.size, 1);
});

test('upload rejects disallowed extensions and oversized files with 400 and 413', async () => {
  const admin = await createUser({ name: 'P4 Adm D', email: 'p4.adm.d@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);

  const exe = await uploadDoc(`/api/documents/upload/${contract._id}`, token, Buffer.from('MZ...'), 'tool.exe', 'application/octet-stream');
  assert.equal(exe.status, 400);
  assert.match(exe.data.message, /PDF, DOCX and DOC/);

  const huge = await uploadDoc(`/api/documents/upload/${contract._id}`, token, Buffer.concat([PDF_MAGIC, Buffer.alloc(11 * 1024 * 1024)]), 'big.pdf', 'application/pdf');
  assert.equal(huge.status, 413);
  assert.match(huge.data.message, /10 MiB/);

  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0);
  assert.equal(mockStorage.client.objects.size, 0);
});

test('upload enforces contract access; employees cannot upload to foreign contracts', async () => {
  const owner = await createUser({ name: 'P4 Emp I', email: 'p4.emp.i@ricoz.test' });
  const stranger = await createUser({ name: 'P4 Emp J', email: 'p4.emp.j@ricoz.test' });
  const contract = await makeContract({ createdBy: owner._id, assignedUser: owner._id, status: 'Active' });

  const denied = await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(stranger), PDF_MAGIC, 'theirs.pdf', 'application/pdf');
  assert.equal(denied.status, 403);
  assert.match(denied.data.message, /access/);
  assert.equal(mockStorage.client.objects.size, 0, 'unauthorized uploads never reach object storage');
});

test('uploads are blocked for archived contracts', async () => {
  const admin = await createUser({ name: 'P4 Adm E', email: 'p4.adm.e@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', isArchived: true });
  const up = await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(admin), PDF_MAGIC, 'late.pdf', 'application/pdf');
  assert.equal(up.status, 400);
  assert.match(up.data.message, /archived/);
});

test('downloads are authorized, streamed from Supabase Storage, and never expose a public URL', async () => {
  const owner = await createUser({ name: 'P4 Emp K', email: 'p4.emp.k@ricoz.test' });
  const stranger = await createUser({ name: 'P4 Emp L', email: 'p4.emp.l@ricoz.test' });
  const admin = await createUser({ name: 'P4 Adm F', email: 'p4.adm.f@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: owner._id, assignedUser: owner._id, status: 'Active' });

  const up = await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(admin), PDF_MAGIC, 'secret.pdf', 'application/pdf');
  assert.equal(up.status, 201);
  const docId = up.data._id;
  const stored = await ContractDocument.findById(docId).select('+storageKey');

  const ok = await fetch(baseURL + `/api/documents/download/${docId}`, { headers: { authorization: `Bearer ${signToken(owner)}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.match(ok.headers.get('content-disposition'), /attachment/);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.equal(Buffer.from(await ok.arrayBuffer()).equals(PDF_MAGIC), true);
  assert.equal(ok.headers.get('location'), null);
  assert.equal(ok.headers.get('x-amz-meta-sha256'), null);

  const denied = await fetch(baseURL + `/api/documents/download/${docId}`, { headers: { authorization: `Bearer ${signToken(stranger)}` } });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).message, /access/);

  assert.equal(await mockStorage.adapter.exists({ backend: 'supabase', key: stored.storageKey }), true);
  assert.equal(await mockStorage.adapter.delete({ backend: 'supabase', key: stored.storageKey }, { authorizedBy: 'system-cleanup' }), true);
  assert.equal(await mockStorage.adapter.exists({ backend: 'supabase', key: stored.storageKey }), false);
});

test('no Supabase secret, project URL or storage path is ever exposed by the API', async () => {
  const admin = await createUser({ name: 'P5 Leak Admin', email: 'p5.leak.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);
  const secrets = [mockStorage.secretKey, mockStorage.projectUrl, 'supabase.co', '/storage/v1/', 'apikey', 'sb_secret_'];

  const up = await uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'confidential.pdf', 'application/pdf');
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const stored = await ContractDocument.findById(up.data._id).select('+storageKey +storageBackend +filePath');

  const listed = await fetch(baseURL + `/api/documents/contract/${contract._id}`, { headers: { authorization: `Bearer ${token}` } });
  const download = await fetch(baseURL + `/api/documents/download/${up.data._id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200);
  const downloadBody = Buffer.from(await download.arrayBuffer());

  const payloads = [
    ['upload response', JSON.stringify(up.data)],
    ['list response', JSON.stringify(await listed.json())],
    ['download headers', JSON.stringify(Object.fromEntries(download.headers.entries()))]
  ];

  for (const [label, payload] of payloads) {
    for (const secret of secrets) {
      assert.equal(payload.includes(secret), false, `${label} must not contain ${secret}`);
    }
    assert.equal(payload.includes(stored.storageKey), false, `${label} must not contain the storage key`);
  }

  assert.equal(up.data.storageBackend, undefined, 'the storage backend is not exposed');
  assert.equal(up.data.storageKey, undefined, 'the storage key is not exposed');
  assert.equal(up.data.filePath, undefined, 'the legacy path is not exposed');
  assert.equal(download.headers.get('location'), null, 'downloads are never redirected to a provider URL');
  assert.equal(downloadBody.equals(PDF_MAGIC), true, 'the authorised bytes are still returned in full');
  assert.match(up.data.checksum, /^[a-f0-9]{64}$/, 'the SHA-256 checksum is preserved on the document');
});

test('a missing stored object returns 404 and a provider failure returns 503', async () => {
  const admin = await createUser({ name: 'P5 Doc Admin', email: 'p5.doc.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);

  const missingMetadata = await fetch(baseURL + '/api/documents/download/507f1f77bcf86cd799439011', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(missingMetadata.status, 404);
  assert.match((await missingMetadata.json()).message, /Document not found/);

  const up = await uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'vanishing.pdf', 'application/pdf');
  assert.equal(up.status, 201);
  const stored = await ContractDocument.findById(up.data._id).select('+storageKey');
  mockStorage.client.objects.delete(stored.storageKey);

  const missing = await fetch(baseURL + `/api/documents/download/${up.data._id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /unavailable/);

  mockStorage.client.failDownloads = true;
  const unavailable = await fetch(baseURL + `/api/documents/download/${up.data._id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).message, /temporarily unavailable/);
});

test('provider upload failures return 503 without creating metadata or objects', async () => {
  const admin = await createUser({ name: 'P5 Storage Admin', email: 'p5.storage.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });

  mockStorage.client.failUploads = true;
  const response = await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(admin), PDF_MAGIC, 'provider-down.pdf', 'application/pdf');
  assert.equal(response.status, 503);
  assert.match(response.data.message, /temporarily unavailable/);
  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0);
  assert.equal(mockStorage.client.objects.size, 0);
});

test('concurrent uploads receive unique sequential document versions', async () => {
  const admin = await createUser({ name: 'P5 Concurrent Admin', email: 'p5.concurrent.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const token = signToken(admin);

  const responses = await Promise.all([
    uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'parallel-a.pdf', 'application/pdf'),
    uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'parallel-b.pdf', 'application/pdf'),
    uploadDoc(`/api/documents/upload/${contract._id}`, token, PDF_MAGIC, 'parallel-c.pdf', 'application/pdf')
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 201, 201]);
  const versions = responses.map((response) => response.data.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2, 3]);
  const stored = await ContractDocument.find({ contract: contract._id }).sort({ version: 1 }).select('+storageKey');
  assert.equal(stored.length, 3);
  assert.equal(new Set(stored.map((doc) => doc.storageKey)).size, 3, 'each version uses a unique randomized object key');
});

test('legacy local documents remain readable through the read-only fallback', async () => {
  const admin = await createUser({ name: 'P5 Legacy Admin', email: 'p5.legacy.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const legacyName = 'legacy-contract.pdf';
  const legacyPath = path.join(mockStorage.uploadDirectory, legacyName);
  require('node:fs').writeFileSync(legacyPath, PDF_MAGIC);

  const doc = await ContractDocument.create({
    contract: contract._id,
    filename: legacyName,
    originalname: legacyName,
    filePath: legacyPath,
    fileSize: PDF_MAGIC.length,
    fileType: 'application/pdf',
    version: 1,
    uploadedBy: admin._id
  });

  const response = await fetch(baseURL + `/api/documents/download/${doc._id}`, { headers: { authorization: `Bearer ${signToken(admin)}` } });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).equals(PDF_MAGIC), true);
  assert.equal(await mockStorage.adapter.exists({ backend: 'local', filePath: legacyPath }), true);
  await assert.rejects(
    mockStorage.adapter.delete({ backend: 'local', filePath: legacyPath }, { authorizedBy: admin._id }),
    (error) => error.code === 'STORAGE_FORBIDDEN'
  );
  assert.equal(require('node:fs').existsSync(legacyPath), true, 'legacy files are never deleted');
});

test('a legacy document whose file is gone returns a clear 404 and reports exists() false', async () => {
  const admin = await createUser({ name: 'P5 Lost Legacy', email: 'p5.lost.legacy@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const lostPath = path.join(mockStorage.uploadDirectory, 'no-longer-here.pdf');

  const doc = await ContractDocument.create({
    contract: contract._id,
    filename: 'no-longer-here.pdf',
    originalname: 'no-longer-here.pdf',
    filePath: lostPath,
    fileSize: 1024,
    fileType: 'application/pdf',
    version: 1,
    uploadedBy: admin._id
  });

  const listed = await fetch(baseURL + `/api/documents/contract/${contract._id}`, { headers: { authorization: `Bearer ${signToken(admin)}` } });
  assert.equal(listed.status, 200, 'the metadata row is still listed even when the file is gone');
  const listedBody = await listed.json();
  assert.equal(listedBody.length, 1);
  assert.equal(listedBody[0]._id, String(doc._id));
  assert.equal(listedBody[0].filePath, undefined, 'legacy paths stay hidden from the API');

  const response = await fetch(baseURL + `/api/documents/download/${doc._id}`, { headers: { authorization: `Bearer ${signToken(admin)}` } });
  assert.equal(response.status, 404);
  const message = (await response.json()).message;
  assert.match(message, /unavailable/);
  assert.match(message, /upload a new version/i, 'the message tells the user how to recover');
  assert.doesNotMatch(message, /permission|access|not permitted/i, 'the message must not read like a permissions error');
});

test('exists() returns false instead of throwing for missing, stale and invalid legacy references', async () => {
  const adapter = mockStorage.adapter;
  const presentPath = path.join(mockStorage.uploadDirectory, 'exists-present.pdf');
  require('node:fs').writeFileSync(presentPath, PDF_MAGIC);

  assert.equal(await adapter.exists({ backend: 'local', filePath: presentPath }), true, 'existing file');

  const cases = [
    ['missing file inside the upload directory', { backend: 'local', filePath: path.join(mockStorage.uploadDirectory, 'absent.pdf') }],
    ['stale absolute path from a previous host', { backend: 'local', filePath: '/app/uploads/1758-deadbeef.pdf' }],
    ['directory that is not the upload directory', { backend: 'local', filePath: path.join(mockStorage.uploadDirectory, '..', 'elsewhere', 'x.pdf') }],
    ['path traversal attempt', { backend: 'local', filePath: '../../../../etc/passwd' }],
    ['null filePath', { backend: 'local', filePath: null }],
    ['empty filePath', { backend: 'local', filePath: '   ' }],
    ['no backend and no filePath', {}]
  ];

  for (const [label, input] of cases) {
    assert.equal(await adapter.exists(input), false, `exists() must return false for ${label}`);
  }

  assert.equal(await adapter.exists({ backend: 'local', filePath: mockStorage.uploadDirectory }), false,
    'a directory is not an existing document file');
  assert.equal(await adapter.exists({ backend: 'supabase', key: 'documents/2026/01/absent.pdf' }), false,
    'a missing Supabase object still returns false');
  assert.equal(await adapter.exists({ backend: 'supabase', key: null }), false, 'a null Supabase key returns false without needing credentials');
  assert.equal(await adapter.exists({ backend: 'r2', key: 'documents/2026/01/retired.pdf' }), false,
    'the retired R2 backend never reports an existing object');
});

test('legacy exists() still surfaces genuine filesystem outages as errors', async () => {
  const adapter = mockStorage.adapter;
  const unreadable = path.join(mockStorage.uploadDirectory, 'present.pdf');
  require('node:fs').writeFileSync(unreadable, PDF_MAGIC);

  const originalRealpathFs = require('node:fs').promises.realpath;
  require('node:fs').promises.realpath = async () => { const error = new Error('EACCES'); error.code = 'EACCES'; throw error; };

  try {
    await assert.rejects(
      adapter.exists({ backend: 'local', filePath: unreadable }),
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503,
      'a permission error on the filesystem must not be reported as "does not exist"'
    );
  } finally {
    require('node:fs').promises.realpath = originalRealpathFs;
  }
});

test('failed metadata persistence removes the object from storage', async () => {
  const admin = await createUser({ name: 'P5 Cleanup Admin', email: 'p5.cleanup.admin@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active' });
  const originalCreate = ContractDocument.create;
  ContractDocument.create = async () => { throw new Error('forced metadata failure'); };

  try {
    const response = await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(admin), PDF_MAGIC, 'cleanup.pdf', 'application/pdf');
    assert.equal(response.status, 500);
  } finally {
    ContractDocument.create = originalCreate;
  }

  assert.equal(mockStorage.client.objects.size, 0, 'the uploaded object is removed after metadata failure');
  assert.equal(await ContractDocument.countDocuments({ contract: contract._id }), 0);
});

// ---------------------------------------------------------------------------
// Automatic expiry scheduled job
// ---------------------------------------------------------------------------

test('expiry marks past-end-date Active contracts Expired exactly once with an activity log', async () => {
  const admin = await createUser({ name: 'P4 Adm G', email: 'p4.adm.g@ricoz.test', role: 'Admin' });
  const past = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(-5) } });

  const result = await expireEligibleContracts();
  assert.equal(result.expired, 1);

  const reloaded = await Contract.findById(past._id);
  assert.equal(reloaded.status, 'Expired');

  const logs = await ActivityLog.find({ contract: past._id });
  assert.equal(logs.length, 1, 'expiry is logged once');
  assert.equal(logs[0].action, 'Contract Expired');
});

test('expiry uses UTC calendar-day rule: contracts ending today or later stay Active', async () => {
  const admin = await createUser({ name: 'P4 Adm H', email: 'p4.adm.h@ricoz.test', role: 'Admin' });
  const endingToday = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(0) } });
  const future = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(30) } });

  const result = await expireEligibleContracts();
  assert.equal(result.expired, 0, 'ending today is not expired until its full day passes');
  assert.equal((await Contract.findById(endingToday._id)).status, 'Active');
  assert.equal((await Contract.findById(future._id)).status, 'Active');
});

test('expiry excludes archived, Closed and already-Expired contracts', async () => {
  const admin = await createUser({ name: 'P4 Adm I', email: 'p4.adm.i@ricoz.test', role: 'Admin' });
  const archived = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(-10) }, isArchived: true });
  const closed = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Closed', overrides: { endDate: utcDay(-10) } });
  const renewed = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Renewed', overrides: { endDate: utcDay(-3) } });

  const result = await expireEligibleContracts();
  assert.equal(result.expired, 0);
  assert.equal((await Contract.findById(archived._id)).status, 'Active', 'archived contracts are preserved');
  assert.equal((await Contract.findById(closed._id)).status, 'Closed');
  assert.equal((await Contract.findById(renewed._id)).status, 'Renewed');
});

test('expiry is idempotent and preserves renewed contracts (revived to Active with future end date)', async () => {
  const admin = await createUser({ name: 'P4 Adm J', email: 'p4.adm.j@ricoz.test', role: 'Admin' });
  const backdated = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(-20) } });
  // A contract that was renewed: already Active with a far-future end date.
  const renewedFuture = await makeContract({ createdBy: admin._id, assignedUser: admin._id, status: 'Active', overrides: { endDate: utcDay(400) } });

  const first = await expireEligibleContracts();
  assert.equal(first.expired, 1);

  const second = await expireEligibleContracts();
  assert.equal(second.expired, 0, 'a second run changes nothing');
  assert.equal((await Contract.findById(renewedFuture._id)).status, 'Active', 'renewed contract stays Active');
});

// ---------------------------------------------------------------------------
// RBAC regression (access utility + invalid ids + employee isolation)
// ---------------------------------------------------------------------------

test('canAccessContract: Admin/Manager bypass, Employees are scoped to their ownership', async () => {
  const owner = await createUser({ name: 'P4 Emp M', email: 'p4.emp.m@ricoz.test' });
  const other = await createUser({ name: 'P4 Emp N', email: 'p4.emp.n@ricoz.test' });
  const manager = await createUser({ name: 'P4 Mgr C', email: 'p4.mgr.c@ricoz.test', role: 'Manager' });

  const contract = await makeContract({ createdBy: owner._id, assignedUser: owner._id, status: 'Active' });

  assert.equal(canAccessContract(owner, contract), true, 'createdBy employee can access');
  assert.equal(canAccessContract(manager, contract), true, 'manager bypasses scope');
  assert.equal(canAccessContract(other, contract), false, 'unrelated employee is blocked');

  const scope = employeeContractScope(owner._id);
  assert.ok(scope.$or.some((clause) => clause.createdBy?.toString() === owner._id.toString() || clause.assignedUser?.toString() === owner._id.toString()));

  const emplList = await Contract.find({ ...scope, status: 'Active' });
  assert.equal(emplList.some((c) => c._id.toString() === contract._id.toString()), true, 'assigned employee sees the contract in their scoped listing');
});

test('invalid ids in approval/submit and document endpoints return 400', async () => {
  const admin = await createUser({ name: 'P4 Adm K', email: 'p4.adm.k@ricoz.test', role: 'Admin' });
  const token = signToken(admin);

  const submitBad = await api('POST', '/api/approvals/submit/not-an-id', { token, body: {} });
  assert.equal(submitBad.status, 400);

  const listBad = await api('GET', '/api/documents/contract/not-an-id', { token });
  assert.equal(listBad.status, 400);

  const downloadBad = await fetch(baseURL + '/api/documents/download/not-an-id', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(downloadBad.status, 400);
});

test('backend-transition enforcement: manual edits cannot jump straight to Active', async () => {
  assert.equal(canTransition('Draft', 'Active'), false, 'manual edit cannot skip the approval gate');
  assert.equal(canTransition('Draft', 'Pending Approval'), true);
  assert.equal(canTransition('Pending Approval', 'Draft'), true);
  assert.equal(canTransition('Active', 'Expired'), true);
  assert.equal(canTransition('Expired', 'Active'), false, 'only renewal revives an expired contract');
  assert.equal(canSubmitForApproval('Rejected'), true);
  assert.equal(canSubmitForApproval('Active'), false);
  assert.equal(canRenewContract('Expired'), true);
  assert.equal(canRenewContract('Draft'), false);
});

test('activity history never exposes password or financial amounts in details', async () => {
  const employee = await createUser({ name: 'P4 Emp O', email: 'p4.emp.o@ricoz.test' });
  const admin = await createUser({ name: 'P4 Adm L', email: 'p4.adm.l@ricoz.test', role: 'Admin' });
  const contract = await makeContract({ createdBy: employee._id, assignedUser: employee._id, status: 'Pending Approval' });

  const approval = await require('../models/Approval').create({ contract: contract._id, requestedBy: employee._id, status: 'Pending' });
  await api('PUT', `/api/approvals/${approval._id}/action`, { token: signToken(admin), body: { action: 'Approved', comments: 'Approved per policy' } });
  await uploadDoc(`/api/documents/upload/${contract._id}`, signToken(admin), PDF_MAGIC, 'clean.pdf', 'application/pdf');

  const logs = await ActivityLog.find({ contract: contract._id });
  assert.ok(logs.length >= 2);
  for (const log of logs) {
    assert.equal(log.details.includes('Password123!'), false, 'passwords must not appear in activity details');
    assert.equal(log.details.includes('1000'), false, 'financial amounts must not appear in activity details');
    assert.equal(log.details.includes('Password123!'), false);
  }
});

const buildIndexProbeModel = () => {
  const schema = new mongoose.Schema({
    contract: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number }
  }, { collection: 'index_probe' });
  schema.index({ contract: 1, version: 1 }, { unique: true });
  return mongoose.models.IndexProbe || mongoose.model('IndexProbe', schema);
};

test('the index check reports duplicates and refuses to build, without changing any record', async () => {
  const Probe = buildIndexProbeModel();
  await Probe.collection.deleteMany({});

  const contract = new mongoose.Types.ObjectId();
  await Probe.collection.insertMany([
    { contract, version: 1, originalname: 'a.pdf' },
    { contract, version: 1, originalname: 'b.pdf' },
    { contract, version: 1, originalname: 'c.pdf' }
  ]);

  const before = await Probe.collection.countDocuments();
  const report = await readDocumentVersionIndexReport(Probe, { maxTimeMS: 10000 });

  assert.equal(report.indexReady, false);
  assert.equal(report.ready, false);
  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.duplicateGroups[0].count, 3);
  assert.ok(report.blockers.some((blocker) => blocker.code === 'DUPLICATE_DOCUMENT_VERSIONS'));

  await assert.rejects(
    syncDocumentVersionIndex(Probe, { maxTimeMS: 10000 }),
    (error) => error.code === 'DOCUMENT_INDEX_BLOCKED'
  );

  assert.equal(await Probe.collection.countDocuments(), before, 'no document was added, changed or removed');
  const state = await readIndexState(Probe);
  assert.equal(state.indexReady, false, 'the unique index must not be created while duplicates exist');

  const description = describeDocumentIndexReport(report);
  assert.match(description, /ACTION REQUIRED/);
  assert.match(description, /DUPLICATE_DOCUMENT_VERSIONS/);
  assert.match(description, /appears 3 time/);
  assert.match(description, /No data was changed/);

  await Probe.collection.deleteMany({});
});

test('the index check separates documents that have no version value', async () => {
  const Probe = buildIndexProbeModel();
  await Probe.collection.deleteMany({});

  const contract = new mongoose.Types.ObjectId();
  await Probe.collection.insertMany([
    { contract, originalname: 'no-version-1.pdf' },
    { contract, originalname: 'no-version-2.pdf' }
  ]);

  const report = await readDocumentVersionIndexReport(Probe, { maxTimeMS: 10000 });

  assert.equal(report.duplicateGroups.length, 0, 'missing-version rows are not counted as duplicate versions');
  assert.equal(report.missingVersionGroups.length, 1);
  assert.equal(report.missingVersionGroups[0].count, 2);
  assert.ok(report.blockers.some((blocker) => blocker.code === 'DOCUMENTS_MISSING_VERSION'));

  await assert.rejects(
    syncDocumentVersionIndex(Probe, { maxTimeMS: 10000 }),
    (error) => error.code === 'DOCUMENT_INDEX_BLOCKED'
  );

  await Probe.collection.deleteMany({});
});

test('the index procedure builds the unique index on clean data and is idempotent', async () => {
  const Probe = buildIndexProbeModel();
  await Probe.collection.deleteMany({});

  const first = await syncDocumentVersionIndex(Probe, { maxTimeMS: 10000 });
  assert.equal(first.created, true);
  assert.equal(first.ready, true);
  assert.equal(first.indexUnique, true);

  const second = await syncDocumentVersionIndex(Probe, { maxTimeMS: 10000 });
  assert.equal(second.created, false, 'a second run does not rebuild the index');
  assert.equal(second.ready, true);

  const contract = new mongoose.Types.ObjectId();
  await Probe.collection.insertOne({ contract, version: 1 });
  await assert.rejects(
    Probe.collection.insertOne({ contract, version: 1 }),
    (error) => error.code === 11000,
    'the unique index now rejects duplicate contract/version pairs'
  );

  const report = await readDocumentVersionIndexReport(Probe, { maxTimeMS: 10000 });
  assert.equal(report.ready, true);
  assert.match(describeDocumentIndexReport(report), /status: ready/);

  await Probe.collection.deleteMany({});
});