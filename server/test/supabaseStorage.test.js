// Unit tests for the Supabase Storage adapter. The Supabase Storage REST API is
// mocked at the fetch boundary, so URL building, auth headers, status mapping
// and the legacy local fallback are all exercised without any network access,
// credentials or real bucket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const SupabaseStorageAdapter = require('../services/storage/supabaseStorage');
const { setStorageAdapter, resetStorageAdapter, getStorageAdapter } = require('../services/storage');
const { createMockStorage, MockSupabaseClient } = require('./helpers/mockStorage');

const SECRET = 'mock-supabase-secret-key';
const PROJECT_URL = 'https://mock-project.supabase.co';
const BUCKET = 'contract-documents';

const validEnv = (overrides = {}) => ({
  SUPABASE_URL: PROJECT_URL,
  SUPABASE_SECRET_KEY: SECRET,
  SUPABASE_BUCKET_NAME: BUCKET,
  ...overrides
});

const adapterWith = (overrides = {}, fetchImpl) => new SupabaseStorageAdapter({
  env: validEnv(overrides),
  fetchImpl,
  uploadDirectory: path.join(os.tmpdir(), 'ricoz-supabase-adapter-tests')
});

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const jsonError = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
});

test.after(() => {
  resetStorageAdapter();
});

test('the adapter reports the supabase backend and generates dated object keys', () => {
  const adapter = adapterWith();
  assert.equal(adapter.backend, 'supabase');
  assert.equal(SupabaseStorageAdapter.SUPABASE_BACKEND, 'supabase');

  const key = adapter.createObjectKey('.pdf');
  assert.match(key, /^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
  assert.notEqual(key, adapter.createObjectKey('.pdf'), 'each key is unique');
  assert.match(adapter.createObjectKey('DOCX'), /\.docx$/, 'extensions are normalised');
});

test('isConfigured reports whether every required variable is present', () => {
  assert.equal(adapterWith().isConfigured(), true);
  assert.equal(adapterWith({ SUPABASE_URL: '' }).isConfigured(), false);
  assert.equal(adapterWith({ SUPABASE_SECRET_KEY: '   ' }).isConfigured(), false);
  assert.equal(adapterWith({ SUPABASE_BUCKET_NAME: undefined }).isConfigured(), false);
});

test('configuration errors name the missing variables without leaking values', () => {
  const adapter = adapterWith({ SUPABASE_SECRET_KEY: '', SUPABASE_BUCKET_NAME: '' });
  assert.throws(() => adapter.getConfig(), (error) => {
    assert.equal(error.code, 'STORAGE_NOT_CONFIGURED');
    assert.equal(error.status, 503);
    assert.match(error.message, /SUPABASE_SECRET_KEY/);
    assert.match(error.message, /SUPABASE_BUCKET_NAME/);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
});

test('SUPABASE_URL must be a valid https project URL', () => {
  assert.throws(() => adapterWith({ SUPABASE_URL: 'not-a-url' }).getConfig(),
    (error) => error.code === 'STORAGE_NOT_CONFIGURED' && /SUPABASE_URL/.test(error.message));
  assert.throws(() => adapterWith({ SUPABASE_URL: 'http://example.supabase.co' }).getConfig(),
    (error) => /https/.test(error.message));
  assert.doesNotThrow(() => adapterWith({ SUPABASE_URL: 'http://localhost:54321' }).getConfig(),
    'a loopback http URL is allowed for a local Supabase stack');
  assert.equal(adapterWith({ SUPABASE_URL: `${PROJECT_URL}/` }).getConfig().baseUrl, PROJECT_URL,
    'a trailing slash is trimmed so paths are not doubled');
});

test('the publishable/anon key is refused because it cannot reach a private bucket', () => {
  const anonJwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url'),
    'signature'
  ].join('.');

  for (const key of ['sb_publishable_abcdefghijklmnop', anonJwt]) {
    assert.throws(() => adapterWith({ SUPABASE_SECRET_KEY: key }).getConfig(), (error) => {
      assert.equal(error.code, 'STORAGE_NOT_CONFIGURED');
      assert.match(error.message, /secret key/);
      return true;
    });
  }
  assert.doesNotThrow(() => adapterWith({ SUPABASE_SECRET_KEY: 'sb_secret_abcdefghijklmnop' }).getConfig());
});

test('an invalid bucket name is refused', () => {
  for (const bucket of ['Contract Documents', 'a', 'buck/et', '-leading', 'x'.repeat(80)]) {
    assert.throws(() => adapterWith({ SUPABASE_BUCKET_NAME: bucket }).getConfig(),
      (error) => error.code === 'STORAGE_NOT_CONFIGURED' && /SUPABASE_BUCKET_NAME/.test(error.message));
  }
});

test('upload posts the object to the private bucket with server-side credentials', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    const body = Buffer.from('%PDF-1.4\n%%EOF');
    const result = await storage.adapter.upload({
      key,
      body,
      contentType: 'application/pdf',
      checksum: 'a'.repeat(64),
      filename: 'blueprint.pdf'
    });

    assert.equal(result.key, key);
    assert.ok(result.id, 'the provider object id is returned to the caller');

    const request = storage.client.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/storage/v1/object/${BUCKET}/${key}`);
    assert.equal(request.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(request.headers.apikey, SECRET);
    assert.equal(request.headers['Content-Type'], 'application/pdf');
    assert.equal(request.headers['x-upsert'], 'false', 'an existing object is never overwritten');
    assert.equal(storage.client.objects.get(key).body.equals(body), true);
  } finally {
    storage.cleanup();
  }
});

test('provider failures during upload are mapped without echoing the object key', async () => {
  const scenarios = [
    ['unauthorized', () => jsonError(401, { statusCode: '401', error: 'no_permissions', message: 'Invalid claim' }), 'STORAGE_NOT_CONFIGURED', 503],
    ['conflict', () => jsonError(409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }), 'STORAGE_CONFLICT', 409],
    ['payload too large', () => jsonError(413, { statusCode: '413', error: 'Payload too large' }), 'STORAGE_TOO_LARGE', 413],
    ['bad request', () => jsonError(400, { statusCode: '400', error: 'InvalidRequest' }), 'STORAGE_REJECTED', 502],
    ['server error', () => jsonError(503, { statusCode: '503', error: 'service_unavailable' }), 'STORAGE_UNAVAILABLE', 503]
  ];

  for (const [label, respond, code, status] of scenarios) {
    const key = 'documents/2026/09/secretive-key.pdf';
    const adapter = adapterWith({}, async () => respond());
    await assert.rejects(
      adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' }),
      (error) => {
        assert.equal(error.code, code, label);
        assert.equal(error.status, status, label);
        assert.equal(error.message.includes(key), false, `${label}: the object key must not leak`);
        assert.equal(error.message.includes(SECRET), false, `${label}: the secret key must not leak`);
        assert.equal(error.message.includes(PROJECT_URL), false, `${label}: the project URL must not leak`);
        return true;
      }
    );
  }
});

test('a network failure is reported as a temporary storage outage', async () => {
  const adapter = adapterWith({}, async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(
    adapter.upload({ key: 'documents/2026/09/a.pdf', body: Buffer.from('data') }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503
  );
});

test('upload rejects a missing key or a non-buffer body before any request', async () => {
  const adapter = adapterWith({}, async () => { throw new Error('should not be called'); });
  await assert.rejects(adapter.upload({ body: Buffer.from('x') }),
    (error) => error.code === 'STORAGE_INVALID_UPLOAD' && error.status === 400);
  await assert.rejects(adapter.upload({ key: 'documents/a.pdf', body: 'not a buffer' }),
    (error) => error.code === 'STORAGE_INVALID_UPLOAD');
});

test('object keys are validated so a stored reference cannot escape the bucket path', async () => {
  const storage = createMockStorage();
  try {
    const adapter = storage.adapter;
    for (const key of ['../secrets.pdf', 'documents/../../etc/passwd', '/absolute.pdf', 'documents//a.pdf', '   ']) {
      await assert.rejects(
        adapter.download({ backend: 'supabase', key }),
        (error) => error.code === 'STORAGE_INVALID_REFERENCE' && error.status === 400,
        `key ${JSON.stringify(key)} must be refused`
      );
    }
    await assert.rejects(
      adapter.download({ backend: 'supabase', key: null }),
      (error) => error.code === 'STORAGE_INVALID_REFERENCE'
    );
  } finally {
    storage.cleanup();
  }
});

test('download streams the object and reports its size and type', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    const body = Buffer.from('%PDF-1.4\nstreamed %%EOF');
    await storage.adapter.upload({ key, body, contentType: 'application/pdf' });

    const object = await storage.adapter.download({ backend: 'supabase', key });
    assert.equal(object.contentLength, body.length);
    assert.equal(object.contentType, 'application/pdf');
    assert.equal((await readAll(object.body)).equals(body), true, 'the whole object is streamed back');

    const request = storage.client.requests.at(-1);
    assert.equal(request.method, 'GET');
    assert.equal(request.path, `/storage/v1/object/${BUCKET}/${key}`);
    assert.equal(request.headers.Authorization, `Bearer ${SECRET}`);
  } finally {
    storage.cleanup();
  }
});

test('a missing object is a 404 and an outage is a 503, with no key in the message', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    await storage.adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' });
    storage.client.objects.delete(key);

    await assert.rejects(
      storage.adapter.download({ backend: 'supabase', key }),
      (error) => {
        assert.equal(error.code, 'STORAGE_NOT_FOUND');
        assert.equal(error.status, 404);
        assert.equal(error.message.includes(key), false);
        return true;
      }
    );

    storage.client.failDownloads = true;
    await assert.rejects(
      storage.adapter.download({ backend: 'supabase', key }),
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503
    );
  } finally {
    storage.cleanup();
  }
});

test('exists() checks object metadata and distinguishes missing from unavailable', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    assert.equal(await storage.adapter.exists({ backend: 'supabase', key }), false);

    await storage.adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' });
    assert.equal(await storage.adapter.exists({ backend: 'supabase', key }), true);
    assert.equal(
      storage.client.requests.at(-1).path,
      `/storage/v1/object/info/${BUCKET}/${key}`,
      'existence is checked through the metadata endpoint'
    );

    storage.client.failExists = true;
    await assert.rejects(
      storage.adapter.exists({ backend: 'supabase', key }),
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503,
      'an outage must not be reported as "the object does not exist"'
    );
  } finally {
    storage.cleanup();
  }
});

test('exists() returns false without credentials when no key is stored', async () => {
  const adapter = new SupabaseStorageAdapter({ env: {}, fetchImpl: async () => { throw new Error('no request expected'); } });
  assert.equal(await adapter.exists({ backend: 'supabase', key: null }), false);
  assert.equal(await adapter.exists({ backend: 'r2', key: 'documents/2026/09/a.pdf' }), false);
  assert.equal(await adapter.exists({}), false);
});

test('delete removes the object and is idempotent', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    await storage.adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' });

    assert.equal(await storage.adapter.delete({ backend: 'supabase', key }, { authorizedBy: 'user-1' }), true);
    assert.equal(storage.client.objects.has(key), false);
    assert.equal(await storage.adapter.delete({ backend: 'supabase', key }, { authorizedBy: 'user-1' }), true,
      'cleaning up an already removed object still succeeds');

    const request = storage.client.requests.at(-2);
    assert.equal(request.method, 'DELETE');
    assert.equal(request.path, `/storage/v1/object/${BUCKET}`);
  } finally {
    storage.cleanup();
  }
});

test('delete refuses unauthorised, legacy and retired-backend requests', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    await storage.adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' });

    await assert.rejects(
      storage.adapter.delete({ backend: 'supabase', key }),
      (error) => error.code === 'STORAGE_FORBIDDEN' && error.status === 403
    );
    await assert.rejects(
      storage.adapter.delete({ backend: 'supabase', key: null }, { authorizedBy: 'user-1' }),
      (error) => error.code === 'STORAGE_FORBIDDEN'
    );
    await assert.rejects(
      storage.adapter.delete({ backend: 'local' }, { authorizedBy: 'user-1' }),
      (error) => error.code === 'STORAGE_FORBIDDEN' && /read-only/.test(error.message)
    );
    await assert.rejects(
      storage.adapter.delete({ backend: 'r2', key }, { authorizedBy: 'user-1' }),
      (error) => error.code === 'STORAGE_FORBIDDEN' && /retired/.test(error.message)
    );

    assert.equal(storage.client.objects.has(key), true, 'no object is removed by a refused request');
  } finally {
    storage.cleanup();
  }
});

test('a delete outage is reported without removing the object silently', async () => {
  const storage = createMockStorage();
  try {
    const key = storage.adapter.createObjectKey('.pdf');
    await storage.adapter.upload({ key, body: Buffer.from('data'), contentType: 'application/pdf' });
    storage.client.failDeletes = true;

    await assert.rejects(
      storage.adapter.delete({ backend: 'supabase', key }, { authorizedBy: 'user-1' }),
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503
    );
  } finally {
    storage.cleanup();
  }
});

test('the retired R2 backend is refused with a recoverable message', async () => {
  const storage = createMockStorage();
  try {
    await assert.rejects(
      storage.adapter.download({ backend: 'r2', key: 'documents/2026/09/old.pdf' }),
      (error) => {
        assert.equal(error.code, 'STORAGE_FORBIDDEN');
        assert.equal(error.status, 403);
        assert.match(error.message, /upload a new version/i);
        return true;
      }
    );
    await assert.rejects(
      storage.adapter.download({ backend: 'unknown-backend', key: 'documents/2026/09/old.pdf' }),
      (error) => error.code === 'STORAGE_INVALID_REFERENCE' && error.status === 400
    );
  } finally {
    storage.cleanup();
  }
});

test('the legacy local fallback still serves files from the upload directory', async () => {
  const storage = createMockStorage();
  try {
    const legacy = path.join(storage.uploadDirectory, 'legacy.pdf');
    const legacyBody = Buffer.from('%PDF-1.4 legacy %%EOF');
    fs.writeFileSync(legacy, legacyBody);

    const object = await storage.adapter.download({ backend: 'local', filePath: legacy });
    assert.equal(object.contentLength, legacyBody.length);
    assert.equal((await readAll(object.body)).equals(legacyBody), true);
    assert.equal(await storage.adapter.exists({ backend: 'local', filePath: legacy }), true);

    // A document with no backend but a stored path is treated as legacy.
    assert.equal(await storage.adapter.exists({ filePath: legacy }), true);
  } finally {
    storage.cleanup();
  }
});

test('the legacy fallback refuses paths outside the upload directory', async () => {
  const storage = createMockStorage();
  try {
    for (const filePath of ['../../../../etc/passwd', '/app/uploads/1758-deadbeef.pdf', '   ', null]) {
      assert.equal(await storage.adapter.exists({ backend: 'local', filePath }), false);
    }
    assert.equal(await storage.adapter.exists({ backend: 'local', filePath: storage.uploadDirectory }), false,
      'a directory is not a document');
    await assert.rejects(
      storage.adapter.download({ backend: 'local', filePath: '../../../../etc/passwd' }),
      (error) => error.code === 'STORAGE_FORBIDDEN' && /upload a new version/i.test(error.message)
    );
  } finally {
    storage.cleanup();
  }
});

test('the storage registry requires a full adapter contract including a backend name', () => {
  const storage = createMockStorage();
  try {
    assert.equal(getStorageAdapter().backend, 'supabase', 'Supabase is the default adapter');

    assert.throws(() => setStorageAdapter(null), TypeError);
    assert.throws(() => setStorageAdapter({}), TypeError);
    assert.throws(() => setStorageAdapter({
      createObjectKey() {}, upload() {}, download() {}, exists() {}, delete() {}
    }), (error) => error instanceof TypeError && /backend/.test(error.message));

    const replacement = {
      backend: 'supabase',
      custom: true,
      createObjectKey: () => 'documents/replacement.pdf',
      upload: async () => ({ key: 'documents/replacement.pdf' }),
      download: async () => ({ body: Readable.from(Buffer.from('x')), contentLength: 1, contentType: 'application/pdf', checksum: null }),
      exists: async () => true,
      delete: async () => true
    };
    assert.equal(setStorageAdapter(replacement), replacement);
    assert.equal(getStorageAdapter().custom, true);
  } finally {
    resetStorageAdapter();
    storage.cleanup();
    assert.equal(getStorageAdapter().backend, 'supabase');
  }
});

test('the mock speaks the same status codes as the real Supabase Storage API', async () => {
  const client = new MockSupabaseClient();
  const authed = { headers: { Authorization: `Bearer ${SECRET}`, apikey: SECRET } };

  const missing = await client.fetch(`${PROJECT_URL}/storage/v1/object/${BUCKET}/documents/a.pdf`, { method: 'GET', ...authed });
  // The real API answers a missing download with 400 and a 404 statusCode, which
  // is why the adapter treats both shapes as "not found".
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).statusCode, '404');

  const unauthorised = await client.fetch(`${PROJECT_URL}/storage/v1/object/${BUCKET}/documents/a.pdf`, { method: 'GET' });
  assert.equal(unauthorised.status, 401, 'a request without credentials is rejected');
});

// A permanent bucket misconfiguration is indistinguishable from an outage if it
// is reported as "temporarily unavailable": both arrive as a 5xx, so an operator
// retries a settings problem indefinitely. These tests pin the distinction.
const PERMANENT_CASES = [
  {
    label: 'invalid_mime_type reported with a 400 status and a 415 statusCode',
    respond: () => jsonError(400, {
      statusCode: '415',
      error: 'invalid_mime_type',
      code: 'InvalidMimeType',
      message: 'mime type application/pdf is not supported'
    }),
    expect: /allowed MIME types/i
  },
  {
    label: 'invalid_mime_type reported with an HTTP 415',
    respond: () => jsonError(415, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type image/png is not supported' }),
    expect: /allowed MIME types/i
  },
  {
    label: 'a missing bucket',
    respond: () => jsonError(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }),
    expect: /SUPABASE_BUCKET_NAME/
  },
  {
    label: 'an unrecognised 4xx rejection',
    respond: () => jsonError(400, { statusCode: '400', error: 'InvalidRequest', message: 'Invalid request' }),
    expect: /permanently rejected/i
  },
  {
    label: 'a 422 validation rejection',
    respond: () => jsonError(422, { statusCode: '422', error: 'InvalidArgument', message: 'Invalid argument' }),
    expect: /permanently rejected/i
  }
];

const TEMPORARY_CASES = [
  { label: 'HTTP 500', respond: () => jsonError(500, { statusCode: '500', error: 'Internal' }) },
  { label: 'HTTP 502', respond: () => jsonError(502, { statusCode: '502', error: 'Bad gateway' }) },
  { label: 'HTTP 503', respond: () => jsonError(503, { statusCode: '503', error: 'service_unavailable' }) },
  { label: 'HTTP 504 gateway timeout', respond: () => jsonError(504, { statusCode: '504', error: 'Gateway timeout' }) },
  // Rate limiting and request timeouts arrive as 4xx but are worth retrying.
  { label: 'HTTP 429 rate limited', respond: () => jsonError(429, { statusCode: '429', error: 'too_many_requests' }) },
  { label: 'HTTP 408 request timeout', respond: () => jsonError(408, { statusCode: '408', error: 'Request timeout' }) },
  { label: 'a dropped connection', respond: () => { throw new Error('ECONNRESET'); } }
];

const assertNoProviderLeak = (message, key) => {
  assert.equal(message.includes(key), false, 'the object key must not leak');
  assert.equal(message.includes(SECRET), false, 'the secret key must not leak');
  assert.equal(message.includes(PROJECT_URL), false, 'the project URL must not leak');
  assert.equal(message.includes(BUCKET), false, 'the bucket name must not leak');
};

for (const { label, respond, expect } of PERMANENT_CASES) {
  test(`a permanent provider failure is not reported as a retryable outage (${label})`, async () => {
    const key = 'documents/2026/09/permanent-failure.pdf';
    const adapter = adapterWith({}, async () => respond());
    await assert.rejects(
      adapter.upload({ key, body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }),
      (error) => {
        assert.equal(error.code, 'STORAGE_REJECTED', label);
        assert.equal(error.status, 502, label);
        assert.equal(error.retryable, false, `${label}: must not be marked retryable`);
        assert.match(error.message, expect, label);
        assert.doesNotMatch(error.message, /try again|temporarily/i, `${label}: must not suggest a retry`);
        assertNoProviderLeak(error.message, key);
        return true;
      }
    );
  });
}

for (const { label, respond } of TEMPORARY_CASES) {
  test(`a temporary provider failure stays a retryable outage (${label})`, async () => {
    const key = 'documents/2026/09/temporary-failure.pdf';
    const adapter = adapterWith({}, async () => respond());
    await assert.rejects(
      adapter.upload({ key, body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }),
      (error) => {
        assert.equal(error.code, 'STORAGE_UNAVAILABLE', label);
        assert.equal(error.status, 503, label);
        assert.equal(error.retryable, true, `${label}: must be marked retryable`);
        assert.match(error.message, /temporarily unavailable/i, label);
        assertNoProviderLeak(error.message, key);
        return true;
      }
    );
  });
}

test('permanent provider failures are classified the same way on every operation', async () => {
  const key = 'documents/2026/09/shared-classification.pdf';
  const invalidMime = () => jsonError(400, {
    statusCode: '415',
    error: 'invalid_mime_type',
    code: 'InvalidMimeType',
    message: 'mime type application/pdf is not supported'
  });
  const operations = {
    upload: (adapter) => adapter.upload({ key, body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }),
    download: (adapter) => adapter.download({ backend: 'supabase', key }),
    exists: (adapter) => adapter.exists({ backend: 'supabase', key }),
    delete: (adapter) => adapter.delete({ backend: 'supabase', key }, { authorizedBy: 'regression-test' })
  };

  for (const [name, run] of Object.entries(operations)) {
    const adapter = adapterWith({}, async () => invalidMime());
    await assert.rejects(run(adapter), (error) => {
      assert.equal(error.code, 'STORAGE_REJECTED', name);
      assert.equal(error.retryable, false, `${name}: must not be marked retryable`);
      assert.match(error.message, /allowed MIME types/i, name);
      assert.doesNotMatch(error.message, /try again|temporarily/i, `${name}: must not suggest a retry`);
      assertNoProviderLeak(error.message, key);
      return true;
    });
  }
});

test('a missing object and a missing bucket are not confused with each other', async () => {
  const key = 'documents/2026/09/absent.pdf';

  // The real API answers a missing object with HTTP 400 and a 404 statusCode.
  const missingObject = adapterWith({}, async () => jsonError(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }));
  assert.equal(await missingObject.exists({ backend: 'supabase', key }), false, 'exists() reports a missing object as absent');
  await assert.rejects(missingObject.download({ backend: 'supabase', key }),
    (error) => error.code === 'STORAGE_NOT_FOUND' && error.retryable === false);
  assert.equal(await missingObject.delete({ backend: 'supabase', key }, { authorizedBy: 'regression-test' }), true,
    'deleting an absent object is still idempotent');

  // A missing bucket is permanent and must not be mistaken for an absent object.
  const missingBucket = adapterWith({}, async () => jsonError(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }));
  await assert.rejects(missingBucket.exists({ backend: 'supabase', key }),
    (error) => error.code === 'STORAGE_REJECTED' && error.retryable === false && /SUPABASE_BUCKET_NAME/.test(error.message));
});

test('credential rejections stay permanent and actionable', async () => {
  const key = 'documents/2026/09/credentials.pdf';
  for (const [label, respond] of [
    ['HTTP 401', () => jsonError(401, { statusCode: '401', error: 'InvalidJWT', message: 'Invalid claim: missing sub claim' })],
    ['HTTP 403', () => jsonError(403, { statusCode: '403', error: 'no_permissions', message: 'new row violates row-level security policy' })]
  ]) {
    const adapter = adapterWith({}, async () => respond());
    await assert.rejects(adapter.upload({ key, body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }), (error) => {
      assert.equal(error.code, 'STORAGE_NOT_CONFIGURED', label);
      assert.equal(error.retryable, false, `${label}: a rejected key will not fix itself`);
      assert.match(error.message, /SUPABASE_SECRET_KEY/, label);
      assert.doesNotMatch(error.message, /try again|temporarily/i, `${label}: must not suggest a retry`);
      assertNoProviderLeak(error.message, key);
      return true;
    });
  }
});

test('the error classes carry a retryable flag that matches their meaning', () => {
  const {
    StorageError,
    StorageConfigurationError,
    StorageUnavailableError,
    StorageNotFoundError,
    StorageForbiddenError
  } = require('../services/storage/errors');

  assert.equal(new StorageUnavailableError().retryable, true, 'an outage is retryable');
  assert.equal(new StorageConfigurationError().retryable, false, 'a misconfiguration is not');
  assert.equal(new StorageNotFoundError().retryable, false, 'a missing object is not');
  assert.equal(new StorageForbiddenError().retryable, false, 'a forbidden operation is not');
  assert.equal(new StorageError('x', { code: 'STORAGE_REJECTED', status: 502, retryable: false }).retryable, false,
    'an explicit flag wins over the default');
  assert.equal(new StorageError('x').retryable, true, 'the default stays retryable');
});
