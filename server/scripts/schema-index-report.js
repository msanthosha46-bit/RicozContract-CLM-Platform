#!/usr/bin/env node

// Read-only reconciliation of every model schema against the live database.
//
//   npm run indexes:report
//
// This script can only read. It has no code path that creates, drops or syncs
// an index and no code path that writes a document: it loads the models, calls
// listIndexes and prints a report. It is safe to run against production.
//
// It exists because config/db.js connects with `autoIndex: false`, so a declared
// index is only ever built by an explicit command. `indexes:check` covers one
// index (the document version index); this covers all of them.
//
// Exit code 0 = every declared index is present with the shape the schema
// promises. 1 = at least one is missing or does not match (a warning, not a
// failure: the service still runs, it just scans).

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const User = require('../models/User');
const Contract = require('../models/Contract');
const ContractDocument = require('../models/ContractDocument');
const Approval = require('../models/Approval');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const Renewal = require('../models/Renewal');
const ActivityLog = require('../models/ActivityLog');

const {
  readSchemaIndexReport,
  describeSchemaIndexReport
} = require('../utils/schemaIndexes');

const MODELS = [User, Contract, ContractDocument, Approval, Obligation, Milestone, Renewal, ActivityLog];

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
    const host = mongoose.connection.host;
    let outOfSync = 0;
    let totalMissing = 0;
    let totalMismatched = 0;

    console.log('RicozContract schema index report (READ ONLY)');
    console.log(`database host: ${host}`);
    console.log('No indexes and no documents are modified by this script.\n');

    for (const model of MODELS) {
      const report = await readSchemaIndexReport(model);
      console.log(describeSchemaIndexReport(report));
      console.log('');
      totalMissing += report.missing.length;
      totalMismatched += report.mismatched.length;
      if (!report.ready) outOfSync += 1;
    }

    console.log('Summary');
    console.log('-'.repeat(7));
    console.log(`  collections out of sync : ${outOfSync} of ${MODELS.length}`);
    console.log(`  declared but missing    : ${totalMissing}`);
    console.log(`  present but mismatched  : ${totalMismatched}`);
    console.log('');
    console.log('A missing unique index means the uniqueness the schema declares is not');
    console.log('enforced by the database, so duplicates are possible. Build the missing');
    console.log('indexes through a separately approved change window, then re-run this');
    console.log('report. It will not create them for you.');
    process.exitCode = outOfSync === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Index report failed: ${error.message}`);
    console.error('No indexes and no documents were modified.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error(`Index report failed: ${error.message}`);
  process.exitCode = 1;
});
