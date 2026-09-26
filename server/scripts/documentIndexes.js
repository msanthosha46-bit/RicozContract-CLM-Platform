const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const ContractDocument = require('../models/ContractDocument');
const {
  readDocumentVersionIndexReport,
  describeDocumentIndexReport,
  syncDocumentVersionIndex
} = require('../utils/documentIndexes');

const apply = process.argv.includes('--apply');
// 0 disables the guard: the CLI waits for the scan to finish rather than
// reporting a timeout while a large collection is still being scanned.
const maxTimeMS = 0;

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not configured. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false
  });

  try {
    if (!apply) {
      const report = await readDocumentVersionIndexReport(ContractDocument, { maxTimeMS });
      console.log(describeDocumentIndexReport(report));
      console.log('');
      console.log('This was a read-only check. No documents and no indexes were modified.');
      process.exitCode = report.ready || report.blockers.length === 0 ? 0 : 1;
      return;
    }

    const result = await syncDocumentVersionIndex(ContractDocument, { maxTimeMS });
    console.log(describeDocumentIndexReport(result));
    console.log('');
    console.log(result.created
      ? 'The unique index was created. No document records were modified.'
      : 'The unique index was already present. No document records were modified.');
    process.exitCode = 0;
  } catch (error) {
    if (error.code === 'DOCUMENT_INDEX_BLOCKED') {
      console.error(describeDocumentIndexReport(error.report));
      console.error('');
      console.error('Refusing to build the index. No documents and no indexes were modified.');
      console.error('Resolve the items above under a separately approved data plan, then re-run.');
      process.exitCode = 1;
      return;
    }
    console.error(`Index procedure failed: ${error.message}`);
    console.error('No documents and no indexes were modified.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error(`Index procedure failed: ${error.message}`);
  process.exitCode = 1;
});
