const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const http = require('node:http');

const {
  readRenewalOperationIndexReadiness
} = require('../utils/schemaIndexes');
const {
  setRenewalOperationsReady
} = require('../utils/renewalReadiness');

const REQUIRED = [
  {
    modelName: 'Contract',
    collectionName: 'contracts',
    name: 'operationMarker.operationId_1',
    key: { 'operationMarker.operationId': 1 },
    partialFilterExpression: { 'operationMarker.operationId': { $type: 'string' } }
  },
  {
    modelName: 'Renewal',
    collectionName: 'renewals',
    name: 'operationId_1',
    key: { operationId: 1 },
    partialFilterExpression: { operationId: { $type: 'string' } }
  },
  {
    modelName: 'ActivityLog',
    collectionName: 'activitylogs',
    name: 'operationId_1',
    key: { operationId: 1 },
    partialFilterExpression: { operationId: { $type: 'string' } }
  }
];

const makeModel = (collectionName, indexes) => ({
  collection: {
    collectionName,
    indexes: async () => indexes
  }
});

const modelsWith = (indexesByName = {}) => Object.fromEntries(REQUIRED.map((required) => [
  required.modelName,
  makeModel(required.collectionName, indexesByName[required.modelName] ?? [
    {
      name: required.name,
      key: required.key,
      unique: true,
      partialFilterExpression: required.partialFilterExpression
    }
  ])
]));

test('renewal operation indexes are ready only when all three exact definitions match', async () => {
  const report = await readRenewalOperationIndexReadiness(modelsWith());
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.map((check) => check.ready), [true, true, true]);
});

for (const required of REQUIRED) {
  test(`renewal readiness fails when ${required.collectionName} operation index is missing`, async () => {
    const report = await readRenewalOperationIndexReadiness(modelsWith({ [required.modelName]: [] }));
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((check) => check.collection === required.collectionName).ready, false);
  });
}

test('renewal readiness rejects an operation index without unique enforcement', async () => {
  const wrong = modelsWith();
  wrong.Renewal = makeModel('renewals', [{
    name: 'operationId_1',
    key: { operationId: 1 },
    unique: false,
    partialFilterExpression: { operationId: { $type: 'string' } }
  }]);
  const report = await readRenewalOperationIndexReadiness(wrong);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((check) => check.collection === 'renewals').ready, false);
});

test('renewal readiness rejects an operation index with a different partial filter', async () => {
  const wrong = modelsWith();
  wrong.ActivityLog = makeModel('activitylogs', [{
    name: 'operationId_1',
    key: { operationId: 1 },
    unique: true,
    partialFilterExpression: { operationId: { $type: 'object' } }
  }]);
  const report = await readRenewalOperationIndexReadiness(wrong);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((check) => check.collection === 'activitylogs').ready, false);
});

test('renewal readiness propagates index-list verification errors', async () => {
  const models = modelsWith();
  models.Contract.collection.indexes = async () => { throw new Error('index listing unavailable'); };
  await assert.rejects(
    readRenewalOperationIndexReadiness(models),
    /index listing unavailable/
  );
});

const request = async (server, method, path, body = {}) => {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: { 'content-type': 'application/json' }
    }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: content }));
    });
    request.on('error', reject);
    if (method === 'GET') request.end();
    else request.end(JSON.stringify(body));
  });
};

test('renewal router gates mutations and recovery while keeping GET endpoints available', async () => {
  const auth = require('../middleware/auth');
  const Contract = require('../models/Contract');
  const Renewal = require('../models/Renewal');
  const ActivityLog = require('../models/ActivityLog');
  const originalAuth = { protect: auth.protect, authorize: auth.authorize };
  const originalContractFind = Contract.find;
  const originalContractFindById = Contract.findById;
  const originalContractFindOneAndUpdate = Contract.findOneAndUpdate;
  const originalRenewalFind = Renewal.find;
  const originalRenewalFindOne = Renewal.findOne;
  const originalRenewalFindOneAndUpdate = Renewal.findOneAndUpdate;
  const originalActivityFindOneAndUpdate = ActivityLog.findOneAndUpdate;

  auth.protect = (req, res, next) => {
    req.user = { _id: '64b000000000000000000001', role: 'Admin' };
    next();
  };
  auth.authorize = () => (req, res, next) => next();
  Contract.find = () => ({ sort: async () => [] });
  Renewal.find = () => ({
    populate() { return this; },
    sort() { return this; },
    limit: async () => []
  });
  const contractId = '64b000000000000000000002';
  const renewedBy = '64b000000000000000000001';
  const oldEndDate = new Date('2028-01-01T00:00:00.000Z');
  const newEndDate = new Date('2030-01-01T00:00:00.000Z');
  const operationId = 'readiness-route-test';
  let compareAndSetCalls = 0;
  Contract.findById = async () => ({
    _id: contractId,
    endDate: oldEndDate,
    status: 'Active',
    isArchived: false,
    revision: 0
  });
  Contract.findOneAndUpdate = async () => {
    compareAndSetCalls += 1;
    if (compareAndSetCalls === 1) {
      return {
        _id: contractId,
        endDate: newEndDate,
        status: 'Active',
        isArchived: false,
        revision: 1,
        operationMarker: {
          operationId,
          operationType: 'Renewal',
          renewal: {
            oldEndDate,
            newEndDate,
            renewedBy,
            notes: null,
            committedRevision: 1
          }
        }
      };
    }
    return { _id: contractId, revision: 2 };
  };
  Renewal.findOne = async () => null;
  Renewal.findOneAndUpdate = async (_filter, update) => ({
    _id: '64b000000000000000000003',
    ...update.$setOnInsert
  });
  ActivityLog.findOneAndUpdate = async () => ({});

  let server;
  try {
    const router = require('../routes/renewalRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/renewals', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    setRenewalOperationsReady(false);
    const renewalUnavailable = await request(server, 'POST', '/api/renewals/renew/contract-id', {
      newEndDate: '2030-01-01'
    });
    assert.equal(renewalUnavailable.status, 503);
    assert.match(renewalUnavailable.body, /RENEWAL_INDEXES_NOT_READY/);

    const recoveryUnavailable = await request(server, 'POST', '/api/renewals/recover/contract-id', {});
    assert.equal(recoveryUnavailable.status, 503);
    assert.match(recoveryUnavailable.body, /RENEWAL_INDEXES_NOT_READY/);

    for (const path of ['/expiring', '/renewable', '/history']) {
      const response = await request(server, 'GET', `/api/renewals${path}`);
      assert.equal(response.status, 200, `${path} remains available while readiness is false`);
    }

    setRenewalOperationsReady(true);
    const renewalReady = await request(server, 'POST', `/api/renewals/renew/${contractId}`, {
      newEndDate: newEndDate.toISOString(),
      operationId
    });
    assert.equal(renewalReady.status, 201, `ready renewal should complete: ${renewalReady.body}`);
    assert.equal(compareAndSetCalls, 2, 'renewal write and marker finalization both ran');

  } finally {
    setRenewalOperationsReady(false);
    if (server) await new Promise((resolve) => server.close(resolve));
    auth.protect = originalAuth.protect;
    auth.authorize = originalAuth.authorize;
    Contract.find = originalContractFind;
    Contract.findById = originalContractFindById;
    Contract.findOneAndUpdate = originalContractFindOneAndUpdate;
    Renewal.find = originalRenewalFind;
    Renewal.findOne = originalRenewalFindOne;
    Renewal.findOneAndUpdate = originalRenewalFindOneAndUpdate;
    ActivityLog.findOneAndUpdate = originalActivityFindOneAndUpdate;
  }
});
