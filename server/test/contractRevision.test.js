const assert = require('node:assert/strict');
const test = require('node:test');

const Contract = require('../models/Contract');
const { readSchemaIndexReport } = require('../utils/schemaIndexes');
const {
  InvalidContractPatchError,
  InvalidContractRevisionError,
  compareAndSetContract
} = require('../utils/contractRevision');

const contractId = '64b000000000000000000001';

const makeModel = (result = { _id: contractId, revision: 1 }) => {
  const calls = [];
  return {
    calls,
    findOneAndUpdate(...args) {
      calls.push(args);
      return Promise.resolve(result);
    }
  };
};

const containsRevisionPredicate = (value) => {
  if (Array.isArray(value)) return value.some(containsRevisionPredicate);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => key === 'revision' || containsRevisionPredicate(nested));
};

const revisionClauses = (filter) => filter.$and.filter(containsRevisionPredicate);

const hasExactRevision = (clause, revision) => clause.$and?.some((part) => part.revision === revision);

test('new Contract documents default to revision zero and define a sanitized operation marker', () => {
  const contract = new Contract();

  assert.equal(contract.revision, 0);
  assert.equal(Contract.schema.path('revision').instance, 'Number');
  assert.equal(Contract.schema.path('operationMarker').schema.options._id, false);
  assert.deepEqual(
    Object.keys(Contract.schema.path('operationMarker').schema.paths).sort(),
    ['operationId', 'operationType', 'renewal']
  );

  const marker = {
    operationId: 'renewal-publication-test',
    operationType: 'Renewal',
    renewal: {
      oldEndDate: new Date('2027-01-01T00:00:00.000Z'),
      newEndDate: new Date('2029-01-01T00:00:00.000Z'),
      renewedBy: '64b000000000000000000003',
      notes: 'Internal recovery payload',
      committedRevision: 1
    }
  };
  const marked = new Contract({
    contractNumber: 'CNT-MARKER-TEST', title: 'Marker test', type: 'Other', partyName: 'Test',
    startDate: marker.renewal.oldEndDate, endDate: marker.renewal.newEndDate,
    amount: 1, createdBy: marker.renewal.renewedBy, operationMarker: marker
  });
  assert.equal(marked.operationMarker.renewal.notes, 'Internal recovery payload');
  assert.equal(marked.toJSON().operationMarker, undefined, 'the internal payload is hidden from JSON API serialization');
  assert.equal(marked.toObject().operationMarker, undefined, 'the internal payload is hidden from toObject API serialization');

  for (const model of [require('../models/Renewal'), require('../models/ActivityLog'), Contract]) {
    const operationIndex = model.schema.indexes().find(([, options]) => options.name === (
      model === Contract ? 'operationMarker.operationId_1' : 'operationId_1'
    ));
    assert.ok(operationIndex, `${model.modelName} declares its operation ID index`);
    assert.equal(operationIndex[1].unique, true);
    assert.deepEqual(operationIndex[1].partialFilterExpression, model === Contract
      ? { 'operationMarker.operationId': { $type: 'string' } }
      : { operationId: { $type: 'string' } });
  }
});

test('initial CAS accepts persisted zero or a missing legacy revision only', async () => {
  const model = makeModel();

  await compareAndSetContract({ model, contractId, expectedRevision: 0, set: { title: 'Updated' } });

  const [filter] = model.calls[0];
  const revisionFilter = revisionClauses(filter)[0];
  assert.ok(revisionFilter.$or.some((part) => part.revision?.$exists === false));
  assert.ok(revisionFilter.$or.some((part) => hasExactRevision(part, 0)));
  const explicitZero = revisionFilter.$or.find((part) => hasExactRevision(part, 0));
  assert.deepEqual(
    explicitZero.$and.find((part) => part.$or)?.$or.map((part) => part.revision.$type),
    ['int', 'long', 'double']
  );
  assert.ok(explicitZero.$and.some((part) => part.revision?.$not?.$type === 'array'));
});

test('positive revisions require an exact match and stale CAS does not reload or retry', async () => {
  const model = makeModel(null);

  const result = await compareAndSetContract({ model, contractId, expectedRevision: 7, set: { amount: 125 } });

  assert.equal(result, null);
  assert.equal(model.calls.length, 1);
  const exact = revisionClauses(model.calls[0][0])[0];
  assert.ok(hasExactRevision(exact, 7));
  assert.deepEqual(exact.$and.find((part) => part.$or)?.$or.map((part) => part.revision.$type), ['int', 'long', 'double']);
});

test('invalid, null, fractional, negative, or unsafe revisions are rejected before writing', async () => {
  const model = makeModel();

  for (const expectedRevision of [null, undefined, '0', 1.5, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      compareAndSetContract({ model, contractId, expectedRevision }),
      InvalidContractRevisionError
    );
  }
  assert.equal(model.calls.length, 0);
});

