const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

const Contract = require('../models/Contract');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const contractRoutes = require('../routes/contractRoutes');

const contractId = '64b000000000000000000001';
const previousAssigneeId = '64b000000000000000000002';
const nextAssigneeId = '64b000000000000000000003';
const updateHandler = contractRoutes.stack
  .find((layer) => layer.route?.path === '/:id' && layer.route.methods.put)
  .route.stack.at(-1).handle;

const makeContract = (overrides = {}) => ({
  _id: contractId,
  contractNumber: 'CNT-2026-0001',
  title: 'Original title',
  type: 'NDA',
  partyName: 'Example Party',
  description: 'Keep this description',
  currency: 'USD',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2027-01-01T00:00:00.000Z'),
  amount: 500,
  assignedUser: null,
  createdBy: '64b000000000000000000004',
  status: 'Draft',
  isArchived: false,
  revision: 12,
  ...overrides
});

const invokeUpdate = async ({ body = {}, user = { _id: '64b000000000000000000005', role: 'Admin' } } = {}) => {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  let forwardedError;
  await updateHandler(
    { params: { id: contractId }, body, user },
    response,
    (error) => { forwardedError = error; }
  );
  return { response, forwardedError };
};

const withUpdateMocks = async ({
  contract = makeContract(),
  updateResult,
  auditWrite,
  userFindError,
  usersById = new Map(),
  people = []
} = {}, callback) => {
  const originals = {
    findById: Contract.findById,
    findOneAndUpdate: Contract.findOneAndUpdate,
    userFindById: User.findById,
    userFind: User.find,
    createActivity: ActivityLog.create
  };
  const calls = { updates: [], audits: [] };
  Contract.findById = async () => contract;
  Contract.findOneAndUpdate = async (filter, update, options) => {
    calls.updates.push({ filter, update, options });
    if (updateResult !== undefined) return updateResult;
    return { ...contract, ...update.$set, revision: (contract.revision ?? 0) + 1 };
  };
  User.findById = (id) => ({
    select: async () => usersById.get(String(id)) || null
  });
  User.find = () => {
    if (userFindError) throw userFindError;
    return { select: async () => people };
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
    User.findById = originals.userFindById;
    User.find = originals.userFind;
    ActivityLog.create = originals.createActivity;
  }
};

test('direct update uses the read revision and writes only the requested patch', async () => {
  await withUpdateMocks({}, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.title, 'Renamed');
    assert.equal(response.body.description, 'Keep this description');
    assert.equal(calls.updates.length, 1);
    const { filter, update } = calls.updates[0];
    assert.equal(filter._id, contractId);
    assert.ok(filter.$and.some((clause) => clause.$and?.some((part) => part.revision === 12)));
    assert.deepEqual(update.$set, { title: 'Renamed' });
    assert.deepEqual(update.$inc, { revision: 1 });
    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, 'Contract Updated');
  });
});

test('direct update returns 409 without retry or audit when CAS is stale', async () => {
  await withUpdateMocks({ updateResult: null }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /updated by another request/);
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.audits.length, 0);
  });
});

test('direct update preserves validation failures before attempting CAS', async () => {
  await withUpdateMocks({}, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { amount: true } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /Amount must be a non-negative number/);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.audits.length, 0);
  });
});

test('direct update rejects a null stored revision before issuing a write', async () => {
  await withUpdateMocks({ contract: makeContract({ revision: null }) }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

    assert.equal(forwardedError?.name, 'InvalidContractRevisionError');
    assert.equal(response.body, undefined);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.audits.length, 0);
  });
});

test('direct update maps an absent legacy revision to logical zero', async () => {
  const contract = makeContract();
  delete contract.revision;
  await withUpdateMocks({ contract }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 200);
    const revisionFilter = calls.updates[0].filter.$and.find((clause) => clause.$or);
    assert.ok(revisionFilter.$or.some((part) => part.revision?.$exists === false));
  });
});

