const assert = require('node:assert/strict');
const test = require('node:test');

const Contract = require('../models/Contract');
const Approval = require('../models/Approval');
const ContractAmendment = require('../models/ContractAmendment');
const Renewal = require('../models/Renewal');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const approvalRoutes = require('../routes/approvalRoutes');
const amendmentRoutes = require('../routes/amendmentRoutes');
const renewalRoutes = require('../routes/renewalRoutes');
const expireEligibleContracts = require('../utils/expiryUpdater');
const {
  areRenewalOperationsReady,
  setRenewalOperationsReady
} = require('../utils/renewalReadiness');

const contractId = '64b000000000000000000001';
const requesterId = '64b000000000000000000002';
const manager = { _id: '64b000000000000000000003', role: 'Manager' };

const contract = (overrides = {}) => ({
  _id: contractId,
  contractNumber: 'CNT-TEST-1',
  status: 'Active',
  isArchived: false,
  revision: 4,
  createdBy: requesterId,
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2027-01-01T00:00:00.000Z'),
  amount: 100,
  ...overrides
});

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

const assertUnarchivedClause = (filter) => {
  assert.ok(filter.$and.some((clause) => (
    JSON.stringify(clause) === JSON.stringify({ $or: [{ isArchived: false }, { isArchived: null }] })
  )));
};

const routeHandler = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;

const routeLayers = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack;

const submitApprovalHandler = routeHandler(approvalRoutes, '/submit/:contractId', 'post');
const decideApprovalHandler = routeHandler(approvalRoutes, '/:id/action', 'put');
const decideAmendmentHandler = routeHandler(amendmentRoutes, '/:id/action', 'put');
const renewHandler = routeHandler(renewalRoutes, '/renew/:contractId', 'post');
const recoverRenewalHandler = routeHandler(renewalRoutes, '/recover/:contractId', 'post');
const renewRouteLayers = routeLayers(renewalRoutes, '/renew/:contractId', 'post');
const recoverRenewalRouteLayers = routeLayers(renewalRoutes, '/recover/:contractId', 'post');

const invokeRouteStack = async (layers, req, res) => {
  let nextLayer = 0;
  const dispatch = async (error) => {
    if (error) throw error;
    const layer = layers[nextLayer++];
    if (!layer) return;
    let nextPromise;
    const next = (nextError) => {
      nextPromise = dispatch(nextError);
      return nextPromise;
    };
    const result = layer.handle(req, res, next);
    if (result && typeof result.then === 'function') await result;
    if (nextPromise) await nextPromise;
  };
  await dispatch();
};

const withModelMocks = async (mocks, callback) => {
  const originals = new Map(Object.keys(mocks).map((key) => {
    const [modelName, method] = key.split('.');
    const model = { Contract, Approval, ContractAmendment, Renewal, ActivityLog, User }[modelName];
    return [key, { model, method, value: model[method] }];
  }));
  for (const [key, mock] of Object.entries(mocks)) {
    const [modelName, method] = key.split('.');
    const model = { Contract, Approval, ContractAmendment, Renewal, ActivityLog, User }[modelName];
    model[method] = mock;
  }
  try {
    await callback();
  } finally {
    for (const { model, method, value } of originals.values()) model[method] = value;
  }
};

const withRouteAuth = async (role, callback) => {
  const originalVerify = jwt.verify;
  try {
    jwt.verify = () => ({ id: renewalActor, tokenVersion: 0 });
    await withModelMocks({
      'User.findById': () => ({
        select: async () => ({
          _id: renewalActor, role, status: 'Active', tokenVersion: 0
        })
      })
    }, callback);
  } finally {
    jwt.verify = originalVerify;
  }
};

const withRenewalOperationsReady = async (callback) => {
  const wasReady = areRenewalOperationsReady();
  setRenewalOperationsReady(true);
  try {
    await callback();
  } finally {
    setRenewalOperationsReady(wasReady);
  }
};

test('approval submission uses revision CAS and preserves state on conflict', async () => {
  const current = contract({ status: 'Draft' });
  let casFilter;
  let created = 0;
  await withModelMocks({
    'Contract.findById': async () => current,
    'Contract.findOneAndUpdate': async (filter) => {
      casFilter = filter;
      return null;
    },
    'Approval.findOne': async () => null,
    'Approval.create': async () => { created += 1; }
  }, async () => {
    const res = response();
    await submitApprovalHandler(
      { params: { contractId }, user: manager },
      res,
      (error) => { throw error; }
    );

    assert.equal(res.statusCode, 409);
    assert.equal(created, 0);
    assert.ok(casFilter.$and.some((clause) => clause.status === 'Draft'));
    assertUnarchivedClause(casFilter);
    assert.equal(casFilter._id, contractId);
  });
});

