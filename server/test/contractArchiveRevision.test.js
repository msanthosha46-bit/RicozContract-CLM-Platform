const assert = require('node:assert/strict');
const test = require('node:test');

const Contract = require('../models/Contract');
const ActivityLog = require('../models/ActivityLog');
const contractRoutes = require('../routes/contractRoutes');

const contractId = '64b000000000000000000001';
const archiveHandler = contractRoutes.stack
  .find((layer) => layer.route?.path === '/:id/archive')
  .route.stack.at(-1).handle;

const invokeArchive = async () => {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let forwardedError;
  await archiveHandler(
    { params: { id: contractId }, user: { _id: '64b000000000000000000002' } },
    response,
    (error) => { forwardedError = error; }
  );
  return { response, forwardedError };
};

const withArchiveMocks = async ({ contract, updateResult, auditWrite } = {}, callback) => {
  const originals = {
    findById: Contract.findById,
    findOneAndUpdate: Contract.findOneAndUpdate,
    createActivity: ActivityLog.create
  };
  const calls = { updates: [], audits: [] };
  Contract.findById = async () => contract ?? {
    _id: contractId,
    contractNumber: 'CNT-2026-0001',
    revision: 6,
    isArchived: false
  };
  Contract.findOneAndUpdate = async (filter, update, options) => {
    calls.updates.push({ filter, update, options });
    return updateResult === undefined ? { _id: contractId, revision: 7, isArchived: true } : updateResult;
  };
  ActivityLog.create = async (entry) => {
    calls.audits.push(entry);
    if (auditWrite) return auditWrite(entry);
    return entry;
  };

  try {
    await callback(calls);
  } finally {
    Contract.findById = originals.findById;
    Contract.findOneAndUpdate = originals.findOneAndUpdate;
    ActivityLog.create = originals.createActivity;
  }
};

test('archive endpoint uses revision CAS and preserves its audit event and response', async () => {
  await withArchiveMocks({}, async (calls) => {
    const { response, forwardedError } = await invokeArchive();

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { message: 'Contract archived successfully' });
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].filter._id, contractId);
    assert.ok(calls.updates[0].filter.$and.some((clause) => clause.$and?.some((part) => part.revision === 6)));
    assert.deepEqual(calls.updates[0].update.$set, { isArchived: true });
    assert.deepEqual(calls.updates[0].update.$inc, { revision: 1 });
    assert.equal(calls.audits.length, 1);
    assert.deepEqual(calls.audits[0], {
      user: '64b000000000000000000002',
      contract: contractId,
      action: 'Contract Archived',
      details: 'Archived contract CNT-2026-0001'
    });
  });
});

test('archive endpoint returns 409 and skips audit when the revision CAS is stale', async () => {
  await withArchiveMocks({ updateResult: null }, async (calls) => {
    const { response, forwardedError } = await invokeArchive();

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /updated by another request/);
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.audits.length, 0);
  });
});

test('archive endpoint forwards a required audit failure instead of reporting success', async () => {
  const auditError = new Error('audit unavailable');
  await withArchiveMocks({ auditWrite: async () => { throw auditError; } }, async (calls) => {
    const { response, forwardedError } = await invokeArchive();

    assert.equal(forwardedError, auditError);
    assert.equal(response.body, undefined);
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.audits.length, 1);
  });
});

test('archive endpoint treats an absent legacy revision as logical zero', async () => {
  await withArchiveMocks({
    contract: { _id: contractId, contractNumber: 'CNT-2026-0001', isArchived: false }
  }, async (calls) => {
    const { response, forwardedError } = await invokeArchive();

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 200);
    const revisionFilter = calls.updates[0].filter.$and.find((clause) => clause.$or);
    assert.ok(revisionFilter.$or.some((part) => part.revision?.$exists === false));
  });
});
