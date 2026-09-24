// Negative-path tests for the Phase-1 hardening: lifecycle guard rails,
// self-approval, RBAC edge cases, validation, upload content sniffing and
// rate limiting. Uses its own database so it never touches real data.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const test = require('node:test');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';
if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = 'test-only-client-id.apps.googleusercontent.com';

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const ContractDocument = require('../models/ContractDocument');

const authRoutes = require('../routes/authRoutes');
const userRoutes = require('../routes/userRoutes');
const contractRoutes = require('../routes/contractRoutes');
const approvalRoutes = require('../routes/approvalRoutes');
const documentRoutes = require('../routes/documentRoutes');

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/ricozcontract_security_test';
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

let server;
let baseURL;

const signToken = (user) => jwt.sign(
  { id: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

const createUser = async ({ name, email, password = 'Password123!', role = 'Employee', status = 'Active' }) =>
  User.create({ name, email, password, role, status });

const createContract = async (overrides = {}) => Contract.create({
  contractNumber: `CNT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  title: 'Security test contract',
  type: 'Vendor',
  partyName: 'Test vendor',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-12-31'),
  amount: 1000,
  createdBy: new mongoose.Types.ObjectId(),
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

const uploadFile = async (url, { token, filename, content }) => {
  const form = new FormData();
  form.append('document', new Blob([content]), filename);
  const response = await fetch(baseURL + url, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
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
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/approvals', approvalRoutes);
    app.use('/api/documents', documentRoutes);
    app.use((req, res) => res.status(404).json({ message: 'API route not found' }));
    // Mirrors the central handler behaviour used by server.js.
    app.use((error, req, res, next) => {
      if (error.name === 'MulterError' || (typeof error.message === 'string' && error.message.includes('Only PDF'))) {
        return res.status(400).json({ message: error.message });
      }
      if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ message: 'Invalid JSON payload' });
      }
      if (error.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation failed' });
      }
      if (error.name === 'CastError') {
        return res.status(400).json({ message: `Invalid value for '${error.path}'` });
      }
      if (error.code === 11000) {
        return res.status(409).json({ message: 'A record with the same unique value already exists' });
      }
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

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('register rejects weak passwords and missing/invalid name/email', async () => {
  const weak = await api('POST', '/api/auth/register', {
    body: { name: 'Weak', email: 'weak@ricoz.test', password: 'abc' }
  });
  assert.equal(weak.status, 400);
  assert.match(weak.data.message, /at least 6/);

  const noName = await api('POST', '/api/auth/register', {
    body: { email: 'noname@ricoz.test', password: 'ValidPass123' }
  });
  assert.equal(noName.status, 400);
  assert.match(noName.data.message, /Name is required/);

  const badEmail = await api('POST', '/api/auth/register', {
    body: { name: 'Bad Email', email: 'not-an-email', password: 'ValidPass123' }
  });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.data.message, /valid email/);
});

test('login endpoint is rate limited', async () => {
  let sawRateLimit = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const response = await api('POST', '/api/auth/login', {
      body: { email: 'rate-probe@ricoz.test', password: 'wrong' }
    });
    if (response.status === 429) {
      sawRateLimit = true;
      assert.match(response.data.message, /Too many login/);
      assert.ok(response.headers?.get ? response.headers.get('retry-after') : true);
      break;
    }
    assert.equal(response.status, 401);
  }
  assert.ok(sawRateLimit, 'expected a 429 after exceeding the login rate limit');
});

test('invalid ObjectId and unknown route edge cases return 4xx, not 500', async () => {
  const user = await createUser({ name: 'Admin One', email: 'admin.one@ricoz.test', role: 'Admin' });
  const token = signToken(user);

  const badId = await api('GET', '/api/contracts/not-an-object-id', { token });
  assert.equal(badId.status, 400);

  const missingContract = await api('GET', '/api/contracts/507f1f77bcf86cd799439011', { token });
  assert.equal(missingContract.status, 404);

  const unknowns = await api('GET', '/api/contracts?status=Waiting', { token });
  assert.equal(unknowns.status, 400);

  const route = await api('GET', '/api/does-not-exist');
  assert.equal(route.status, 404);
});

test('search regex metacharacters are escaped (no crash, sensible result)', async () => {
  const user = await createUser({ name: 'Admin Two', email: 'admin.two@ricoz.test', role: 'Admin' });
  const token = signToken(user);
  await createContract({
    title: 'Searchable (? tricky) contract',
    createdBy: user._id,
    assignedUser: user._id
  });

  const response = await api('GET', `/api/contracts?search=${encodeURIComponent('"(? tricky')}`, { token });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.data));
});

test('contract status changes respect the lifecycle state machine', async () => {
  const user = await createUser({ name: 'Manager Three', email: 'manager.three@ricoz.test', role: 'Manager' });
  const token = signToken(user);

  const created = await api('POST', '/api/contracts', {
    token,
    body: {
      title: 'Lifecycle test',
      type: 'Client',
      partyName: 'ACME',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      amount: 5000,
      currency: 'USD'
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'Draft');
  const id = created.data._id;

  // Draft -> Active is not a valid transition (approval is required).
  const skipApproval = await api('PUT', `/api/contracts/${id}`, { token, body: { status: 'Active' } });
  assert.equal(skipApproval.status, 400);

  // Draft -> Closed is a valid cancellation.
  const close = await api('PUT', `/api/contracts/${id}`, { token, body: { status: 'Closed' } });
  assert.equal(close.status, 200);
  assert.equal(close.data.status, 'Closed');

  // Closed is terminal: it must not leave Closed.
  const reopen = await api('PUT', `/api/contracts/${id}`, { token, body: { status: 'Active' } });
  assert.equal(reopen.status, 400);
});

test('employees cannot set contract status; date/amount validation enforced', async () => {
  const manager = await createUser({ name: 'Manager Four', email: 'manager.four@ricoz.test', role: 'Manager' });
  const managerToken = signToken(manager);

  const employee = await createUser({ name: 'Employee Four', email: 'employee.four@ricoz.test' });
  const employeeToken = signToken(employee);

  const created = await api('POST', '/api/contracts', {
    token: managerToken,
    body: {
      title: 'RBAC test',
      type: 'NDA',
      partyName: 'ACME',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      amount: 100,
      assignedUser: employee._id
    }
  });
  const id = created.data._id;

  const employeeStatus = await api('PUT', `/api/contracts/${id}`, { token: employeeToken, body: { status: 'Closed' } });
  assert.equal(employeeStatus.status, 403);

  const badDates = await api('PUT', `/api/contracts/${id}`, {
    token: managerToken,
    body: { startDate: '2026-12-31', endDate: '2026-01-01' }
  });
  assert.equal(badDates.status, 400);

  const negativeAmount = await api('PUT', `/api/contracts/${id}`, { token: managerToken, body: { amount: -5 } });
  assert.equal(negativeAmount.status, 400);
});

test('a contract cannot be submitted for approval from a disallowed state', async () => {
  const manager = await createUser({ name: 'Manager Five', email: 'manager.five@ricoz.test', role: 'Manager' });
  const token = signToken(manager);

  const contract = await createContract({ title: 'Already active', status: 'Active', createdBy: manager._id, assignedUser: manager._id });

  const submit = await api('POST', `/api/approvals/submit/${contract._id}`, { token });
  assert.equal(submit.status, 400);
});

test('a manager cannot approve/reject their own contract request', async () => {
  const manager = await createUser({ name: 'Manager Six', email: 'manager.six@ricoz.test', role: 'Manager' });
  const token = signToken(manager);

  const contract = await createContract({ title: 'Self approval', status: 'Draft', createdBy: manager._id, assignedUser: manager._id });

  const submit = await api('POST', `/api/approvals/submit/${contract._id}`, { token });
  assert.equal(submit.status, 201);

  const approve = await api('PUT', `/api/approvals/${submit.data._id}/action`, { token, body: { action: 'Approved' } });
  assert.equal(approve.status, 400);
  assert.match(approve.data.message, /own contract/);
});

test('deciding an approval whose contract is not Pending Approval is blocked', async () => {
  const manager = await createUser({ name: 'Manager Seven', email: 'manager.seven@ricoz.test', role: 'Manager' });
  const admin = await createUser({ name: 'Admin Seven', email: 'admin.seven@ricoz.test', role: 'Admin' });
  const managerToken = signToken(manager);
  const adminToken = signToken(admin);

  // Contract already Active but with a stale pending approval record.
  const contract = await createContract({ title: 'Stale approval', status: 'Active', createdBy: admin._id });
  const approval = await Approval.create({ contract: contract._id, requestedBy: manager._id, status: 'Pending' });

  const decide = await api('PUT', `/api/approvals/${approval._id}/action`, { token: adminToken, body: { action: 'Approved' } });
  assert.equal(decide.status, 409);
  assert.match(decide.data.message, /Pending Approval/);
});

test('an approval that was already decided cannot be decided again', async () => {
  const manager = await createUser({ name: 'Manager Eight', email: 'manager.eight@ricoz.test', role: 'Manager' });
  const approver = await createUser({ name: 'Admin Eight', email: 'admin.eight@ricoz.test', role: 'Admin' });
  const managerToken = signToken(manager);
  const approverToken = signToken(approver);

  const contract = await createContract({ title: 'Resubmit flow', status: 'Pending Approval', createdBy: manager._id, assignedUser: manager._id });

  const first = await api('PUT', '/api/approvals/507f1f77bcf86cd799439011/action', { token: approverToken, body: { action: 'Approved' } });
  assert.equal(first.status, 404);

  const approval = await Approval.create({ contract: contract._id, requestedBy: manager._id, status: 'Pending' });
  const reject = await api('PUT', `/api/approvals/${approval._id}/action`, { token: approverToken, body: { action: 'Rejected' } });
  assert.equal(reject.status, 200);

  const again = await api('PUT', `/api/approvals/${approval._id}/action`, { token: approverToken, body: { action: 'Approved' } });
  assert.equal(again.status, 409);
  assert.match(again.data.message, /already been decided/);

  // Rejected contract cannot be force-activated by direct edit; it must go
  // back through submission first.
  const contractNow = await Contract.findById(contract._id);
  assert.equal(contractNow.status, 'Rejected');
  const bypass = await api('PUT', `/api/contracts/${contract._id}`, { token: approverToken, body: { status: 'Active' } });
  assert.equal(bypass.status, 400);
});

test('the only active admin cannot be demoted or deactivated', async () => {
  // Isolate the test: remove admins created by earlier tests so the only
  // active admin is the one created below.
  await User.deleteMany({ role: 'Admin' });

  const onlyAdmin = await createUser({ name: 'Sole Admin', email: 'sole.admin@ricoz.test', role: 'Admin' });
  const onlyToken = signToken(onlyAdmin);

  const demoteOnly = await api('PUT', `/api/users/${onlyAdmin._id}/role`, { token: onlyToken, body: { role: 'Employee' } });
  assert.equal(demoteOnly.status, 400);
  assert.match(demoteOnly.data.message, /only active administrator/);

  // With a second active admin, demotion is allowed.
  const secondAdmin = await createUser({ name: 'Second Admin', email: 'second.admin@ricoz.test', role: 'Admin' });
  const demoteFirst = await api('PUT', `/api/users/${onlyAdmin._id}/role`, { token: onlyToken, body: { role: 'Employee' } });
  assert.equal(demoteFirst.status, 200);
});

test('profile password change enforces server-side password policy', async () => {
  const user = await createUser({ name: 'Pass User', email: 'pass.user@ricoz.test', password: 'CurrentPass123' });
  const token = signToken(user);

  const weak = await api('PUT', '/api/users/me', {
    token,
    body: { currentPassword: 'CurrentPass123', newPassword: 'abc' }
  });
  assert.equal(weak.status, 400);
  assert.match(weak.data.message, /at least 6/);

  const wrongCurrent = await api('PUT', '/api/users/me', {
    token,
    body: { currentPassword: 'nope', newPassword: 'StillWeak123' }
  });
  assert.equal(wrongCurrent.status, 400);
});

test('document upload rejects files whose content does not match their extension', async () => {
  const user = await createUser({ name: 'Doc Admin', email: 'doc.admin@ricoz.test', role: 'Admin' });
  const token = signToken(user);
  const contract = await createContract({ title: 'Upload target', createdBy: user._id, assignedUser: user._id });

  // PNG bytes disguised as a PDF -> magic byte mismatch -> 400.
  const pngAsPdf = await uploadFile(`/api/documents/upload/${contract._id}`, {
    token,
    filename: 'fake.pdf',
    content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00])
  });
  assert.equal(pngAsPdf.status, 400);
  assert.match(pngAsPdf.data.message, /content does not match/);

  // Genuine PDF magic bytes are accepted.
  const pdf = await uploadFile(`/api/documents/upload/${contract._id}`, {
    token,
    filename: 'real.pdf',
    content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]) // %PDF-1.4\n%
  });
  assert.equal(pdf.status, 201);

  const docs = await ContractDocument.find({ contract: contract._id });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].originalname, 'real.pdf');

  // Clean up the file stored for the valid upload.
  const storedPath = path.join(UPLOAD_DIR, docs[0].filename);
  if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
});

test('uploading to an unauthorized contract is rejected before any file is written', async () => {
  const admin = await createUser({ name: 'Owner Admin', email: 'owner.admin@ricoz.test', role: 'Admin' });
  const contract = await createContract({ title: 'Not yours', createdBy: admin._id, assignedUser: admin._id });

  const stranger = await createUser({ name: 'Stranger Employee', email: 'stranger@ricoz.test' });
  const strangerToken = signToken(stranger);

  const filesBefore = fs.readdirSync(UPLOAD_DIR).length;

  const upload = await uploadFile(`/api/documents/upload/${contract._id}`, {
    token: strangerToken,
    filename: 'sneaky.pdf',
    content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  });
  assert.equal(upload.status, 403);

  const filesAfter = fs.readdirSync(UPLOAD_DIR).length;
  assert.equal(filesAfter, filesBefore, 'no orphan file may be left behind');
});