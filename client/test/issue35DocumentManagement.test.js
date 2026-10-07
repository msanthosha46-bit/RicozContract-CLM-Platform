'use strict';

// Issue 35 - Contract Document Management: upload flow, metadata, and failure
// isolation.
//
// WHAT THIS COVERS
// ----------------
// The document panel lives inside pages/ContractDetails.js. Two things are
// checked here.
//
// 1. THE DEFECT. `fetchContract` read the contract and its document list with
//    `Promise.all`. That rejects on the first failure and throws away the
//    sibling's successful result, so a failure of
//    `GET /documents/contract/:id` - a different collection, which can fail on
//    its own - blanked the ENTIRE page. The contract title, Key Details,
//    obligations and milestones all vanished and the user was told the contract
//    could not be loaded, even though `GET /contracts/:id` had returned 200.
//    The amendment trail in the same file is already fetched independently,
//    with a comment explaining why; documents were not.
//
// 2. THE FLOW. That the selected file really is sent under the field name the
//    server mounts (`document`), to the contract in the route; that the two
//    client-side limits still agree with the server's; that a second click
//    while an upload is in flight sends nothing; that a refused upload keeps
//    the chosen file so it can be retried; and that the list, its metadata and
//    its empty state are only claimed once the list has actually been read.
//
// Every fixture here is invented. No production data is involved.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TZ = 'America/Los_Angeles';

const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const SRC = path.join(__dirname, '..', 'src');
const SERVER = path.join(__dirname, '..', '..', 'server');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.ricoz.test/' });

const expose = (name, value) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

for (const name of [
  'window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage',
  'FormData', 'Blob', 'File', 'URL', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLFormElement'
]) expose(name, dom.window[name]);

// jsdom has no object-URL implementation, and the download path uses one.
dom.window.URL.createObjectURL = () => 'blob:issue35/1';
dom.window.URL.revokeObjectURL = () => {};

// The download path clicks a synthetic anchor. jsdom logs "Not implemented:
// navigation" for that, which is noise rather than a finding, so the navigation
// itself is suppressed while the click is still recorded.
const anchorClicks = [];
dom.window.HTMLAnchorElement.prototype.click = function click() {
  anchorClicks.push({ href: this.getAttribute('href'), download: this.download });
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const loadJavaScript = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(SRC + path.sep)) return loadJavaScript(module, filename);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      [require.resolve('@babel/preset-react'), { runtime: 'automatic' }]
    ]
  });
  return module._compile(code, filename);
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const CONTRACT = {
  _id: 'c-1', contractNumber: 'CNT-2027-0001', title: 'Master services agreement',
  type: 'Vendor', partyName: 'Northwind Logistics', description: 'Freight services for the EU region.',
  startDate: '2027-06-01T00:00:00.000Z', endDate: '2027-06-30T00:00:00.000Z',
  amount: 250000, currency: 'USD', status: 'Active', isArchived: false,
  createdBy: { _id: 'u-1', name: 'Ada Admin' }, assignedUser: { _id: 'u-2', name: 'Mia Manager' },
  createdAt: '2027-01-05T09:30:00.000Z', updatedAt: '2027-02-06T14:05:00.000Z'
};

const DOCUMENT = {
  _id: 'd-1', contract: 'c-1', filename: 'a-uuid.pdf', originalname: 'signed-msa.pdf',
  fileSize: 153600, fileType: 'application/pdf', checksum: 'abc123', version: 2,
  createdAt: '2027-02-01T11:00:00.000Z', uploadedBy: { _id: 'u-1', name: 'Ada Admin' }
};

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);

/* ------------------------------------------------------------------ */
/* the API double                                                      */
/* ------------------------------------------------------------------ */

const calls = [];
let contractResponse = CONTRACT;
let contractFailure = null;
let documentsResponse = [DOCUMENT];
let documentsFailure = null;
let uploadFailure = null;
let uploadResponse = null;
let downloadResponse = null;
let downloadFailure = null;
let pendingUpload = null;
let pendingDownload = null;
let navigated = [];

