const fs = require('fs');
const os = require('os');
const path = require('path');
const SupabaseStorageAdapter = require('../../services/storage/supabaseStorage');

const MOCK_PROJECT_URL = 'https://mock-project.supabase.co';
const MOCK_BUCKET = 'contract-documents';

const jsonResponse = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
});

// Mirrors the shape of the real Supabase Storage REST API so the adapter's URL
// building, auth headers and status mapping are all exercised by the tests.
class MockSupabaseClient {
  constructor({ baseUrl = MOCK_PROJECT_URL, bucket = MOCK_BUCKET } = {}) {
    this.baseUrl = baseUrl;
    this.bucket = bucket;
    this.objects = new Map();
    this.failUploads = false;
    this.failDownloads = false;
    this.failDeletes = false;
    this.failExists = false;
    this.requests = [];
  }

  reset() {
    this.objects.clear();
    this.failUploads = false;
    this.failDownloads = false;
    this.failDeletes = false;
    this.failExists = false;
    this.requests.length = 0;
  }

  get env() {
    return {
      SUPABASE_URL: this.baseUrl,
      SUPABASE_SECRET_KEY: 'mock-supabase-secret-key',
      SUPABASE_BUCKET_NAME: this.bucket
    };
  }

  unauthorized() {
    return jsonResponse(401, { statusCode: '401', error: 'no_permissions', message: 'Invalid claim: missing sub claim' });
  }

  notFound(key) {
    // Supabase reports a missing object as 400/404 depending on the endpoint.
    return jsonResponse(404, { statusCode: '404', error: 'not_found', message: `Object not found: ${key}` });
  }

  serviceUnavailable() {
    return jsonResponse(503, { statusCode: '503', error: 'service_unavailable', message: 'Storage backend is unavailable' });
  }

  async fetch(url, init = {}) {
    const method = init.method || 'GET';
    const parsed = new URL(url);
    this.requests.push({ method, path: parsed.pathname, headers: init.headers || {} });

    const storagePrefix = `/storage/v1/object/${encodeURIComponent(this.bucket)}`;
    const infoPrefix = `/storage/v1/object/info/${encodeURIComponent(this.bucket)}`;
    if (!parsed.pathname.startsWith('/storage/v1/')) {
      return jsonResponse(404, { statusCode: '404', error: 'not_found', message: 'Unknown route' });
    }
    if (!init.headers?.Authorization || !init.headers?.apikey) {
      return this.unauthorized();
    }

    if (method === 'POST' && parsed.pathname.startsWith(`${storagePrefix}/`)) {
      const key = decodeURIComponent(parsed.pathname.slice(storagePrefix.length + 1));
      if (this.failUploads) return this.serviceUnavailable();
      if (this.objects.has(key) && init.headers['x-upsert'] !== 'true') {
        return jsonResponse(409, { statusCode: '409', error: 'Duplicate', message: `The resource already exists: ${key}` });
      }
      const body = Buffer.from(init.body);
      this.objects.set(key, { body, contentType: init.headers['Content-Type'] || 'application/octet-stream' });
      return jsonResponse(200, { Id: `${this.objects.size}-mock-id`, Key: key });
    }

    if (method === 'GET' && parsed.pathname.startsWith(`${infoPrefix}/`)) {
      const key = decodeURIComponent(parsed.pathname.slice(`${infoPrefix}/`.length));
      if (this.failExists) return this.serviceUnavailable();
      const stored = this.objects.get(key);
      if (!stored) return this.notFound(key);
      return jsonResponse(200, { id: 'mock-id', name: key, size: stored.body.length, mimetype: stored.contentType });
    }

    if (method === 'GET' && parsed.pathname.startsWith(`${storagePrefix}/`)) {
      const key = decodeURIComponent(parsed.pathname.slice(storagePrefix.length + 1));
      if (this.failDownloads) return this.serviceUnavailable();
      const stored = this.objects.get(key);
      if (!stored) return jsonResponse(400, { statusCode: '404', error: 'not_found', message: `Object not found: ${key}` });
      return new Response(stored.body, {
        status: 200,
        headers: { 'content-type': stored.contentType, 'content-length': String(stored.body.length) }
      });
    }

    if (method === 'DELETE' && parsed.pathname === storagePrefix) {
      if (this.failDeletes) return this.serviceUnavailable();
      const { prefixes = [] } = JSON.parse(init.body || '{}');
      const removed = prefixes.filter((key) => this.objects.delete(key));
      return jsonResponse(200, removed);
    }

    return jsonResponse(404, { statusCode: '404', error: 'not_found', message: 'Unknown route' });
  }
}

const createMockStorage = (options = {}) => {
  const uploadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ricoz-contract-storage-'));
  const client = new MockSupabaseClient(options);
  const adapter = new SupabaseStorageAdapter({
    env: client.env,
    fetchImpl: (url, init) => client.fetch(url, init),
    uploadDirectory
  });

  return {
    adapter,
    client,
    uploadDirectory,
    secretKey: client.env.SUPABASE_SECRET_KEY,
    projectUrl: client.baseUrl,
    reset: () => client.reset(),
    cleanup: () => fs.rmSync(uploadDirectory, { recursive: true, force: true })
  };
};

module.exports = { createMockStorage, MockSupabaseClient };
