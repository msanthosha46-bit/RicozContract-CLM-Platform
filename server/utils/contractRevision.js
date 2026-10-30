const Contract = require('../models/Contract');
const mongoose = require('mongoose');

const OPERATION_TYPES = new Set(['ApprovalSubmission', 'ApprovalDecision', 'AmendmentDecision', 'Renewal']);
// Mongoose Number values may be stored as BSON int32, int64, or double. Exact
// equality below requires an integral safe JS number; Decimal128 and all other
// BSON types are deliberately unsupported. The array exclusion is necessary
// because MongoDB's query $type operator also matches elements inside arrays.
const SUPPORTED_REVISION_TYPES = ['int', 'long', 'double'];
const RESERVED_PATCH_PATHS = new Set(['revision', '__v', 'operationMarker']);

class InvalidContractRevisionError extends TypeError {
  constructor() {
    super('expectedRevision must be a non-negative safe integer');
    this.name = 'InvalidContractRevisionError';
  }
}

class InvalidContractPatchError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'InvalidContractPatchError';
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validatePatch = (set) => {
  if (!isPlainObject(set)) {
    throw new InvalidContractPatchError('set must be a plain object');
  }

  for (const path of Object.keys(set)) {
    if (!path || path.startsWith('$') || path.includes('.') || RESERVED_PATCH_PATHS.has(path)) {
      throw new InvalidContractPatchError(`Contract patch path is reserved or invalid: ${path}`);
    }
  }
};

const validateOperationMarker = (marker) => {
  if (!isPlainObject(marker)) {
    throw new InvalidContractPatchError('operationMarker must be a plain object');
  }
  const keys = Object.keys(marker).sort();
  const baseKeys = ['operationId', 'operationType'];
  const isRenewalMarker = marker.operationType === 'Renewal';
  if (keys.length !== (isRenewalMarker ? 3 : 2)
      || !baseKeys.every((key) => keys.includes(key))
      || (isRenewalMarker ? !keys.includes('renewal') : keys.includes('renewal'))) {
    throw new InvalidContractPatchError('operationMarker fields do not match its operation type');
  }

  const { operationId, operationType } = marker;
  if (typeof operationId !== 'string'
      || operationId.trim() !== operationId
      || operationId.length < 1
      || operationId.length > 128
      || !/^[A-Za-z0-9:_-]+$/.test(operationId)) {
    throw new InvalidContractPatchError('operationMarker.operationId is invalid');
  }
  if (!OPERATION_TYPES.has(operationType)) {
    throw new InvalidContractPatchError('operationMarker.operationType is invalid');
  }

  const validated = { operationId, operationType };
  if (operationType === 'Renewal') {
    const renewal = marker.renewal;
    if (!isPlainObject(renewal)
        || Object.keys(renewal).some((key) => !['oldEndDate', 'newEndDate', 'renewedBy', 'notes', 'committedRevision'].includes(key))
        || !['oldEndDate', 'newEndDate', 'renewedBy', 'committedRevision'].every((key) => Object.hasOwn(renewal, key))
        || !(renewal.oldEndDate instanceof Date) || Number.isNaN(renewal.oldEndDate.getTime())
        || !(renewal.newEndDate instanceof Date) || Number.isNaN(renewal.newEndDate.getTime())
        || !mongoose.isValidObjectId(renewal.renewedBy)
        || (renewal.notes !== null && typeof renewal.notes !== 'string')
        || !Number.isSafeInteger(renewal.committedRevision) || renewal.committedRevision < 1) {
      throw new InvalidContractPatchError('operationMarker.renewal is invalid');
    }
    validated.renewal = {
      oldEndDate: renewal.oldEndDate,
      newEndDate: renewal.newEndDate,
      renewedBy: renewal.renewedBy,
      notes: renewal.notes ?? null,
      committedRevision: renewal.committedRevision
    };
  }

  return validated;
};

const validateUnset = (unset) => {
  if (!Array.isArray(unset)) {
    throw new InvalidContractPatchError('unset must be an array of Contract field names');
  }
  for (const path of unset) {
    if (typeof path !== 'string'
        || !path
        || path.startsWith('$')
        || path.includes('.')
        || RESERVED_PATCH_PATHS.has(path)) {
      throw new InvalidContractPatchError(`Contract unset path is reserved or invalid: ${path}`);
    }
  }
};

const validateContractId = (contractId) => {
  const supportedIdInput = typeof contractId === 'string'
    || contractId instanceof mongoose.Types.ObjectId;
  if (!supportedIdInput || !mongoose.isValidObjectId(contractId)) {
    throw new InvalidContractPatchError('contractId must be a valid ObjectId or ObjectId string');
  }
};