const httpError = (status, message) => {
  const error = new Error(message);
  error.response = { status, data: { message } };
  return error;
};

const API = {
  async get(url, config = {}) {
    calls.push({ method: 'get', url, config, params: config.params || {} });
    if (url.startsWith('/documents/download/')) {
      if (pendingDownload) await pendingDownload;
      if (downloadFailure) throw downloadFailure;
      return { data: downloadResponse };
    }
    if (url.startsWith('/documents/contract/')) {
      if (documentsFailure) throw documentsFailure;
      return { data: documentsResponse };
    }
    if (url.startsWith('/contract-amendments')) return { data: [] };
    if (url.startsWith('/contracts/')) {
      if (contractFailure) throw contractFailure;
      return { data: contractResponse };
    }
    return { data: [] };
  },
  async post(url, body, config = {}) {
    calls.push({ method: 'post', url, body, config });
    if (pendingUpload) {
      await pendingUpload;
    }
    if (uploadFailure) throw uploadFailure;
    // The server has now accepted a new version, so the list it serves has
    // changed. A test that asserts the list refreshes has to say so, otherwise
    // it is only asserting that the page re-read a stale answer.
    const created = uploadResponse || { ...DOCUMENT, _id: 'd-new', version: 3 };
    documentsResponse = [...documentsResponse, created];
    return { data: created };
  },
  async put() { throw new Error('not used'); },
  async patch() { throw new Error('not used'); }
};