test('approval decision restores the pending claim when contract CAS is stale', async () => {
  let restored;
  await withModelMocks({
    'Approval.findById': async () => ({
      _id: '64b000000000000000000010',
      contract: contractId,
      requestedBy: requesterId,
      status: 'Pending'
    }),
    'Approval.findOneAndUpdate': async (_filter, update) => ({
      _id: '64b000000000000000000010',
      ...update.$set
    }),
    'Approval.updateOne': async (filter, update) => { restored = { filter, update }; return { matchedCount: 1 }; },
    'Contract.findById': async () => contract({ status: 'Pending Approval' }),
    'Contract.findOneAndUpdate': async () => null
  }, async () => {
    const res = response();
    await decideApprovalHandler(
      { params: { id: '64b000000000000000000010' }, body: { action: 'Approved' }, user: manager },
      res,
      (error) => { throw error; }
    );

    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /remains pending/);
    assert.equal(restored.filter.status, 'Approved');
    assert.equal(restored.update.$set.status, 'Pending');
    assert.deepEqual(Object.keys(restored.update.$unset).sort(), ['approver', 'comments', 'decisionDate']);
  });
});

test('approval decision reports a structured error when restoration throws', async () => {
  const restoreError = Object.assign(new Error('storage unavailable'), { code: 'DB_DOWN' });
  const originalConsoleError = console.error;
  let forwarded;
  try {
    console.error = () => {};
    await withModelMocks({
      'Approval.findById': async () => ({ _id: 'approval-restore-fail', contract: contractId, requestedBy: requesterId, status: 'Pending' }),
      'Approval.findOneAndUpdate': async (_filter, update) => ({ _id: 'approval-restore-fail', ...update.$set }),
      'Approval.updateOne': async () => { throw restoreError; },
      'Contract.findById': async () => contract({ status: 'Pending Approval' }),
      'Contract.findOneAndUpdate': async () => null
    }, async () => {
      const res = response();
      await decideApprovalHandler(
        { params: { id: 'approval-restore-fail' }, body: { action: 'Approved' }, user: manager },
        res,
        (error) => { forwarded = error; }
      );
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.code, 'DECISION_COMPENSATION_FAILED');
      assert.equal(res.body.decisionRestored, false);
      assert.equal(forwarded, undefined);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('approval restoration filter leaves a concurrent decision unchanged', async () => {
  let decisionStatus = 'Rejected';
  let restorationFilter;
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    await withModelMocks({
      'Approval.findById': async () => ({ _id: 'approval-concurrent', contract: contractId, requestedBy: requesterId, status: 'Pending' }),
      'Approval.findOneAndUpdate': async (_filter, update) => ({ _id: 'approval-concurrent', ...update.$set }),
      'Approval.updateOne': async (filter, update) => {
        restorationFilter = filter;
        if (decisionStatus !== filter.status) return { matchedCount: 0 };
        decisionStatus = update.$set.status;
        return { matchedCount: 1 };
      },
      'Contract.findById': async () => contract({ status: 'Pending Approval' }),
      'Contract.findOneAndUpdate': async () => null
    }, async () => {
      const res = response();
      await decideApprovalHandler(
        { params: { id: 'approval-concurrent' }, body: { action: 'Approved' }, user: manager },
        res,
        (error) => { throw error; }
      );
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.code, 'DECISION_COMPENSATION_FAILED');
      assert.equal(restorationFilter.status, 'Approved');
      assert.equal(decisionStatus, 'Rejected');
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('approved amendment applies its patch through the contract revision CAS', async () => {
  let cas;
  const decidedAmendment = {
    _id: '64b000000000000000000020',
    status: 'Approved',
    decisionComments: null,
    proposed: { amount: 200 },
    before: { amount: 100 },
    toObject() {
      return { _id: this._id, status: this.status, proposed: this.proposed, before: this.before };
    }
  };
  await withModelMocks({
    'ContractAmendment.findById': async () => ({
      _id: decidedAmendment._id,
      contract: contractId,
      requestedBy: requesterId,
      status: 'Pending',
      proposed: { amount: 200 },
      before: { amount: 100 }
    }),
    'ContractAmendment.findOneAndUpdate': async () => decidedAmendment,
    'Contract.findById': async () => contract(),
    'Contract.findOneAndUpdate': async (filter, update) => {
      cas = { filter, update };
      return { ...contract(), ...update.$set, revision: 5 };
    },
    'ActivityLog.create': async () => ({})
  }, async () => {
    const res = response();
    await decideAmendmentHandler(
      { params: { id: decidedAmendment._id }, body: { action: 'Approved' }, user: manager },
      res,
      (error) => { throw error; }
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(cas.update.$set, { amount: 200 });
    assert.deepEqual(cas.update.$inc, { revision: 1 });
    assert.ok(cas.filter.$and.some((clause) => clause.status === 'Active'));
    assertUnarchivedClause(cas.filter);
  });
});

test('stale approved amendment is restored to Pending', async () => {
  let restored;
  const amendmentId = '64b000000000000000000021';
  await withModelMocks({
    'ContractAmendment.findById': async () => ({
      _id: amendmentId,
      contract: contractId,
      requestedBy: requesterId,
      status: 'Pending',
      proposed: { amount: 200 },
      before: { amount: 100 }
    }),
    'ContractAmendment.findOneAndUpdate': async () => ({ _id: amendmentId }),
    'ContractAmendment.updateOne': async (filter, update) => { restored = { filter, update }; return { matchedCount: 1 }; },
    'Contract.findById': async () => contract(),
    'Contract.findOneAndUpdate': async () => null
  }, async () => {
    const res = response();
    await decideAmendmentHandler(
      { params: { id: amendmentId }, body: { action: 'Approved' }, user: manager },
      res,
      (error) => { throw error; }
    );

    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /remains pending/);
    assert.equal(restored.filter.status, 'Approved');
    assert.deepEqual(restored.update.$set, {
      status: 'Pending',
      decidedBy: null,
      decisionComments: null,
      decidedAt: null
    });
  });
});

test('amendment decision reports a structured error when restoration throws', async () => {
  const amendmentId = 'amendment-restore-fail';
  const restoreError = Object.assign(new Error('storage unavailable'), { code: 'DB_DOWN' });
  const originalConsoleError = console.error;
  let forwarded;
  try {
    console.error = () => {};
    await withModelMocks({
      'ContractAmendment.findById': async () => ({
        _id: amendmentId, contract: contractId, requestedBy: requesterId, status: 'Pending',
        proposed: { amount: 200 }, before: { amount: 100 }
      }),
      'ContractAmendment.findOneAndUpdate': async () => ({ _id: amendmentId }),
      'ContractAmendment.updateOne': async () => { throw restoreError; },
      'Contract.findById': async () => contract(),
      'Contract.findOneAndUpdate': async () => null
    }, async () => {
      const res = response();
      await decideAmendmentHandler(
        { params: { id: amendmentId }, body: { action: 'Approved' }, user: manager },
        res,
        (error) => { forwarded = error; }
      );
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.code, 'DECISION_COMPENSATION_FAILED');
      assert.equal(res.body.decisionRestored, false);
      assert.equal(forwarded, undefined);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('amendment restoration filter leaves a concurrent decision unchanged', async () => {
  const amendmentId = 'amendment-concurrent';
  let decisionStatus = 'Rejected';
  let restorationFilter;
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    await withModelMocks({
      'ContractAmendment.findById': async () => ({
        _id: amendmentId, contract: contractId, requestedBy: requesterId, status: 'Pending',
        proposed: { amount: 200 }, before: { amount: 100 }
      }),
      'ContractAmendment.findOneAndUpdate': async () => ({ _id: amendmentId }),
      'ContractAmendment.updateOne': async (filter, update) => {
        restorationFilter = filter;
        if (decisionStatus !== filter.status) return { matchedCount: 0 };
        decisionStatus = update.$set.status;
        return { matchedCount: 1 };
      },
      'Contract.findById': async () => contract(),
      'Contract.findOneAndUpdate': async () => null
    }, async () => {
      const res = response();
      await decideAmendmentHandler(
        { params: { id: amendmentId }, body: { action: 'Approved' }, user: manager },
        res,
        (error) => { throw error; }
      );
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.code, 'DECISION_COMPENSATION_FAILED');
      assert.equal(restorationFilter.status, 'Approved');
      assert.equal(decisionStatus, 'Rejected');
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('renewal does not create history when the contract CAS loses', async () => {
  let createdRenewal = false;
  let cas;
  await withModelMocks({
    'Contract.findById': async () => contract({
      status: 'Expired',
      endDate: new Date('2025-01-01T00:00:00.000Z')
    }),
    'Contract.findOneAndUpdate': async (filter, update) => {
      cas = { filter, update };
      return null;
    },
    'Renewal.findOne': async () => null,
    'Renewal.create': async () => { createdRenewal = true; }
  }, async () => {
    const res = response();
    await renewHandler(
      {
        params: { contractId },
        body: { newEndDate: '2099-01-01T00:00:00.000Z' },
        user: manager
      },
      res,
      (error) => { throw error; }
    );

    assert.equal(res.statusCode, 409);
    assert.equal(createdRenewal, false);
    assert.deepEqual(cas.update.$inc, { revision: 1 });
    assert.ok(cas.filter.$and.some((clause) => clause.status === 'Expired'));
    assertUnarchivedClause(cas.filter);
  });
});

const renewalOperationId = 'renewal-op-001';
const renewalActor = '64b000000000000000000003';
const requestedNewEndDate = new Date('2099-01-01T00:00:00.000Z');
const clone = (value) => value && structuredClone(value);

const makeRenewalState = () => ({
  contract: contract({ status: 'Expired', endDate: new Date('2025-01-01T00:00:00.000Z') }),
  history: null,
  activities: new Map(),
  failHistory: false,
  duplicateHistoryOnce: false,
  casApplications: 0,
  historyWrites: 0
});

const renewalMocks = (state) => ({
  'Contract.findById': async () => clone(state.contract),
  'Contract.findOneAndUpdate': async (filter, update) => {
    if (update.$set?.operationMarker) {
      state.casApplications += 1;
      const marker = update.$set.operationMarker;
      assert.equal(marker.operationType, 'Renewal');
      assert.equal(marker.operationId, renewalOperationId);
      assert.equal(marker.renewal.oldEndDate.getTime(), state.contract.endDate.getTime());
      assert.equal(marker.renewal.newEndDate.getTime(), requestedNewEndDate.getTime());
      assert.equal(marker.renewal.renewedBy, renewalActor);
      assert.equal(marker.renewal.notes, 'Extension');
      assert.equal(marker.renewal.committedRevision, state.contract.revision + 1);
      state.contract = {
        ...state.contract,
        ...clone(update.$set),
        revision: state.contract.revision + update.$inc.revision
      };
      return clone(state.contract);
    }
    if (update.$unset?.operationMarker) {
      const clauses = filter.$and;
      const archiveClause = clauses.find((clause) => clause.$or?.some((part) => Object.hasOwn(part, 'isArchived')));
      assert.deepEqual(archiveClause, { $or: [{ isArchived: false }, { isArchived: null }] });
      const matches = clauses.some((clause) => clause['operationMarker.operationId'] === renewalOperationId)
        && clauses.some((clause) => clause['operationMarker.operationType'] === 'Renewal')
        && clauses.some((clause) => clause['operationMarker.renewal.newEndDate']?.getTime?.() === requestedNewEndDate.getTime());
      if (!matches || state.contract.operationMarker?.operationId !== renewalOperationId) return null;
      const next = { ...state.contract, revision: state.contract.revision + update.$inc.revision };
      delete next.operationMarker;
      state.contract = next;
      return clone(next);
    }
    return null;
  },
  'Renewal.findOne': async ({ operationId }) =>
    state.history?.operationId === operationId ? clone(state.history) : null,
  'Renewal.findOneAndUpdate': async (filter, update, options) => {
    assert.equal(options.upsert, true);
    state.historyWrites += 1;
    if (state.failHistory) throw new Error('mock renewal history failure');
    if (state.duplicateHistoryOnce) {
      state.duplicateHistoryOnce = false;
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    if (!state.history) {
      state.history = { _id: 'renewal-history-1', ...clone(update.$setOnInsert) };
    }
    return clone(state.history);
  },
  'ActivityLog.findOneAndUpdate': async (filter, update, options) => {
    assert.equal(options.upsert, true);
    const key = filter.operationId;
    if (!state.activities.has(key)) state.activities.set(key, clone(update.$setOnInsert));
    return clone(state.activities.get(key));
  }
});

const concurrentRenewalMocks = (state, { holdHistory = false } = {}) => {
  let initialLookups = 0;
  let releaseInitialLookups;
  const initialLookupGate = new Promise((resolve) => { releaseInitialLookups = resolve; });
  let signalHistoryStarted;
  const historyStarted = new Promise((resolve) => { signalHistoryStarted = resolve; });
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });

  const mocks = {
    'Contract.findById': async () => clone(state.contract),
    'Contract.findOneAndUpdate': async (filter, update) => {
      if (update.$set?.operationMarker) {
        state.casAttempts += 1;
        if (state.contract.revision !== 4 || state.contract.operationMarker) return null;
        state.successfulCas += 1;
        state.contract = {
          ...state.contract,
          ...clone(update.$set),
          revision: state.contract.revision + update.$inc.revision
        };
        return clone(state.contract);
      }

      if (update.$unset?.operationMarker) {
        const markerId = filter.$and.find((clause) => clause['operationMarker.operationId'])?.['operationMarker.operationId'];
        if (!markerId || state.contract.operationMarker?.operationId !== markerId) return null;
        const next = { ...state.contract, revision: state.contract.revision + update.$inc.revision };
        delete next.operationMarker;
        state.contract = next;
        return clone(next);
      }
      return null;
    },
    'Renewal.findOne': async ({ operationId }) => {
      if (initialLookups < 2) {
        const initial = state.history?.operationId === operationId ? clone(state.history) : null;
        initialLookups += 1;
        if (initialLookups === 2) releaseInitialLookups();
        await initialLookupGate;
        return initial;
      }
      return state.history?.operationId === operationId ? clone(state.history) : null;
    },
    'Renewal.findOneAndUpdate': async (_filter, update, options) => {
      assert.equal(options.upsert, true);
      state.historyWrites += 1;
      signalHistoryStarted();
      if (holdHistory) await historyGate;
      const payload = clone(update.$setOnInsert);
      if (!state.history) state.history = { _id: 'renewal-history-1', ...payload };
      if (state.history.operationId !== payload.operationId) {
        throw Object.assign(new Error('duplicate operation id'), { code: 11000 });
      }
      return clone(state.history);
    },
    'ActivityLog.findOneAndUpdate': async (filter, update, options) => {
      assert.equal(options.upsert, true);
      if (!state.activities.has(filter.operationId)) {
        state.activities.set(filter.operationId, clone(update.$setOnInsert));
      }
      return clone(state.activities.get(filter.operationId));
    }
  };
  return { mocks, historyStarted, releaseHistory };
};

test('normal renewal persists marker, unique history and idempotent activity, then clears its marker', async () => {
  const state = makeRenewalState();
  await withModelMocks(renewalMocks(state), async () => {
    const res = response();
    await renewHandler({
      params: { contractId },
      body: { newEndDate: requestedNewEndDate.toISOString(), notes: ' Extension ', operationId: renewalOperationId },
      user: { _id: renewalActor, role: 'Admin' }, headers: {}
    }, res, (error) => { throw error; });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.operationId, renewalOperationId);
    assert.equal(state.casApplications, 1);
    assert.equal(state.historyWrites, 1);
    assert.equal(state.activities.size, 1);
    assert.equal(state.contract.revision, 6, 'renewal CAS and marker clear each advance revision');
    assert.equal(state.contract.operationMarker, undefined);
  });
});

test('competing same-key renewal requests share one successful CAS and one durable result', async () => {
  const state = {
    contract: makeRenewalState().contract,
    history: null,
    activities: new Map(),
    casAttempts: 0,
    successfulCas: 0,
    historyWrites: 0
  };
  const { mocks } = concurrentRenewalMocks(state);
  const request = () => ({
    params: { contractId },
    body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
    headers: { authorization: 'Bearer mock-token' }
  });

  await withRenewalOperationsReady(() => withRouteAuth('Manager', () => withModelMocks(mocks, async () => {
    const first = response();
    const second = response();
    await Promise.all([
      invokeRouteStack(renewRouteLayers, request(), first),
      invokeRouteStack(renewRouteLayers, request(), second)
    ]);

    assert.equal(state.casAttempts, 2, 'both contenders issue one conditional CAS attempt');
    assert.equal(state.successfulCas, 1, 'only one contender wins the renewal CAS');
    assert.equal(state.contract.revision, 6, 'the renewal and marker clear each increment once');
    assert.equal(state.historyWrites, 2, 'the losing request may safely finish the same marked operation');
    assert.equal(state.history.operationId, renewalOperationId);
    assert.equal(state.activities.size, 1);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.body.operationId, second.body.operationId);
    assert.equal(first.body._id, second.body._id);
    assert.equal(state.contract.operationMarker, undefined);
  })));
});

test('competing different renewal operations cannot write history or clear the winner marker', async () => {
  const state = {
    contract: makeRenewalState().contract,
    history: null,
    activities: new Map(),
    casAttempts: 0,
    successfulCas: 0,
    historyWrites: 0
  };
  const { mocks, historyStarted, releaseHistory } = concurrentRenewalMocks(state, { holdHistory: true });
  const request = (operationId) => ({
    params: { contractId },
    body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId },
    headers: { authorization: 'Bearer mock-token' }
  });

  await withRenewalOperationsReady(() => withRouteAuth('Manager', () => withModelMocks(mocks, async () => {
    const first = response();
    const second = response();
    const firstTask = invokeRouteStack(renewRouteLayers, request('renewal-op-first'), first);
    const secondTask = invokeRouteStack(renewRouteLayers, request('renewal-op-second'), second);
    await historyStarted;

    const settledLoser = await Promise.race([
      firstTask.then(() => ({ operationId: 'renewal-op-first', res: first })),
      secondTask.then(() => ({ operationId: 'renewal-op-second', res: second }))
    ]);
    assert.equal(settledLoser.res.statusCode, 409);
    assert.notEqual(state.contract.operationMarker.operationId, settledLoser.operationId);
    assert.equal(state.successfulCas, 1);
    assert.equal(state.history, null, 'winner history remains held while the loser is checked');
    assert.ok(state.contract.operationMarker, 'the losing operation cannot clear the winner marker');

    releaseHistory();
    await Promise.all([firstTask, secondTask]);
    const winnerId = state.contract.operationMarker?.operationId || state.history.operationId;
    const winnerResponse = winnerId === 'renewal-op-first' ? first : second;
    const loserResponse = winnerId === 'renewal-op-first' ? second : first;
    assert.equal(winnerResponse.statusCode, 201);
    assert.equal(loserResponse.statusCode, 409);
    assert.equal(state.casAttempts, 2);
    assert.equal(state.successfulCas, 1);
    assert.equal(state.historyWrites, 1);
    assert.equal(state.history.operationId, winnerId);
    assert.equal(state.activities.size, 1);
    assert.equal(state.contract.revision, 6);
    assert.equal(state.contract.operationMarker, undefined);
  })));
});

test('history failure retains the marked renewal and same-key retry recovers without renewing twice', async () => {
  const state = makeRenewalState();
  state.failHistory = true;
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    await withModelMocks(renewalMocks(state), async () => {
      const first = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, first, (error) => { throw error; });
      assert.equal(first.statusCode, 503);
      assert.equal(first.body.code, 'RENEWAL_HISTORY_PENDING');
      assert.equal(state.contract.operationMarker.operationId, renewalOperationId);
      assert.equal(state.contract.endDate.getTime(), requestedNewEndDate.getTime());

      state.failHistory = false;
      const retry = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, retry, (error) => { throw error; });
      assert.equal(retry.statusCode, 201);
      assert.equal(state.casApplications, 1, 'retry must not apply the contract renewal CAS again');
      assert.equal(state.historyWrites, 2);
      assert.equal(state.contract.revision, 6);
      assert.equal(state.contract.operationMarker, undefined);
      assert.equal(state.activities.size, 1);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('same operation ID with a different payload or actor is rejected', async (t) => {
  for (const variation of [
    { label: 'payload', notes: 'Different notes', actor: renewalActor },
    { label: 'actor', notes: 'Extension', actor: '64b000000000000000000099' }
  ]) {
    await t.test(variation.label, async () => {
      const state = makeRenewalState();
      state.contract.operationMarker = {
        operationId: renewalOperationId,
        operationType: 'Renewal',
        renewal: {
          oldEndDate: state.contract.endDate,
          newEndDate: requestedNewEndDate,
          renewedBy: renewalActor,
          notes: 'Extension',
          committedRevision: 5
        }
      };
      state.contract.status = 'Active';
      state.contract.endDate = requestedNewEndDate;
      state.contract.revision = 5;
      await withModelMocks(renewalMocks(state), async () => {
        const res = response();
        await renewHandler({
          params: { contractId },
          body: { newEndDate: requestedNewEndDate.toISOString(), notes: variation.notes, operationId: renewalOperationId },
          user: { _id: variation.actor, role: 'Admin' }, headers: {}
        }, res, (error) => { throw error; });
        assert.equal(res.statusCode, 409);
        assert.equal(state.historyWrites, 0);
        assert.equal(state.contract.operationMarker.operationId, renewalOperationId);
      });
    });
  }
});

test('existing history prevents duplicate renewal and activity writes on same-key retry', async () => {
  const state = makeRenewalState();
  state.history = {
    _id: 'renewal-history-existing', contract: contractId, operationId: renewalOperationId,
    oldEndDate: state.contract.endDate, newEndDate: requestedNewEndDate,
    renewedBy: renewalActor, notes: 'Extension'
  };
  await withModelMocks(renewalMocks(state), async () => {
    const res = response();
    await renewHandler({
      params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
      user: { _id: renewalActor, role: 'Admin' }, headers: {}
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(state.casApplications, 0);
    assert.equal(state.historyWrites, 0);
    assert.equal(state.activities.size, 1);

    const retry = response();
    await renewHandler({
      params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
      user: { _id: renewalActor, role: 'Admin' }, headers: {}
    }, retry, (error) => { throw error; });
    assert.equal(retry.statusCode, 201);
    assert.equal(state.activities.size, 1, 'operation-key upsert prevents duplicate activity logs');
  });
});

test('activity logging remains best-effort and same-key retry can fill a missing log', async () => {
  const state = makeRenewalState();
  let activityAttempts = 0;
  const mocks = renewalMocks(state);
  mocks['ActivityLog.findOneAndUpdate'] = async (filter, update, options) => {
    activityAttempts += 1;
    if (activityAttempts === 1) throw new Error('mock activity store unavailable');
    const key = filter.operationId;
    if (!state.activities.has(key)) state.activities.set(key, clone(update.$setOnInsert));
    return clone(state.activities.get(key));
  };
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    await withModelMocks(mocks, async () => {
      const first = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, first, (error) => { throw error; });
      assert.equal(first.statusCode, 201);
      assert.equal(state.contract.operationMarker, undefined, 'best-effort logging does not block durable renewal completion');
      assert.equal(state.activities.size, 0);

      const retry = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, retry, (error) => { throw error; });
      assert.equal(retry.statusCode, 201);
      assert.equal(activityAttempts, 2);
      assert.equal(state.activities.size, 1);
      assert.equal(state.casApplications, 1);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('durable history with a failed marker clear returns finalization status and retries safely', async () => {
  const state = makeRenewalState();
  const mocks = renewalMocks(state);
  const contractWrite = mocks['Contract.findOneAndUpdate'];
  mocks['Contract.findOneAndUpdate'] = async (filter, update, options) => {
    if (update.$unset?.operationMarker) return null;
    return contractWrite(filter, update, options);
  };
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    await withModelMocks(mocks, async () => {
      const first = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, first, (error) => { throw error; });
      assert.equal(first.statusCode, 503);
      assert.equal(first.body.code, 'RENEWAL_FINALIZATION_PENDING');
      assert.ok(state.history, 'history remains durable when marker clearing fails');
      assert.equal(state.contract.operationMarker.operationId, renewalOperationId);

      Contract.findOneAndUpdate = contractWrite;
      const retry = response();
      await renewHandler({
        params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
        user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, retry, (error) => { throw error; });
      assert.equal(retry.statusCode, 201);
      assert.equal(state.casApplications, 1);
      assert.equal(state.historyWrites, 2);
      assert.equal(state.contract.operationMarker, undefined);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('duplicate-key history race returns the matching durable row', async () => {
  const state = makeRenewalState();
  state.duplicateHistoryOnce = true;
  state.history = {
    _id: 'renewal-history-existing', contract: contractId, operationId: renewalOperationId,
    oldEndDate: new Date('2025-01-01T00:00:00.000Z'), newEndDate: requestedNewEndDate,
    renewedBy: renewalActor, notes: 'Extension'
  };
  const mocks = renewalMocks(state);
  let firstLookup = true;
  mocks['Renewal.findOne'] = async () => {
    if (firstLookup) { firstLookup = false; return null; }
    return clone(state.history);
  };
  await withModelMocks(mocks, async () => {
    const res = response();
    await renewHandler({
      params: { contractId }, body: { newEndDate: requestedNewEndDate.toISOString(), notes: 'Extension', operationId: renewalOperationId },
      user: { _id: renewalActor, role: 'Admin' }, headers: {}
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(state.casApplications, 1);
    assert.equal(state.historyWrites, 1);
    assert.equal(state.contract.operationMarker, undefined);
  });
});

test('changed contract after history failure and stale marker are rejected without clearing or inserting history', async (t) => {
  await t.test('changed contract', async () => {
    const state = makeRenewalState();
    state.contract = {
      ...state.contract, status: 'Active', endDate: requestedNewEndDate,
      revision: 6,
      operationMarker: {
        operationId: renewalOperationId, operationType: 'Renewal', renewal: {
          oldEndDate: new Date('2025-01-01T00:00:00.000Z'), newEndDate: requestedNewEndDate,
          renewedBy: renewalActor, notes: 'Extension', committedRevision: 5
        }
      }
    };
    await withModelMocks(renewalMocks(state), async () => {
      const res = response();
      await recoverRenewalHandler({
        params: { contractId }, body: { operationId: renewalOperationId }, user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 409);
      assert.equal(state.historyWrites, 0);
      assert.equal(state.contract.operationMarker.operationId, renewalOperationId);
    });
  });
  await t.test('different marker owner', async () => {
    const state = makeRenewalState();
    state.contract.operationMarker = {
      operationId: 'another-operation', operationType: 'Renewal', renewal: {
        oldEndDate: state.contract.endDate, newEndDate: requestedNewEndDate,
        renewedBy: renewalActor, notes: 'Extension', committedRevision: 5
      }
    };
    state.contract.status = 'Active';
    state.contract.endDate = requestedNewEndDate;
    state.contract.revision = 5;
    await withModelMocks(renewalMocks(state), async () => {
      const res = response();
      await recoverRenewalHandler({
        params: { contractId }, body: { operationId: renewalOperationId }, user: { _id: renewalActor, role: 'Admin' }, headers: {}
      }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 409);
      assert.equal(state.historyWrites, 0);
      assert.equal(state.contract.operationMarker.operationId, 'another-operation');
    });
  });
});

test('Admin recovery completes a matching marked renewal and clears only that marker', async () => {
  const state = makeRenewalState();
  state.contract = {
    ...state.contract,
    status: 'Active',
    endDate: requestedNewEndDate,
    revision: 5,
    operationMarker: {
      operationId: renewalOperationId,
      operationType: 'Renewal',
      renewal: {
        oldEndDate: new Date('2025-01-01T00:00:00.000Z'),
        newEndDate: requestedNewEndDate,
        renewedBy: renewalActor,
        notes: 'Extension',
        committedRevision: 5
      }
    }
  };
  await withModelMocks(renewalMocks(state), async () => {
    const res = response();
    await recoverRenewalHandler({
      params: { contractId }, body: {},
      user: { _id: renewalActor, role: 'Admin' }, headers: {}
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(state.historyWrites, 1);
    assert.equal(state.history.operationId, renewalOperationId);
    assert.equal(state.contract.operationMarker, undefined);
    assert.equal(state.contract.revision, 6);
  });
});

test('renewal recovery accepts false, null, or missing archive flags and rejects true or unexpected values', async (t) => {
  const cases = [
    { label: 'false', value: false, succeeds: true },
    { label: 'null', value: null, succeeds: true },
    { label: 'missing', missing: true, succeeds: true },
    { label: 'true', value: true, succeeds: false },
    { label: 'unexpected value', value: 'false', succeeds: false }
  ];

  for (const item of cases) {
    await t.test(item.label, async () => {
      const state = makeRenewalState();
      state.contract = {
        ...state.contract,
        status: 'Active',
        endDate: requestedNewEndDate,
        revision: 5,
        operationMarker: {
          operationId: renewalOperationId,
          operationType: 'Renewal',
          renewal: {
            oldEndDate: new Date('2025-01-01T00:00:00.000Z'),
            newEndDate: requestedNewEndDate,
            renewedBy: renewalActor,
            notes: 'Extension',
            committedRevision: 5
          }
        }
      };
      if (item.missing) delete state.contract.isArchived;
      else state.contract.isArchived = item.value;

      await withModelMocks(renewalMocks(state), async () => {
        const res = response();
        await recoverRenewalHandler({
          params: { contractId }, body: { operationId: renewalOperationId },
          user: { _id: renewalActor, role: 'Admin' }, headers: {}
        }, res, (error) => { throw error; });

        assert.equal(res.statusCode, item.succeeds ? 201 : 409);
        assert.equal(state.historyWrites, item.succeeds ? 1 : 0);
        assert.equal(Boolean(state.contract.operationMarker), !item.succeeds);
      });
    });
  }
});

test('registered renewal recovery middleware requires authentication and Admin authorization', async () => {
  const request = (authorized = false) => ({
    params: { contractId },
    body: {},
    headers: authorized ? { authorization: 'Bearer mock-token' } : {}
  });

  const unauthenticated = response();
  await invokeRouteStack(recoverRenewalRouteLayers, request(), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const managerState = makeRenewalState();
  let managerContractReads = 0;
  const managerMocks = renewalMocks(managerState);
  managerMocks['Contract.findById'] = async () => {
    managerContractReads += 1;
    return clone(managerState.contract);
  };
  const managerResponse = response();
  await withRouteAuth('Manager', () => withModelMocks(managerMocks, () => (
    invokeRouteStack(recoverRenewalRouteLayers, request(true), managerResponse)
  )));
  assert.equal(managerResponse.statusCode, 403);
  assert.equal(managerContractReads, 0, 'authorization runs before recovery reads the contract');

  const adminState = makeRenewalState();
  adminState.contract = {
    ...adminState.contract,
    status: 'Active',
    endDate: requestedNewEndDate,
    revision: 5,
    operationMarker: {
      operationId: renewalOperationId,
      operationType: 'Renewal',
      renewal: {
        oldEndDate: new Date('2025-01-01T00:00:00.000Z'),
        newEndDate: requestedNewEndDate,
        renewedBy: renewalActor,
        notes: 'Extension',
        committedRevision: 5
      }
    }
  };
  const adminResponse = response();
  await withRenewalOperationsReady(() => withRouteAuth('Admin', () => withModelMocks(renewalMocks(adminState), () => (
    invokeRouteStack(recoverRenewalRouteLayers, request(true), adminResponse)
  ))));
  assert.equal(adminResponse.statusCode, 201);
  assert.equal(adminState.history.operationId, renewalOperationId);
  assert.equal(adminState.contract.operationMarker, undefined);
});

test('expiry increments revision and retains active/unarchived write guards', async () => {
  let cas;
  const expiredCandidate = contract({
    status: 'Active',
    endDate: new Date('2000-01-01T00:00:00.000Z')
  });
  await withModelMocks({
    'Contract.find': () => ({ select: async () => [expiredCandidate] }),
    'Contract.findOneAndUpdate': async (filter, update) => {
      cas = { filter, update };
      return { ...expiredCandidate, ...update.$set, revision: 5 };
    },
    'ActivityLog.create': async () => ({})
  }, async () => {
    assert.deepEqual(await expireEligibleContracts(), { expired: 1 });
    assert.deepEqual(cas.update.$set, { status: 'Expired' });
    assert.deepEqual(cas.update.$inc, { revision: 1 });
    assert.ok(cas.filter.$and.some((clause) => clause.status === 'Active'));
    assertUnarchivedClause(cas.filter);
  });
});
