const assert = require('node:assert/strict');
const test = require('node:test');
const Contract = require('../models/Contract');
const Milestone = require('../models/Milestone');
const Obligation = require('../models/Obligation');

const objectId = '507f1f77bcf86cd799439011';

const contractData = {
  contractNumber: 'CNT-TEST-0001',
  title: 'Test contract',
  type: 'Vendor',
  partyName: 'Test party',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-12-31'),
  amount: 1000,
  createdBy: objectId
};

test('contract accepts a valid lifecycle status', () => {
  const contract = new Contract({ ...contractData, status: 'Pending Approval' });
  assert.equal(contract.validateSync(), undefined);
});

test('contract rejects an unknown lifecycle status', () => {
  const contract = new Contract({ ...contractData, status: 'Waiting' });
  assert.match(contract.validateSync().errors.status.message, /enum/);
});

test('milestone defaults to Pending', () => {
  const milestone = new Milestone({
    contract: objectId,
    title: 'Implementation kickoff',
    assignedTo: objectId,
    dueDate: new Date('2026-04-01')
  });
  assert.equal(milestone.status, 'Pending');
  assert.equal(milestone.validateSync(), undefined);
});

test('obligation rejects an unknown status', () => {
  const obligation = new Obligation({
    contract: objectId,
    title: 'Submit report',
    assignedTo: objectId,
    dueDate: new Date('2026-04-01'),
    status: 'Blocked'
  });
  assert.match(obligation.validateSync().errors.status.message, /enum/);
});
