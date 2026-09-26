const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const {
  StorageError,
  StorageConfigurationError,
  StorageUnavailableError,
  StorageNotFoundError,
  StorageForbiddenError
} = require('./errors');

const SUPABASE_BACKEND = 'supabase';
const LOCAL_BACKEND = 'local';
// The R2 backend was replaced by Supabase. The value stays recognised only so
// historical rows remain schema-valid; no object can be read back through it.
const RETIRED_BACKENDS = new Set(['r2']);
const RETIRED_BACKEND_MESSAGE = 'This document was stored by the retired Cloudflare R2 backend, which has been replaced by Supabase Storage. Please upload a new version.';
const DEFAULT_UPLOAD_DIRECTORY = path.resolve(__dirname, '..', '..', 'uploads');
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_BUCKET_NAME'];
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CREDENTIALS_REJECTED_MESSAGE = 'Supabase Storage rejected the configured credentials or bucket. Check SUPABASE_SECRET_KEY and SUPABASE_BUCKET_NAME.';
const LEGACY_UNAVAILABLE_MESSAGE = 'This legacy document is unavailable because its original file is no longer stored on this server. Please upload a new version.';
const PERMANENT_REJECTED_MESSAGE = 'The storage provider permanently rejected this request. Check the bucket configuration in Supabase.';
const MIME_REJECTED_MESSAGE = "The storage bucket does not accept this file type. Add it to the bucket's allowed MIME types in Supabase.";
const BUCKET_MISSING_MESSAGE = 'The configured storage bucket does not exist. Check SUPABASE_BUCKET_NAME in the server environment.';
// 408 and 429 arrive as 4xx but are genuinely worth retrying, so they are
// classified as temporary before the general 4xx rule is applied.
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

// Messages returned to the client are fixed strings on purpose: Supabase error
// bodies echo the object key back, and storage paths must never reach a client.
const isNotFoundResponse = (status, payload) => (
  status === 404
  || payload?.statusCode === '404'
  || payload?.error === 'not_found'
  || payload?.statusCode === '400' && /not\s*found/i.test(payload?.message || '')
);

const isCredentialRejection = (status, payload) => (
  status === 401
  || status === 403
  || payload?.statusCode === '401'
  || payload?.statusCode === '403'
);

// Supabase reports the machine-readable reason in a different field per error,
// and sometimes only in the message, so all of them are folded into one string
// to match against. It is used for classification only and never returned.
const providerSignal = (payload) => [payload?.code, payload?.error, payload?.statusCode, payload?.message]
  .filter((part) => typeof part === 'string' && part)
  .join(' ')
  .toLowerCase();

// A provider 4xx means this request is unacceptable and will stay unacceptable
// until the bucket policy, credentials or request shape is corrected. Retrying
// cannot help, so these must never be reported as a temporary outage.
const PERMANENT_PROVIDER_FAILURES = [
  {
    test: (signal) => /invalid[_-]?mime[_-]?type/.test(signal) || /mime type .*is not supported/.test(signal),
    message: MIME_REJECTED_MESSAGE
  },
  {
    test: (signal) => /bucket[_-]?not[_-]?found/.test(signal) || /bucket not found/.test(signal) || /bucket_not_found/.test(signal),
    message: BUCKET_MISSING_MESSAGE
  },
  {
    test: (signal) => /invalid[_-]?jwt/.test(signal) || /invalid[_-]?signature/.test(signal) || /jwt[_-]?expired/.test(signal),
    message: CREDENTIALS_REJECTED_MESSAGE
  }
];