const exactRevisionClause = (revision) => ({
  $and: [
    { revision },
    { $or: SUPPORTED_REVISION_TYPES.map((type) => ({ revision: { $type: type } })) },
    { revision: { $not: { $type: 'array' } } }
  ]
});

/**
 * Apply one Contract patch only if the caller's revision is still current.
 * Returns the updated document, or null when the CAS did not match. It never
 * reloads the Contract or retries a stale patch.
 *
 * operationMarker installs a sanitized marker in the same CAS. To clear a
 * marker, provide clearOperationId; that CAS only matches the named operation.
 */
async function compareAndSetContract({
  model = Contract,
  contractId,
  expectedRevision,
  set = {},
  unset = [],
  operationMarker,
  clearOperationId,
  clearOperationMarker,
  expectedStatus,
  requireUnarchived = false
}) {
  // This helper always increments once, so the largest safe integer cannot be
  // accepted as an input revision: its next value would be unsafe.
  if (!Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
      || expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new InvalidContractRevisionError();
  }
  validateContractId(contractId);
  if (!model || typeof model.findOneAndUpdate !== 'function') {
    throw new InvalidContractPatchError('model must provide findOneAndUpdate');
  }
  validatePatch(set);
  validateUnset(unset);
  if (expectedStatus !== undefined && typeof expectedStatus !== 'string') {
    throw new InvalidContractPatchError('expectedStatus must be a string');
  }
  if (typeof requireUnarchived !== 'boolean') {
    throw new InvalidContractPatchError('requireUnarchived must be a boolean');
  }

  if ((operationMarker !== undefined && (clearOperationId !== undefined || clearOperationMarker !== undefined))
      || (clearOperationId !== undefined && clearOperationMarker !== undefined)) {
    throw new InvalidContractPatchError('operation marker install and clear options cannot be combined');
  }

  const filterParts = [];
  if (expectedStatus !== undefined) filterParts.push({ status: expectedStatus });
  // Match the legacy route semantics: only an explicit true value is archived.
  // Equality to null also matches documents where the optional field is absent.
  // Keep this as its own clause so it composes with revision/marker $or filters.
  if (requireUnarchived) filterParts.push({ $or: [{ isArchived: false }, { isArchived: null }] });
  if (expectedRevision === 0) {
    // Missing revision is logical zero only for this initial CAS. The update's
    // $inc persists it as one if this filter wins. An explicit zero must have a
    // supported scalar numeric BSON type; null and malformed values do not match.
    filterParts.push({
      $or: [
        exactRevisionClause(0),
        { revision: { $exists: false } }
      ]
    });
  } else {
    filterParts.push(exactRevisionClause(expectedRevision));
  }

  if (clearOperationMarker !== undefined) {
    const marker = validateOperationMarker(clearOperationMarker);
    filterParts.push({ 'operationMarker.operationId': marker.operationId });
    filterParts.push({ 'operationMarker.operationType': marker.operationType });
    if (marker.renewal) {
      for (const [key, value] of Object.entries(marker.renewal)) {
        filterParts.push({ [`operationMarker.renewal.${key}`]: value });
      }
    }
  } else if (clearOperationId !== undefined) {
    if (typeof clearOperationId !== 'string'
        || clearOperationId.trim() !== clearOperationId
        || clearOperationId.length < 1
        || clearOperationId.length > 128
        || !/^[A-Za-z0-9:_-]+$/.test(clearOperationId)) {
      throw new InvalidContractPatchError('clearOperationId is invalid');
    }
    filterParts.push({ 'operationMarker.operationId': clearOperationId });
  } else {
    // Missing and explicit null both mean there is no active marker. Any other
    // marker value, including malformed/empty objects, blocks ordinary writes.
    filterParts.push({
      $or: [
        { operationMarker: { $exists: false } },
        { operationMarker: null }
      ]
    });
  }

  const update = {
    $inc: { revision: 1 }
  };
  const setValues = { ...set };
  if (operationMarker !== undefined) {
    setValues.operationMarker = validateOperationMarker(operationMarker);
  }
  if (Object.keys(setValues).length) update.$set = setValues;
  if (unset.length || clearOperationId !== undefined || clearOperationMarker !== undefined) {
    update.$unset = Object.fromEntries(unset.map((path) => [path, 1]));
    if (clearOperationId !== undefined || clearOperationMarker !== undefined) update.$unset.operationMarker = 1;
  }

  return model.findOneAndUpdate(
    { _id: contractId, $and: filterParts },
    update,
    { new: true, runValidators: true, context: 'query' }
  );
}

module.exports = {
  InvalidContractPatchError,
  InvalidContractRevisionError,
  compareAndSetContract
};
