const SupabaseStorageAdapter = require('./supabaseStorage');
const errors = require('./errors');

const defaultAdapter = new SupabaseStorageAdapter();
const REQUIRED_METHODS = ['createObjectKey', 'upload', 'download', 'exists', 'delete'];
let activeAdapter = defaultAdapter;

const getStorageAdapter = () => activeAdapter;

const setStorageAdapter = (adapter) => {
  if (!adapter || REQUIRED_METHODS.some((method) => typeof adapter[method] !== 'function')) {
    throw new TypeError('Storage adapter does not implement the required storage contract');
  }
  // Routes record this value on the document row, so an adapter must name the
  // backend it writes.
  if (typeof adapter.backend !== 'string' || !adapter.backend.trim()) {
    throw new TypeError('Storage adapter does not declare a storage backend');
  }
  activeAdapter = adapter;
  return adapter;
};

const resetStorageAdapter = () => {
  activeAdapter = defaultAdapter;
};

module.exports = {
  getStorageAdapter,
  setStorageAdapter,
  resetStorageAdapter,
  SupabaseStorageAdapter,
  ...errors
};