const classifyProviderFailure = (status, payload) => {
  if (isCredentialRejection(status, payload)) return { kind: 'credential' };
  // Bucket-level conditions are resolved before "not found": a missing or
  // misconfigured bucket also answers 404, and reporting that as a missing
  // object would make every stored document look deleted.
  if (status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)) {
    const signal = providerSignal(payload);
    const known = PERMANENT_PROVIDER_FAILURES.find((failure) => failure.test(signal));
    if (known) return { kind: 'permanent', message: known.message };
  }
  if (isNotFoundResponse(status, payload)) return { kind: 'notFound' };
  if (status === 409) return { kind: 'conflict' };
  if (status === 413) return { kind: 'tooLarge' };
  if (RETRYABLE_CLIENT_STATUSES.has(status)) return { kind: 'temporary' };
  if (status >= 400 && status < 500) return { kind: 'permanent' };
  return { kind: 'temporary' };
};

// Single place where a classified provider failure becomes a client-safe error.
// Permanent failures keep the existing 502/STORAGE_REJECTED contract so the
// public API does not change, but are marked non-retryable and never suggest
// trying again.
const throwProviderFailure = (failure) => {
  switch (failure.kind) {
    case 'notFound':
      throw new StorageNotFoundError();
    case 'credential':
      throw new StorageConfigurationError(CREDENTIALS_REJECTED_MESSAGE);
    case 'conflict':
      throw new StorageError('A document with this storage key already exists', { code: 'STORAGE_CONFLICT', status: 409, retryable: false });
    case 'tooLarge':
      throw new StorageError('The file is larger than the storage provider accepts', { code: 'STORAGE_TOO_LARGE', status: 413, retryable: false });
    case 'permanent':
      throw new StorageError(failure.message || PERMANENT_REJECTED_MESSAGE, { code: 'STORAGE_REJECTED', status: 502, retryable: false });
    default:
      throw new StorageUnavailableError();
  }
};

const isMissingFileError = (error) => error?.code === 'ENOENT' || error?.name === 'NotFound';

const isWithinDirectory = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Object keys are generated by this adapter, but they are also read back from
// the database, so they are validated and encoded per segment before use.
const encodeObjectKey = (key) => {
  if (typeof key !== 'string' || !key.trim()) {
    throw new StorageError('The document storage reference is invalid', { code: 'STORAGE_INVALID_REFERENCE', status: 400, retryable: false });
  }
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new StorageError('The document storage reference is invalid', { code: 'STORAGE_INVALID_REFERENCE', status: 400, retryable: false });
  }
  return segments.map(encodeURIComponent).join('/');
};

// The anon/publishable key is public by design, so accepting it would produce a
// bucket that appears configured but silently rejects every private operation.
const readJwtRole = (key) => {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.role ?? null;
  } catch {
    return null;
  }
};

