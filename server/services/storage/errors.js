// `retryable` distinguishes a temporary outage from a permanent condition such
// as a bucket misconfiguration. It is set explicitly rather than derived from
// the status code, because a 503 can mean either: a provider that is down, or a
// bucket that will keep rejecting requests until someone changes its settings.
class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', status = 503, cause, retryable = true } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.expose = true;
    if (cause) this.cause = cause;
  }
}

class StorageConfigurationError extends StorageError {
  constructor(message = 'Document storage is not configured') {
    super(message, { code: 'STORAGE_NOT_CONFIGURED', status: 503, retryable: false });
    this.name = 'StorageConfigurationError';
  }
}

class StorageUnavailableError extends StorageError {
  constructor(message = 'Document storage is temporarily unavailable. Please try again.', cause) {
    super(message, { code: 'STORAGE_UNAVAILABLE', status: 503, retryable: true, cause });
    this.name = 'StorageUnavailableError';
  }
}

class StorageNotFoundError extends StorageError {
  constructor(message = 'This document file is unavailable. It may have been removed from storage. Please upload a new version.', cause) {
    super(message, { code: 'STORAGE_NOT_FOUND', status: 404, retryable: false, cause });
    this.name = 'StorageNotFoundError';
  }
}

class StorageForbiddenError extends StorageError {
  constructor(message = 'This storage operation is not permitted', cause) {
    super(message, { code: 'STORAGE_FORBIDDEN', status: 403, retryable: false, cause });
    this.name = 'StorageForbiddenError';
  }
}

module.exports = {
  StorageError,
  StorageConfigurationError,
  StorageUnavailableError,
  StorageNotFoundError,
  StorageForbiddenError
};