test('missing, empty, and invalid Contract identifiers are rejected before writing', async () => {
  const model = makeModel();

  for (const invalidId of [undefined, null, '', 'not-an-object-id', 42, {}]) {
    await assert.rejects(
      compareAndSetContract({ model, contractId: invalidId, expectedRevision: 0 }),
      InvalidContractPatchError
    );
  }
  assert.equal(model.calls.length, 0);
});

test('ordinary CAS refuses an active operation marker in the write filter', async () => {
  const model = makeModel(null);

  const result = await compareAndSetContract({ model, contractId, expectedRevision: 3, set: { status: 'Active' } });

  assert.equal(result, null);
  assert.equal(model.calls.length, 1);
  assert.ok(model.calls[0][0].$and.some((clause) => clause.$or?.some((part) => (
    part.operationMarker?.$exists === false || part.operationMarker === null
  ))));
});

test('unarchived CAS accepts false, null, or missing archive flags but excludes true and unexpected values', async () => {
  const model = makeModel();

  await compareAndSetContract({
    model, contractId, expectedRevision: 0, requireUnarchived: true,
    operationMarker: { operationId: 'renewal-archive-test', operationType: 'Renewal', renewal: {
      oldEndDate: new Date('2027-01-01T00:00:00.000Z'),
      newEndDate: new Date('2029-01-01T00:00:00.000Z'),
      renewedBy: '64b000000000000000000003', notes: null, committedRevision: 1
    } }
  });

  const clauses = model.calls[0][0].$and;
  const archiveClause = clauses.find((clause) => clause.$or?.some((part) => (
    Object.hasOwn(part, 'isArchived')
  )));
  assert.deepEqual(archiveClause, { $or: [{ isArchived: false }, { isArchived: null }] });
  assert.ok(clauses.some((clause) => clause.$or?.some((part) => part.revision?.$exists === false)),
    'archive alternatives must not replace the legacy-revision alternatives');
  assert.ok(clauses.some((clause) => clause.$or?.some((part) => part.operationMarker?.$exists === false)),
    'archive alternatives must not replace the no-marker alternatives');

  const matchesArchiveClause = (value) => value === false || value === null || value === undefined;
  for (const value of [false, null, undefined]) assert.equal(matchesArchiveClause(value), true);
  for (const value of [true, 'false', 0]) assert.equal(matchesArchiveClause(value), false);
});

test('every successful CAS applies exactly one revision increment', async () => {
  let storedRevision = 4;
  const calls = [];
  const model = {
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      const revisionFilter = filter.$and.find((clause) => hasExactRevision(clause, storedRevision));
      if (!revisionFilter) return null;
      storedRevision += update.$inc.revision;
      return { _id: contractId, revision: storedRevision };
    }
  };

  const updated = await compareAndSetContract({ model, contractId, expectedRevision: 4, set: { amount: 500 } });
  const staleRetry = await compareAndSetContract({ model, contractId, expectedRevision: 4, set: { amount: 600 } });

  assert.equal(updated.revision, 5);
  assert.equal(storedRevision, 5);
  assert.equal(staleRetry, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].update.$inc, { revision: 1 });
  assert.deepEqual(calls[1].update.$inc, { revision: 1 });
  assert.equal(calls[0].options.runValidators, true);
});

test('marker installation is atomically filtered by revision and absence of another marker', async () => {
  const model = makeModel();

  await compareAndSetContract({
    model,
    contractId,
    expectedRevision: 0,
    set: { status: 'Active' },
    operationMarker: { operationId: 'amendment:123', operationType: 'AmendmentDecision' }
  });

  const [filter, update] = model.calls[0];
  assert.ok(filter.$and.some((clause) => clause.$or?.some((part) => (
    part.operationMarker?.$exists === false || part.operationMarker === null
  ))));
  assert.deepEqual(update.$set.operationMarker, {
    operationId: 'amendment:123',
    operationType: 'AmendmentDecision'
  });
  assert.deepEqual(update.$inc, { revision: 1 });
});

test('renewal marker validates and atomically stores its immutable recovery payload', async () => {
  const model = makeModel();
  const renewal = {
    oldEndDate: new Date('2027-01-01T00:00:00.000Z'),
    newEndDate: new Date('2029-01-01T00:00:00.000Z'),
    renewedBy: '64b000000000000000000003',
    notes: 'Extension',
    committedRevision: 5
  };

  await compareAndSetContract({
    model, contractId, expectedRevision: 4,
    set: { endDate: renewal.newEndDate, status: 'Active' },
    operationMarker: { operationId: 'renewal-123', operationType: 'Renewal', renewal }
  });

  assert.deepEqual(model.calls[0][1].$set.operationMarker, {
    operationId: 'renewal-123', operationType: 'Renewal', renewal
  });
  await assert.rejects(compareAndSetContract({
    model, contractId, expectedRevision: 4,
    operationMarker: { operationId: 'renewal-123', operationType: 'Renewal' }
  }), InvalidContractPatchError);
});

