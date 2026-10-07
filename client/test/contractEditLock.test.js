const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  UNLOCKED_STATUSES,
  LOCKED_FIELDS,
  isEditableStatus,
  isFieldLocked
} = require('../src/utils/contractEditLock');

const SERVER_LOCK = path.join(__dirname, '..', '..', 'server', 'utils', 'contractEditLock.js');

test('the client mirror matches the server policy exactly', () => {
  // The client list only disables inputs; the server is the authority. If the two
  // drift, the user is either invited to make an edit that returns 409, or shown
  // a lock that does not exist. Both are confusing, so pin them together.
  const source = fs.readFileSync(SERVER_LOCK, 'utf8');
  assert.ok(
    /UNLOCKED_STATUSES\s*=\s*new Set\(\[(.*?)\]\)/s.exec(source),
    'could not read UNLOCKED_STATUSES from the server policy'
  );
  const serverUnlocked = [.../UNLOCKED_STATUSES\s*=\s*new Set\(\[([^\]]*)\]\)/s.exec(source)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...UNLOCKED_STATUSES].sort(), serverUnlocked.sort());

  const serverLocked = [.../LOCKED_FIELDS\s*=\s*\[([^\]]*)\]/s.exec(source)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...LOCKED_FIELDS].sort(), serverLocked.sort());
});

test('Draft and Rejected stay editable, everything else is locked', () => {
  assert.equal(isEditableStatus('Draft'), true);
  assert.equal(isEditableStatus('Rejected'), true);
  for (const status of ['Pending Review', 'Pending Approval', 'Approved', 'Active', 'Expired', 'Closed']) {
    assert.equal(isEditableStatus(status), false, `${status} must not be editable`);
  }
});

test('only the financial terms, the dates and the assignee are locked', () => {
  for (const field of ['amount', 'currency', 'startDate', 'endDate', 'assignedUser']) {
    assert.equal(isFieldLocked('Active', field), true, `${field} should be locked`);
  }
  for (const field of ['title', 'type', 'partyName', 'description', 'status']) {
    assert.equal(isFieldLocked('Active', field), false, `${field} should stay editable`);
  }
});

test('nothing is locked while a contract is still a draft or was rejected', () => {
  for (const status of ['Draft', 'Rejected']) {
    for (const field of [...LOCKED_FIELDS, 'title', 'description']) {
      assert.equal(isFieldLocked(status, field), false);
    }
  }
});
