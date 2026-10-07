// READ-ONLY schema-index reconciliation.
//
// The server connects with `autoIndex: false` (config/db.js), which is correct
// - an implicit build on a large collection can lock the collection and a
// production service must never do that on boot. The consequence, though, is
// that `schema.index()` declarations are inert: nothing in the repository
// creates them. `npm run indexes:sync` only ever manages the single
// (contract, version) document index, so every other declared index - including
// the unique constraints on User.email, User.googleId and
// Contract.contractNumber - exists only if it happened to be built before
// autoIndex was disabled, or by a manual command nobody recorded.
//
// This module answers the question that gap leaves open: which indexes does the
// schema declare that the database does not actually have? It is strictly a
// reader. It never calls createIndex, dropIndex, syncIndexes, deleteMany,
// updateMany or insertMany, and it accepts no model that it was not handed, so
// running it against production can only ever read.
const mongoose = require('mongoose');

const NAMESPACE_NOT_FOUND = 26;
const REPORT_LIMIT = 200;

// Mongo's own generated name for a key, e.g. { contract: 1, version: 1 } becomes
// "contract_1_version_1". Comparing against the generated name means a schema
// that omits `name` still matches the index that was built for it.
const generatedIndexName = (key) =>
  Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join('_');

const isIdKey = (key) => Object.keys(key).length === 1 && key._id !== undefined;

// The `_id` index is special in three ways, and all three have to be normalised
// or every collection is reported as permanently out of sync:
//   - it is named "_id_", not the generated "_id_1";
//   - it is always unique, but listIndexes omits the `unique` flag for it;
//   - it always exists, even before a document is written.
const idIndexContract = () => ({ name: '_id_', key: { _id: 1 }, unique: true, sparse: false });

// The options that change what an index guarantees, and therefore what has to
// match. Everything else (background, v, collation of the default collection)
// is a build hint, not part of the contract.
const indexContract = (key, options = {}) => {
  if (isIdKey(key)) return idIndexContract();
  return {
    name: options.name || generatedIndexName(key),
    key,
    unique: Boolean(options.unique),
    sparse: Boolean(options.sparse)
  };
};

const sameContract = (declared, actual) => (
  declared.name === actual.name
  && declared.unique === actual.unique
  && declared.sparse === actual.sparse
  && JSON.stringify(declared.key) === JSON.stringify(actual.key)
);const describeIndex = (index) => {
  const flags = [index.unique ? 'unique' : null, index.sparse ? 'sparse' : null]
    .filter(Boolean)
    .join(',');
  return flags ? `${index.name} (${flags})` : index.name;
};

/** Every index the schema declares, including the implicit `_id` index. */
const declaredIndexesFor = (model) => {
  const declared = model.schema.indexes().map(([key, options]) => indexContract(key, options));
  if (!declared.some(isIdKey)) declared.push(idIndexContract());
  return declared;
};

/** Every index the live collection actually has. Empty when the collection is absent. */
const readActualIndexes = async (model) => {
  try {
    const indexes = await model.collection.indexes();
    return indexes.map((index) => indexContract(index.key, index));
  } catch (error) {
    if (error.code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
};

/**
 * Compare the schema against the live database.
 * Returns { collection, collectionExists, declared, actual, missing, mismatched, ready }.
 * `missing` are declared-but-absent; `mismatched` exist with a different key or
 * with uniqueness/sparseness that the schema does not promise. `ready` is true
 * only when the two agree completely.
 */
const readSchemaIndexReport = async (model, { limit = REPORT_LIMIT } = {}) => {
  const declared = declaredIndexesFor(model);
  const actual = await readActualIndexes(model);
  const collectionExists = actual.length > 0;

  const missing = [];
  const mismatched = [];
  for (const index of declared) {
    const found = actual.find((candidate) => sameContract(index, candidate));
    if (found) continue;
    const sameName = actual.find((candidate) => candidate.name === index.name);
    if (sameName) mismatched.push({ declared: index, actual: sameName });
    else missing.push(index);
  }

  return {
    collection: model.collection.collectionName,
    collectionExists,
    declared,
    actual,
    missing,
    mismatched,
    ready: missing.length === 0 && mismatched.length === 0
  };
};

/** Human-readable report. Contains no connection string and no credentials. */
const describeSchemaIndexReport = (report) => {
  const lines = [];
  lines.push(`${report.collection}`);
  lines.push(`  collection present     : ${report.collectionExists ? 'yes' : 'no'}`);
  lines.push(`  indexes declared       : ${report.declared.length}`);
  lines.push(`  indexes present        : ${report.actual.length}`);
  lines.push(`  declared but missing   : ${report.missing.length}`);
  lines.push(`  present but mismatched : ${report.mismatched.length}`);

  for (const index of report.declared) {
    const status = report.missing.some((candidate) => candidate.name === index.name)
      ? 'MISSING'
      : report.mismatched.some((candidate) => candidate.declared.name === index.name)
        ? 'MISMATCHED'
        : 'ok';
    lines.push(`    [${status}] ${describeIndex(index)}`);
  }

  for (const pair of report.mismatched) {
    lines.push(`    the live ${pair.actual.name} has key ${JSON.stringify(pair.actual.key)}` +
      ` unique=${pair.actual.unique} sparse=${pair.actual.sparse}, the schema declares` +
      ` ${JSON.stringify(pair.declared.key)} unique=${pair.declared.unique} sparse=${pair.declared.sparse}`);
  }

  if (report.ready) {
    lines.push('  status: in sync');
  } else {
    lines.push('  status: OUT OF SYNC');
    lines.push('  This was a read-only check. No indexes and no documents were modified.');
    lines.push('  Because the server connects with autoIndex:false, nothing creates these');
    lines.push('  automatically. Build them through a separately approved change window.');
  }
  return lines.join('\n');
};

module.exports = {
  generatedIndexName,
  declaredIndexesFor,
  readActualIndexes,
  readSchemaIndexReport,
  describeSchemaIndexReport
};