test('schema index report detects a missing partial filter without database access', async () => {
  const schema = new (require('mongoose').Schema)({ operationId: String });
  schema.index(
    { operationId: 1 },
    { unique: true, partialFilterExpression: { operationId: { $type: 'string' } }, name: 'operationId_1' }
  );
  const model = {
    schema,
    collection: {
      collectionName: 'mockrenewals',
      indexes: async () => [
        { name: '_id_', key: { _id: 1 }, unique: true },
        { name: 'operationId_1', key: { operationId: 1 }, unique: true }
      ]
    }
  };

  const report = await readSchemaIndexReport(model);
  assert.equal(report.ready, false);
  assert.equal(report.mismatched.length, 1);
  assert.deepEqual(report.mismatched[0].declared.partialFilterExpression, {
    operationId: { $type: 'string' }
  });
  assert.equal(report.mismatched[0].actual.partialFilterExpression, null);
});

test('marker clearing matches the expected operation and builds an unset update', async () => {
  const model = makeModel();

  await compareAndSetContract({
    model,
    contractId,
    expectedRevision: 8,
    clearOperationId: 'approval:456'
  });

  const [filter, update] = model.calls[0];
  assert.ok(filter.$and.some((clause) => clause['operationMarker.operationId'] === 'approval:456'));
  assert.ok(revisionClauses(filter).some((clause) => hasExactRevision(clause, 8)));
  assert.deepEqual(update.$unset, { operationMarker: 1 });
  assert.deepEqual(update.$inc, { revision: 1 });
});

test('full marker clearing requires operation type and renewal payload ownership', async () => {
  const model = makeModel();
  const renewal = {
    oldEndDate: new Date('2027-01-01T00:00:00.000Z'),
    newEndDate: new Date('2029-01-01T00:00:00.000Z'),
    renewedBy: '64b000000000000000000003',
    notes: null,
    committedRevision: 5
  };
  await compareAndSetContract({
    model,
    contractId,
    expectedRevision: 5,
    clearOperationMarker: { operationId: 'renewal-123', operationType: 'Renewal', renewal }
  });
  const clauses = model.calls[0][0].$and;
  assert.ok(clauses.some((clause) => clause['operationMarker.operationId'] === 'renewal-123'));
  assert.ok(clauses.some((clause) => clause['operationMarker.operationType'] === 'Renewal'));
  assert.ok(clauses.some((clause) => clause['operationMarker.renewal.committedRevision'] === 5));
  assert.deepEqual(model.calls[0][1].$unset, { operationMarker: 1 });
});

test('wrong-operation-ID marker clear cannot match another operation', async () => {
  const model = {
    calls: [],
    async findOneAndUpdate(filter, update) {
      this.calls.push({ filter, update });
      const markerMatch = filter.$and.find((clause) => clause['operationMarker.operationId']);
      return markerMatch['operationMarker.operationId'] === 'other-operation' ? { revision: 4 } : null;
    }
  };

  const result = await compareAndSetContract({
    model,
    contractId,
    expectedRevision: 4,
    clearOperationId: 'requested-operation'
  });

  assert.equal(result, null);
  assert.equal(model.calls.length, 1);
  assert.equal(
    model.calls[0].filter.$and.find((clause) => clause['operationMarker.operationId'])['operationMarker.operationId'],
    'requested-operation'
  );
});

test('stale revision cannot clear a matching operation marker', async () => {
  const model = {
    calls: [],
    async findOneAndUpdate(filter, update) {
      this.calls.push({ filter, update });
      return null;
    }
  };

  const result = await compareAndSetContract({
    model,
    contractId,
    expectedRevision: 3,
    clearOperationId: 'current-operation'
  });

  assert.equal(result, null);
  assert.equal(model.calls.length, 1);
  assert.ok(revisionClauses(model.calls[0].filter).some((clause) => hasExactRevision(clause, 3)));
  assert.ok(model.calls[0].filter.$and.some((clause) => clause['operationMarker.operationId'] === 'current-operation'));
});

test('CAS helper does not permit patches to bypass reserved revision or marker fields', async () => {
  const model = makeModel();

  for (const set of [
    { revision: 99 },
    { __v: 99 },
    { operationMarker: null },
    { 'operationMarker.operationId': 'other-operation' },
    { $set: { title: 'Injected update' } }
  ]) {
    await assert.rejects(
      compareAndSetContract({ model, contractId, expectedRevision: 0, set }),
      InvalidContractPatchError
    );
  }
  assert.equal(model.calls.length, 0);
});
