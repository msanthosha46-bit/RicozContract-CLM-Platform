const INDEX_NAME = 'contract_1_version_1';
const INDEX_KEY = { contract: 1, version: 1 };
const DEFAULT_TIMEOUT_MS = 5000;
const REPORT_LIMIT = 20;

const NAMESPACE_NOT_FOUND = 26;
const TIMEOUT_CODE = 'DOCUMENT_INDEX_CHECK_TIMEOUT';

const withEmptyOnMissingCollection = async (promise) => {
  try {
    return await promise;
  } catch (error) {
    if (error.code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
};

const missingIndexState = () => ({
  indexName: INDEX_NAME,
  indexPresent: false,
  indexUnique: false,
  indexReady: false,
  indexKey: null,
  collectionExists: false
});

const readIndexState = async (model) => {
  let indexes;
  try {
    indexes = await model.collection.indexes();
  } catch (error) {
    if (error.code === NAMESPACE_NOT_FOUND) return missingIndexState();
    throw error;
  }
  const existing = indexes.find((index) => index.name === INDEX_NAME);
  return {
    indexName: INDEX_NAME,
    indexPresent: Boolean(existing),
    indexUnique: Boolean(existing && existing.unique),
    indexReady: Boolean(existing && existing.unique),
    indexKey: existing ? existing.key : null,
    collectionExists: true
  };
};

const findDuplicateVersionGroups = (model) => withEmptyOnMissingCollection(model.collection.aggregate([
  { $group: { _id: { contract: '$contract', version: '$version' }, count: { $sum: 1 }, documentIds: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 }, '_id.version': { $ne: null } } },
  { $sort: { count: -1 } },
  { $limit: REPORT_LIMIT }
]).toArray());

const findContractsMissingVersion = (model) => withEmptyOnMissingCollection(model.collection.aggregate([
  { $match: { $or: [{ version: { $exists: false } }, { version: null }] } },
  { $group: { _id: '$contract', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: REPORT_LIMIT }
]).toArray());

const readDocumentVersionIndexReport = async (model, { maxTimeMS = DEFAULT_TIMEOUT_MS } = {}) => {
  const work = Promise.all([
    readIndexState(model),
    findDuplicateVersionGroups(model),
    findContractsMissingVersion(model)
  ]);

  let settled;
  if (!maxTimeMS) {
    settled = await work;
  } else {
    let timer;
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Document version index check exceeded ${maxTimeMS}ms`);
        error.code = TIMEOUT_CODE;
        reject(error);
      }, maxTimeMS);
      timer.unref?.();
    });
    try {
      settled = await Promise.race([work, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  const [indexState, duplicateGroups, missingVersionGroups] = settled;

  const blockers = [];
  if (missingVersionGroups.length) {
    blockers.push({
      code: 'DOCUMENTS_MISSING_VERSION',
      message: `${missingVersionGroups.length} contract(s) have documents with no version value; they would collide in a unique index.`
    });
  }
  if (duplicateGroups.length) {
    blockers.push({
      code: 'DUPLICATE_DOCUMENT_VERSIONS',
      message: `${duplicateGroups.length} contract/version pair(s) are duplicated; a unique index cannot be built until they are resolved.`
    });
  }
  if (indexState.indexPresent && !indexState.indexUnique) {
    blockers.push({
      code: 'INDEX_NOT_UNIQUE',
      message: `Index ${INDEX_NAME} already exists but is not unique. Resolve it manually; this tool never drops indexes.`
    });
  }

  return {
    ...indexState,
    duplicateGroups,
    missingVersionGroups,
    blockers,
    ready: blockers.length === 0 && indexState.indexReady
  };
};

const describeDocumentIndexReport = (report) => {
  const lines = [];
  lines.push(`Document version index: ${INDEX_NAME}`);
  lines.push(`  unique index present : ${report.indexReady ? 'yes' : 'no'}`);
  lines.push(`  duplicate (contract, version) groups : ${report.duplicateGroups.length}`);
  lines.push(`  contracts with documents missing a version : ${report.missingVersionGroups.length}`);

  for (const group of report.duplicateGroups) {
    lines.push(`    - contract ${group._id.contract} version ${group._id.version} appears ${group.count} time(s)`);
  }
  for (const group of report.missingVersionGroups) {
    lines.push(`    - contract ${group._id} has ${group.count} document(s) with no version`);
  }

  if (report.blockers.length) {
    lines.push('  status: ACTION REQUIRED');
    for (const blocker of report.blockers) {
      lines.push(`    [${blocker.code}] ${blocker.message}`);
    }
    lines.push('  The unique (contract, version) index was NOT created. Document versioning cannot');
    lines.push('  guarantee unique versions until this is resolved. No data was changed.');
  } else if (report.indexReady) {
    lines.push('  status: ready');
  } else {
    lines.push('  status: SAFE TO CREATE');
    lines.push(`  Run "npm run indexes:sync" to create the unique index. No data was changed.`);
  }

  return lines.join('\n');
};

const documentIndexBlockedError = (report) => {
  const error = new Error('Document version index was not created because pre-checks failed.');
  error.code = 'DOCUMENT_INDEX_BLOCKED';
  error.report = report;
  return error;
};

const syncDocumentVersionIndex = async (model, { maxTimeMS = DEFAULT_TIMEOUT_MS } = {}) => {
  const report = await readDocumentVersionIndexReport(model, { maxTimeMS });
  if (report.blockers.length) throw documentIndexBlockedError(report);
  if (report.indexReady) return { ...report, created: false };

  await model.collection.createIndex(INDEX_KEY, { unique: true, name: INDEX_NAME });
  const verified = await readIndexState(model);
  if (!verified.indexReady) {
    const error = new Error('The unique index build did not take effect and needs manual investigation.');
    error.code = 'DOCUMENT_INDEX_UNVERIFIED';
    throw error;
  }
  return { ...report, ...verified, blockers: [], ready: true, created: true };
};

module.exports = {
  INDEX_NAME,
  INDEX_KEY,
  TIMEOUT_CODE,
  DEFAULT_TIMEOUT_MS,
  readIndexState,
  readDocumentVersionIndexReport,
  describeDocumentIndexReport,
  syncDocumentVersionIndex
};