class SupabaseStorageAdapter {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, uploadDirectory = DEFAULT_UPLOAD_DIRECTORY } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.uploadDirectory = path.resolve(uploadDirectory);
  }

  get backend() {
    return SUPABASE_BACKEND;
  }

  isConfigured() {
    return REQUIRED_ENV.every((name) => Boolean(this.env[name] && String(this.env[name]).trim()));
  }

  getConfig() {
    const missing = REQUIRED_ENV.filter((name) => !this.env[name] || !String(this.env[name]).trim());
    if (missing.length) {
      throw new StorageConfigurationError(`Document storage is not configured (${missing.join(', ')})`);
    }

    const baseUrl = String(this.env.SUPABASE_URL).trim().replace(/\/+$/, '');
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new StorageConfigurationError('SUPABASE_URL is not a valid Supabase project URL');
    }
    const isLoopback = LOCAL_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      throw new StorageConfigurationError('SUPABASE_URL must use https');
    }

    const secretKey = String(this.env.SUPABASE_SECRET_KEY).trim();
    if (secretKey.startsWith('sb_publishable_') || readJwtRole(secretKey) === 'anon') {
      throw new StorageConfigurationError('SUPABASE_SECRET_KEY must be the secret key, not the publishable or anon key');
    }

    const bucket = String(this.env.SUPABASE_BUCKET_NAME).trim();
    if (!BUCKET_NAME_PATTERN.test(bucket)) {
      throw new StorageConfigurationError('SUPABASE_BUCKET_NAME is not a valid bucket name');
    }

    return { baseUrl, bucket, secretKey };
  }

  createObjectKey(extension) {
    const normalizedExtension = String(extension || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    const suffix = normalizedExtension.startsWith('.') ? normalizedExtension : `.${normalizedExtension}`;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `documents/${year}/${month}/${crypto.randomUUID()}${suffix}`;
  }

  // The secret key authenticates the server to a private bucket. It is only
  // ever attached to the outbound request and never logged or returned.
  buildHeaders(config, extra = {}) {
    return {
      apikey: config.secretKey,
      Authorization: `Bearer ${config.secretKey}`,
      ...extra
    };
  }

  async send(config, path_, init) {
    try {
      return await this.fetchImpl(`${config.baseUrl}/storage/v1${path_}`, init);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageUnavailableError(undefined, error);
    }
  }

  static async readErrorPayload(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async upload({ key, body, contentType, checksum, filename } = {}) {
    const config = this.getConfig();
    if (!key || !Buffer.isBuffer(body)) {
      throw new StorageError('Storage upload requires an object key and file content', { code: 'STORAGE_INVALID_UPLOAD', status: 400, retryable: false });
    }
    // checksum/filename are recorded on the document row; Supabase's REST API
    // accepts no custom object metadata, so MongoDB stays the source of truth.
    void checksum;
    void filename;

    const objectPath = encodeObjectKey(key);
    const response = await this.send(config, `/object/${encodeURIComponent(config.bucket)}/${objectPath}`, {
      method: 'POST',
      headers: this.buildHeaders(config, { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' }),
      body
    });

    if (response.ok) {
      const payload = await SupabaseStorageAdapter.readErrorPayload(response);
      return { key, id: payload?.Id ?? null };
    }

    const payload = await SupabaseStorageAdapter.readErrorPayload(response);
    throwProviderFailure(classifyProviderFailure(response.status, payload));
  }

  async download({ backend, key, filePath } = {}) {
    if (backend === SUPABASE_BACKEND) return this.downloadFromSupabase(key);
    if (backend === LOCAL_BACKEND || (!backend && filePath)) return this.downloadFromLegacy(filePath);
    if (RETIRED_BACKENDS.has(backend)) throw new StorageForbiddenError(RETIRED_BACKEND_MESSAGE);
    throw new StorageError('The document storage reference is invalid', { code: 'STORAGE_INVALID_REFERENCE', status: 400, retryable: false });
  }

  async downloadFromSupabase(key) {
    const config = this.getConfig();
    const objectPath = encodeObjectKey(key);
    const response = await this.send(config, `/object/${encodeURIComponent(config.bucket)}/${objectPath}`, {
      method: 'GET',
      headers: this.buildHeaders(config)
    });

    if (response.ok) {
      const body = typeof response.body?.getReader === 'function'
        ? Readable.fromWeb(response.body)
        : Readable.from(Buffer.from(await response.arrayBuffer()));
      const declaredLength = Number(response.headers.get('content-length'));
      return {
        body,
        contentLength: Number.isInteger(declaredLength) && declaredLength >= 0 ? declaredLength : null,
        contentType: response.headers.get('content-type'),
        checksum: null
      };
    }

    const payload = await SupabaseStorageAdapter.readErrorPayload(response);
    throwProviderFailure(classifyProviderFailure(response.status, payload));
  }

  async exists({ backend, key, filePath } = {}) {
    if (backend === SUPABASE_BACKEND) return this.existsInSupabase(key);
    if (backend === LOCAL_BACKEND || (!backend && filePath)) return this.existsInLegacy(filePath);
    return false;
  }

  async existsInSupabase(key) {
    if (!key) return false;
    const config = this.getConfig();
    const objectPath = encodeObjectKey(key);
    const response = await this.send(config, `/object/info/${encodeURIComponent(config.bucket)}/${objectPath}`, {
      method: 'GET',
      headers: this.buildHeaders(config)
    });

    if (response.ok) return true;
    const payload = await SupabaseStorageAdapter.readErrorPayload(response);
    const failure = classifyProviderFailure(response.status, payload);
    // A missing object is a normal answer, not a failure.
    if (failure.kind === 'notFound') return false;
    throwProviderFailure(failure);
  }

  async delete({ backend, key } = {}, { authorizedBy } = {}) {
    if (RETIRED_BACKENDS.has(backend)) throw new StorageForbiddenError(RETIRED_BACKEND_MESSAGE);
    if (backend !== SUPABASE_BACKEND) {
      throw new StorageForbiddenError('Legacy documents are read-only and cannot be deleted');
    }
    if (!key || !authorizedBy) {
      throw new StorageForbiddenError('Deleting a document object requires an authorized request');
    }

    const config = this.getConfig();
    const objectPath = encodeObjectKey(key);
    const response = await this.send(config, `/object/${encodeURIComponent(config.bucket)}`, {
      method: 'DELETE',
      headers: this.buildHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [objectPath] })
    });

    if (response.ok) return true;
    const payload = await SupabaseStorageAdapter.readErrorPayload(response);
    // Cleanup is idempotent: an object that is already gone counts as removed.
    const failure = classifyProviderFailure(response.status, payload);
    if (failure.kind === 'notFound') return true;
    throwProviderFailure(failure);
  }

  async downloadFromLegacy(filePath) {
    const resolved = await this.resolveLegacyPath(filePath);
    let stats;
    try {
      stats = await fs.promises.stat(resolved);
    } catch (error) {
      if (isMissingFileError(error)) throw new StorageNotFoundError(undefined, error);
      throw new StorageUnavailableError(undefined, error);
    }
    if (!stats.isFile()) throw new StorageNotFoundError();
    return {
      body: fs.createReadStream(resolved),
      contentLength: stats.size,
      contentType: null,
      checksum: null
    };
  }

  async existsInLegacy(filePath) {
    let resolved;
    try {
      resolved = await this.resolveLegacyPath(filePath);
    } catch (error) {
      if (error instanceof StorageNotFoundError || error instanceof StorageForbiddenError) return false;
      throw error;
    }
    try {
      const stats = await fs.promises.stat(resolved);
      return stats.isFile();
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw new StorageUnavailableError(undefined, error);
    }
  }

  async resolveLegacyPath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new StorageForbiddenError(LEGACY_UNAVAILABLE_MESSAGE);
    }

    const candidate = path.resolve(
      path.isAbsolute(filePath) ? filePath : path.join(this.uploadDirectory, filePath)
    );
    if (!isWithinDirectory(this.uploadDirectory, candidate)) {
      throw new StorageForbiddenError(LEGACY_UNAVAILABLE_MESSAGE);
    }

    let root = this.uploadDirectory;
    try {
      root = await fs.promises.realpath(this.uploadDirectory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new StorageUnavailableError(undefined, error);
    }

    let realPath;
    try {
      realPath = await fs.promises.realpath(candidate);
    } catch (error) {
      if (isMissingFileError(error)) throw new StorageNotFoundError(undefined, error);
      throw new StorageUnavailableError(undefined, error);
    }

    if (!isWithinDirectory(root, realPath)) {
      throw new StorageForbiddenError(LEGACY_UNAVAILABLE_MESSAGE);
    }
    return realPath;
  }
}

SupabaseStorageAdapter.SUPABASE_BACKEND = SUPABASE_BACKEND;
SupabaseStorageAdapter.LOCAL_BACKEND = LOCAL_BACKEND;
SupabaseStorageAdapter.RETIRED_BACKENDS = RETIRED_BACKENDS;

module.exports = SupabaseStorageAdapter;
module.exports.SUPABASE_BACKEND = SUPABASE_BACKEND;
module.exports.LOCAL_BACKEND = LOCAL_BACKEND;
module.exports.RETIRED_BACKENDS = RETIRED_BACKENDS;