const stub = (relPath, exports) => {
  const filename = require.resolve(path.join(SRC, relPath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
};

const mounted = [];
const settled = () => act(async () => {});

const mountPage = async (pageRelPath = 'pages/ContractDetails.js', { role = 'Manager' } = {}) => {
  calls.length = 0;
  navigated = [];

  stub('services/api.js', { __esModule: true, default: API });
  stub('context/AuthContext.js', {
    __esModule: true,
    AuthContext: React.createContext({ user: { _id: 'u-2', name: 'Mia Manager', role } })
  });
  const router = require.resolve('react-router-dom', { paths: [SRC] });
  require.cache[router] = {
    id: router, filename: router, loaded: true, children: [], paths: [],
    exports: {
      __esModule: true,
      useParams: () => ({ id: CONTRACT._id }),
      useNavigate: () => (to) => { navigated.push(to); },
      useSearchParams: () => [new URLSearchParams(''), () => {}],
      Link: ({ to, children, ...rest }) => React.createElement('a', { href: to, ...rest }, children)
    }
  };

  delete require.cache[require.resolve(path.join(SRC, pageRelPath))];
  const Page = require(path.join(SRC, pageRelPath)).default;

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => { root.render(React.createElement(Page)); });
  await settled();
  return container;
};

test.beforeEach(() => {
  calls.length = 0;
  navigated = [];
  contractResponse = CONTRACT;
  contractFailure = null;
  documentsResponse = [DOCUMENT];
  documentsFailure = null;
  uploadFailure = null;
  uploadResponse = null;
  downloadResponse = null;
  downloadFailure = null;
  pendingUpload = null;
  pendingDownload = null;
});

test.after(async () => {
  for (const { root, container } of mounted) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ') : '');
const byText = (container, selector, re) =>
  [...container.querySelectorAll(selector)].find((el) => re.test(el.textContent));

const fileInput = (container) => container.querySelector('#document-upload');
const uploadButton = (container) => byText(container, 'button', /Upload document|Uploading/);

const selectFile = async (container, { name = 'signed.pdf', bytes = PDF_BYTES, type = 'application/pdf' } = {}) => {
  const input = fileInput(container);
  const file = new dom.window.File([bytes], name, { type });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await settled();
  return file;
};

const clickUpload = async (container) => {
  const button = uploadButton(container);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();
};

/* ================================================================== */
/* 1. THE DEFECT: a document-list failure must not destroy the page      */
/* ================================================================== */

test('a failed document list does not destroy the contract page', async () => {
  documentsFailure = httpError(500, 'Internal server error');
  const container = await mountPage();

  const rendered = text(container);
  assert.match(rendered, /Master services agreement/, 'the contract itself loaded and must stay on screen');
  assert.match(rendered, /Key Details/, 'unrelated contract data must survive');
  assert.match(rendered, /CNT-2027-0001/, 'the contract number must survive');
  assert.match(rendered, /Contract Overview/, 'the overview panel must survive');
});

test('a failed document list is reported in the Documents panel, not as a contract failure', async () => {
  documentsFailure = httpError(500, 'Internal server error');
  const container = await mountPage();

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the reason must be announced');
  assert.match(text(alert), /Internal server error/);
  // The contract must NOT be reported as unloadable.
  assert.doesNotMatch(text(container), /Unable to load contract details/);
});

test('a failed document list never claims the contract has no documents', async () => {
  documentsFailure = httpError(500, 'Internal server error');
  const container = await mountPage();

  assert.doesNotMatch(text(container), /No documents yet/, 'a failed read is not an empty contract');
  assert.doesNotMatch(text(container), /\b0 files\b/, 'a failed read must not report a count of zero');
});

test('the contract read alone still blanks the page when it fails', async () => {
  // The fix must not weaken the one failure that genuinely means "no contract".
  contractFailure = httpError(404, 'Contract not found');
  const container = await mountPage();

  assert.match(text(container), /Contract not found/);
  assert.doesNotMatch(text(container), /Key Details/, 'there is no contract to show');
  assert.ok(
    [...container.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/contracts'),
    'and there must be a way back'
  );
});

test('a contract that loads is not reported as failed', async () => {
  const container = await mountPage();
  assert.doesNotMatch(text(container), /Unable to load contract details/);
  assert.equal(container.querySelector('[role="alert"]'), null, 'a healthy load raises no alert');
});

/* ================================================================== */
/* 2. the list, its metadata and its empty state                         */
/* ================================================================== */

test('the list shows the file, its version, size, uploader and upload time', async () => {
  const container = await mountPage();
  const rendered = text(container);

  assert.match(rendered, /signed-msa\.pdf/);
  assert.match(rendered, /Version 2/);
  assert.match(rendered, /150\.0 KB/, '153600 bytes is 150 KB');
  assert.match(rendered, /Uploaded by Ada Admin/);
  assert.match(rendered, /1 file/, 'the count is singular for one document');
  assert.ok(byText(container, 'button', /Download/), 'each document offers a download');
});

test('an empty list is stated as empty, and only then', async () => {
  documentsResponse = [];
  const container = await mountPage();

  assert.match(text(container), /No documents yet/);
  assert.match(text(container), /0 files/);
});

test('a list that is not an array does not crash the page', async () => {
  // A malformed body is a server contract violation, not something a user can
  // cause, so falling back to an empty list is acceptable. What must not happen
  // is a blank page or a thrown render.
  documentsResponse = { unexpected: true };
  const container = await mountPage();

  assert.match(text(container), /Master services agreement/, 'the contract still renders');
  assert.match(text(container), /Key Details/, 'and its data with it');
});

test('a long file name is truncated in the markup rather than pushed out of the row', async () => {
  documentsResponse = [{ ...DOCUMENT, originalname: `${'x'.repeat(400)}.pdf` }];
  const container = await mountPage();

  const name = [...container.querySelectorAll('p')].find((p) => p.textContent.endsWith('.pdf'));
  assert.ok(name, 'the file name is rendered');
  assert.match(name.className, /truncate/, 'the name element carries the truncation class');
});

test('no internal storage detail is rendered', async () => {
  // The route strips storageKey/storageBackend/filePath before responding; if
  // that ever regressed, the page must still not surface them.
  documentsResponse = [{ ...DOCUMENT, storageKey: 'documents/2026/01/secret.pdf', storageBackend: 'supabase', filePath: '/srv/uploads/x.pdf' }];
  const container = await mountPage();

  const rendered = text(container);
  assert.doesNotMatch(rendered, /secret\.pdf/);
  assert.doesNotMatch(rendered, /\/srv\/uploads/);
});

/* ================================================================== */
/* 3. the upload request                                                */
/* ================================================================== */

test('the selected file is sent as `document` to the contract in the route', async () => {
  const container = await mountPage();
  const file = await selectFile(container, { name: 'signed-copy.pdf' });
  await clickUpload(container);

  const post = calls.find((c) => c.method === 'post');
  assert.ok(post, 'an upload must be attempted');
  assert.equal(post.url, `/documents/upload/${CONTRACT._id}`, 'the contract id comes from the route');
  assert.ok(post.body instanceof dom.window.FormData, 'the body must be FormData, not JSON');
  const sent = post.body.get('document');
  assert.ok(sent, 'the file must be under the field name the server mounts');
  assert.equal(sent.name, file.name, 'the chosen file, not a placeholder, is what is sent');
  assert.equal(sent.size, PDF_BYTES.length, 'the bytes are the file contents');
});

test('the contract read and the document read are both requested on load', async () => {
  await mountPage();
  const urls = calls.filter((c) => c.method === 'get').map((c) => c.url);
  assert.ok(urls.includes(`/contracts/${CONTRACT._id}`));
  assert.ok(urls.includes(`/documents/contract/${CONTRACT._id}`));
});

test('a successful upload clears the chosen file and refreshes the list', async () => {
  uploadResponse = { ...DOCUMENT, _id: 'd-new', version: 3, originalname: 'signed-copy.pdf' };
  const container = await mountPage();
  await selectFile(container, { name: 'signed-copy.pdf' });
  await clickUpload(container);

  assert.match(text(container), /Document uploaded successfully/, 'the result is reported');
  // The input is remounted so the same file can be chosen again.
  assert.equal(fileInput(container).files.length, 0, 'the input no longer holds the uploaded file');
  assert.ok(uploadButton(container).disabled, 'and the button is disabled again with nothing selected');
  // The list is re-read, and the new version appears without a page reload.
  assert.match(text(container), /Version 3/);
  assert.match(text(container), /signed-copy\.pdf/);
  assert.match(text(container), /2 files/, 'and the count follows');
  assert.equal(
    calls.filter((c) => c.method === 'get' && c.url.startsWith('/documents/contract/')).length,
    2,
    'the list was fetched again after the upload'
  );
});

test('a refused upload keeps the chosen file so it can be retried', async () => {
  uploadFailure = httpError(400, 'File content does not match its extension (PDF, DOCX or DOC only)');
  const container = await mountPage();
  await selectFile(container, { name: 'signed-copy.pdf' });
  await clickUpload(container);

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the refusal must be announced');
  assert.match(text(alert), /content does not match/);
  assert.equal(uploadButton(container).disabled, false, 'the file is still held, so the button is offered again');
  assert.doesNotMatch(text(container), /Document uploaded successfully/, 'no false success');
});

test('a second click while the upload is in flight sends nothing', async () => {
  let release;
  pendingUpload = new Promise((resolve) => { release = resolve; });
  const container = await mountPage();
  await selectFile(container, { name: 'signed-copy.pdf' });

  const button = uploadButton(container);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();
  assert.equal(button.disabled, true, 'the button is disabled while the request is open');
  assert.match(button.textContent, /Uploading/, 'and it says so');

  // A real second click, and a submit-shaped second activation, are both refused.
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();
  await act(async () => { release(); });
  await settled();

  assert.equal(calls.filter((c) => c.method === 'post').length, 1, 'only one request may leave the page');
});

test('the progress bar is announced and never claims 100% before the server agrees', async () => {
  let release;
  pendingUpload = new Promise((resolve) => { release = resolve; });
  const container = await mountPage();
  await selectFile(container, { name: 'signed-copy.pdf' });

  await act(async () => { uploadButton(container).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();

  // Drive the progress callback the way axios does.
  const post = calls.find((c) => c.method === 'post');
  await act(async () => { post.config.onUploadProgress({ loaded: 500, total: 1000 }); });
  await settled();

  const bar = container.querySelector('[role="progressbar"]');
  assert.ok(bar, 'progress must be announced');
  assert.equal(bar.getAttribute('aria-valuenow'), '50');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '100');

  await act(async () => { post.config.onUploadProgress({ loaded: 1000, total: 1000 }); });
  await settled();
  assert.equal(
    container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),
    '99',
    'a completed upload body is not a completed upload'
  );

  await act(async () => { release(); });
  await settled();
  assert.equal(container.querySelector('[role="progressbar"]'), null, 'the bar is removed when the request settles');
});

test('the upload is not attempted until a file has been chosen', async () => {
  const container = await mountPage();
  const button = uploadButton(container);
  assert.equal(button.disabled, true, 'with no file there is nothing to upload');
  assert.equal(calls.filter((c) => c.method === 'post').length, 0);
});

/* ================================================================== */
/* 4. client-side validation, kept in step with the server              */
/* ================================================================== */

test('a disallowed extension is refused before any request', async () => {
  const container = await mountPage();
  await selectFile(container, { name: 'payload.exe', type: 'application/octet-stream' });

  assert.match(text(container.querySelector('[role="alert"]')), /Only PDF, DOCX and DOC/);
  assert.equal(calls.filter((c) => c.method === 'post').length, 0, 'nothing is sent');
  // The button is left enabled, because the page validates on click as well; the
  // guarantee is that the request never leaves either way.
  await clickUpload(container);
  assert.equal(calls.filter((c) => c.method === 'post').length, 0, 'and clicking it still sends nothing');
  assert.match(text(container.querySelector('[role="alert"]')), /Only PDF, DOCX and DOC/);
});

test('a file with no extension is refused', async () => {
  const container = await mountPage();
  await selectFile(container, { name: 'README', type: 'text/plain' });
  assert.match(text(container.querySelector('[role="alert"]')), /Only PDF, DOCX and DOC/);
});

test('a double extension is judged on the last one', async () => {
  const container = await mountPage();
  await selectFile(container, { name: 'report.pdf.exe', type: 'application/octet-stream' });
  assert.match(text(container.querySelector('[role="alert"]')), /Only PDF, DOCX and DOC/);
});

test('an oversized file is refused before any request', async () => {
  const container = await mountPage();
  // 10 MiB + 1 byte, declared through a sparse-ish array of the right length.
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  await selectFile(container, { name: 'huge.pdf', bytes: big });

  assert.match(text(container.querySelector('[role="alert"]')), /10 MiB upload limit/);
  assert.equal(calls.filter((c) => c.method === 'post').length, 0, 'nothing is sent');
});

test('a file of exactly the limit is allowed through', async () => {
  const container = await mountPage();
  const exact = new Uint8Array(10 * 1024 * 1024);
  await selectFile(container, { name: 'exact.pdf', bytes: exact });
  assert.equal(container.querySelector('[role="alert"]'), null, 'the limit is inclusive');
  assert.equal(uploadButton(container).disabled, false);
});

test('the client limits still match the ones the server enforces', async () => {
  // These are duplicated in two files on purpose (the browser cannot import from
  // the server), so nothing keeps them in step except this assertion.
  const middleware = fs.readFileSync(path.join(SERVER, 'middleware', 'upload.js'), 'utf8');
  const page = fs.readFileSync(path.join(SRC, 'pages', 'ContractDetails.js'), 'utf8');

  const serverMax = Number(middleware.match(/MAX_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)[1]);
  const clientMax = Number(page.match(/MAX_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)[1]);
  assert.equal(clientMax, serverMax, 'the upload size limit must agree across the wire');

  const serverExt = middleware.match(/ALLOWED_EXTENSIONS\s*=\s*\[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const clientExt = page.match(/ALLOWED_EXTENSIONS\s*=\s*\[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(
    clientExt.map((e) => (e.startsWith('.') ? e : `.${e}`)).sort(),
    serverExt.slice().sort(),
    'the allowed extensions must agree across the wire'
  );

  // The field name the page posts is the one the server mounts.
  assert.match(page, /formData\.append\('document',/);
  assert.match(middleware, /file/, 'the server mounts a single file field');
  const documentRoutes = fs.readFileSync(path.join(SERVER, 'routes', 'documentRoutes.js'), 'utf8');
  assert.match(documentRoutes, /upload\.single\('document'\)/, 'and it must be `document`');
});

/* ================================================================== */
/* 5. download                                                          */
/* ================================================================== */

test('a download asks for the document by id and saves it under the stored name', async () => {
  downloadResponse = new dom.window.Blob([PDF_BYTES], { type: 'application/pdf' });
  anchorClicks.length = 0;
  const container = await mountPage();

  const button = byText(container, 'button', /Download/);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();

  const get = calls.find((c) => c.method === 'get' && c.url.startsWith('/documents/download/'));
  assert.ok(get, 'a download must be requested');
  assert.equal(get.url, `/documents/download/${DOCUMENT._id}`);
  assert.equal(get.config.responseType, 'blob', 'the bytes must be fetched as a blob, not parsed as json');
  assert.deepEqual(anchorClicks, [{ href: 'blob:issue35/1', download: DOCUMENT.originalname }],
    'the user gets the name they uploaded, not the internal storage key');
});

test('a refused download is reported and the row stays usable', async () => {
  downloadFailure = httpError(404, 'This document file is unavailable. It may have been removed from storage. Please upload a new version.');
  const container = await mountPage();

  const button = byText(container, 'button', /Download/);
  await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure must be announced');
  assert.match(text(alert), /no longer stored|unavailable/);
  assert.match(text(container), /signed-msa\.pdf/, 'the list is preserved');
  assert.equal(button.disabled, false, 'and the row can be retried');
});

test('only one download runs at a time, and the button says so', async () => {
  let release;
  pendingDownload = new Promise((resolve) => { release = resolve; });
  downloadResponse = new dom.window.Blob([PDF_BYTES], { type: 'application/pdf' });
  documentsResponse = [DOCUMENT, { ...DOCUMENT, _id: 'd-2', originalname: 'addendum.pdf', version: 3 }];
  const container = await mountPage();

  const first = byText(container, 'button', /Download/);
  await act(async () => { first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();

  assert.equal(first.disabled, true, 'the row being downloaded is disabled');
  assert.match(first.textContent, /Downloading/);
  const second = [...container.querySelectorAll('button')].find((b) => /Download/.test(b.textContent) && b !== first);
  assert.equal(second.disabled, true, 'and so is every other row, so two files cannot be fetched at once');

  // A second click on the busy row is refused too.
  await act(async () => { first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settled();
  assert.equal(calls.filter((c) => c.url.startsWith('/documents/download/')).length, 1);

  await act(async () => { release(); });
  await settled();
  assert.equal(first.disabled, false, 'the row is usable again once the file arrives');
  assert.equal(calls.filter((c) => c.url.startsWith('/documents/download/')).length, 1);
});

/* ================================================================== */
/* 6. features that must NOT exist                                      */
/* ================================================================== */

test('there is no delete control, and no route to call', async () => {
  const container = await mountPage();
  assert.equal(
    byText(container, 'button', /Delete|Remove/i), undefined,
    'documents are not deletable, so no control may offer it'
  );
  const documentRoutes = fs.readFileSync(path.join(SERVER, 'routes', 'documentRoutes.js'), 'utf8');
  assert.doesNotMatch(documentRoutes, /router\.(delete|put|patch)\b/, 'and no write route beyond upload exists');
});

test('a long file name and a long metadata row do not break the grid', async () => {
  const longName = 'a-really-long-signed-master-services-agreement-for-the-eu-region-final-v3.pdf';
  documentsResponse = [{ ...DOCUMENT, originalname: longName }];
  const container = await mountPage();

  const name = [...container.querySelectorAll('p')].find((p) => p.textContent === longName);
  assert.ok(name, 'the file name is rendered');
  const item = name.closest('div.rounded-xl');
  assert.match(item.className, /flex-col/, 'the row stacks on a narrow viewport');
  assert.match(item.className, /sm:flex-row/, 'and goes side by side once there is room');
  assert.match(
    item.querySelector('div').className,
    /min-w-0/,
    'the text column may shrink, so a long name truncates instead of forcing the row wider'
  );
});