test('assignee reassignment remains in the CAS patch and keeps both audit events', async () => {
  const previousAssignee = new mongoose.Types.ObjectId(previousAssigneeId);
  const nextAssignee = new mongoose.Types.ObjectId(nextAssigneeId);
  const usersById = new Map([[nextAssigneeId, { _id: nextAssignee }]]);
  const people = [
    { _id: previousAssignee, name: 'Previous Person' },
    { _id: nextAssignee, name: 'Next Person' }
  ];
  await withUpdateMocks({
    contract: makeContract({ assignedUser: previousAssignee }),
    usersById,
    people
  }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { assignedUser: nextAssigneeId } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 200);
    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.updates[0].update.$set.assignedUser, nextAssignee);
    assert.deepEqual(calls.audits.map((entry) => entry.action), ['Contract Updated', 'Contract Reassigned']);
    assert.equal(calls.audits[1].previousUser, previousAssigneeId);
    assert.equal(calls.audits[1].targetUser, nextAssigneeId);
  });
});

test('first activity failure reports the committed Contract and unconfirmed audit state', async () => {
  const auditError = new Error('activity storage unavailable');
  await withUpdateMocks({ auditWrite: async () => { throw auditError; } }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.contractUpdated, true);
    assert.equal(response.body.auditStatus, 'not_confirmed');
    assert.match(response.body.message, /was not rolled back/);
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.audits.length, 1);
  });
});

test('throwing diagnostic logger does not prevent the structured post-CAS response', async () => {
  const originalConsoleError = console.error;
  try {
    await withUpdateMocks({ auditWrite: async () => { throw new Error('activity storage unavailable'); } }, async (calls) => {
      console.error = () => { throw new Error('diagnostic sink unavailable'); };
      const { response, forwardedError } = await invokeUpdate({ body: { title: 'Renamed' } });

      assert.equal(forwardedError, undefined);
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.body, {
        message: 'Contract update was committed, but required activity logging did not complete successfully. Audit records may be incomplete; the Contract update was not rolled back.',
        contractUpdated: true,
        auditStatus: 'not_confirmed'
      });
      assert.equal(calls.updates.length, 1);
      assert.equal(calls.audits.length, 1);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('assignee-name lookup failure reports the committed reassignment and incomplete audit', async () => {
  const previousAssignee = new mongoose.Types.ObjectId(previousAssigneeId);
  const nextAssignee = new mongoose.Types.ObjectId(nextAssigneeId);
  const usersById = new Map([[nextAssigneeId, { _id: nextAssignee }]]);
  const lookupError = new Error('user directory unavailable');
  await withUpdateMocks({
    contract: makeContract({ assignedUser: previousAssignee }),
    usersById,
    userFindError: lookupError
  }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { assignedUser: nextAssigneeId } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.contractUpdated, true);
    assert.equal(response.body.auditStatus, 'not_confirmed');
    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.audits.map((entry) => entry.action), ['Contract Updated']);
  });
});

test('reassignment audit insertion failure reports the committed Contract without success', async () => {
  const previousAssignee = new mongoose.Types.ObjectId(previousAssigneeId);
  const nextAssignee = new mongoose.Types.ObjectId(nextAssigneeId);
  const usersById = new Map([[nextAssigneeId, { _id: nextAssignee }]]);
  const people = [
    { _id: previousAssignee, name: 'Previous Person' },
    { _id: nextAssignee, name: 'Next Person' }
  ];
  const reassignmentAuditError = new Error('reassignment audit unavailable');
  await withUpdateMocks({
    contract: makeContract({ assignedUser: previousAssignee }),
    usersById,
    people,
    auditWrite: async (entry) => {
      if (entry.action === 'Contract Reassigned') throw reassignmentAuditError;
      return entry;
    }
  }, async (calls) => {
    const { response, forwardedError } = await invokeUpdate({ body: { assignedUser: nextAssigneeId } });

    assert.equal(forwardedError, undefined);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.contractUpdated, true);
    assert.equal(response.body.auditStatus, 'not_confirmed');
    assert.match(response.body.message, /audit records may be incomplete/i);
    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.audits.map((entry) => entry.action), ['Contract Updated', 'Contract Reassigned']);
  });
});
