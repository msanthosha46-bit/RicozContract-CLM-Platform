const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  AMENDABLE_FIELDS,
  AMENDMENT_STATUSES,
  CURRENCIES,
  FIELD_LABELS,
  UNASSIGNED,
  emptyAmendmentDraft,
  buildProposed,
  changedFields,
  validateAmendmentDraft,
  sameAmendmentValue,
  describeAmendmentChanges,
  summariseAmendmentFields,
  canRequestAmendment,
  canDecideAmendment
} = require('../src/utils/amendments.js');

const { formatDate } = require('../src/utils/date.js');

const SERVER_ROOT = path.join(__dirname, '..', '..', 'server');
const CLIENT_PAGES = path.join(__dirname, '..', 'src', 'pages');

// Mirrors of server values that this client also hard-codes. If the server moves
// one of them, the form silently offers something the server refuses, so the
// mirrors are pinned to the source files rather than to a copy in this test.
const CONTRACT = {
  _id: 'contract-1',
  contractNumber: 'RC-001',
  status: 'Active',
  amount: 1000,
  currency: 'USD',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-12-31T00:00:00.000Z',
  assignedUser: 'user-1'
};
const USER = { _id: 'user-2', role: 'Manager' };

// ---------------------------------------------------------------------------
// The mirrors
// ---------------------------------------------------------------------------

test('the amendable field list is the server\'s locked field list', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'utils', 'contractEditLock.js'), 'utf8');
  const serverLocked = [.../LOCKED_FIELDS\s*=\s*\[([^\]]*)\]/s.exec(source)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...AMENDABLE_FIELDS].sort(), serverLocked.sort());
  // The request form renders a row per field, so every one needs a label.
  for (const field of AMENDABLE_FIELDS) assert.ok(FIELD_LABELS[field], `${field} has no label`);
});

test('the status list is the server model\'s enum', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'models', 'ContractAmendment.js'), 'utf8');
  const serverStatuses = [.../enum:\s*\[([^\]]*)\]/s.exec(source)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...AMENDMENT_STATUSES].sort(), serverStatuses.sort());
});

test('the currency list matches the options the create and edit forms already offer', () => {
  // Scoped to the currency <select>, because the same pages carry other selects
  // whose options are three uppercase letters too (the contract type offers NDA).
  const currencyOptions = (source) => {
    const select = /<select\b[^>]*\bname="currency"[^>]*>([\s\S]*?)<\/select>/.exec(source);
    assert.ok(select, 'no <select name="currency"> found');
    return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  };
  for (const page of ['CreateContract.js', 'EditContract.js']) {
    const offered = currencyOptions(fs.readFileSync(path.join(CLIENT_PAGES, page), 'utf8'));
    assert.ok(offered.length, `no currency options found in ${page}`);
    assert.deepEqual([...CURRENCIES].sort(), [...new Set(offered)].sort(), `${page} offers a different currency set`);
  }
});

// ---------------------------------------------------------------------------
// Shaping the request
// ---------------------------------------------------------------------------

test('only the fields the user filled in are sent, coerced to the server\'s types', () => {
  const proposed = buildProposed({ ...emptyAmendmentDraft(), amount: '2500.50', currency: ' EUR ' });
  assert.deepEqual(proposed, { amount: 2500.5, currency: 'EUR' });
  assert.equal(typeof proposed.amount, 'number', 'an amount sent as a string is re-validated server-side');
  // Blank means "not part of this amendment", never "set it to empty".
  assert.equal('startDate' in proposed, false);
  assert.equal('endDate' in proposed, false);
  assert.equal('assignedUser' in proposed, false);
});

test('clearing the assignee is distinct from leaving it alone', () => {
  // The empty option has to mean "leave it alone" for a partial amendment, so
  // clearing is expressed with a sentinel rather than with an empty string.
  assert.equal(emptyAmendmentDraft().assignedUser, '');
  assert.equal(buildProposed({ ...emptyAmendmentDraft(), assignedUser: '' }).assignedUser, undefined);
  assert.equal(buildProposed({ ...emptyAmendmentDraft(), assignedUser: UNASSIGNED }).assignedUser, null);
  assert.equal(buildProposed({ ...emptyAmendmentDraft(), assignedUser: 'user-9' }).assignedUser, 'user-9');
});

test('the changed fields are reported in the order the form renders them', () => {
  const draft = { ...emptyAmendmentDraft(), endDate: '2027-01-01', amount: '10' };
  assert.deepEqual(changedFields(draft), ['amount', 'endDate']);
  assert.deepEqual(changedFields(emptyAmendmentDraft()), []);
});

// ---------------------------------------------------------------------------
// Validating before a round trip
// ---------------------------------------------------------------------------

test('a draft with nothing filled in is refused with a form-level message', () => {
  const result = validateAmendmentDraft(emptyAmendmentDraft(), CONTRACT, 'because');
  assert.equal(result.valid, false);
  assert.match(result.formError, /at least one/);
  assert.deepEqual(result.fieldErrors, {});
  assert.equal(result.reasonError, '');
});

test('a missing reason is refused, and a long one is refused', () => {
  const draft = { ...emptyAmendmentDraft(), amount: '2000' };
  assert.match(validateAmendmentDraft(draft, CONTRACT, '   ').reasonError, /reason is required/i);
  assert.equal(validateAmendmentDraft(draft, CONTRACT, 'price renegotiated').reasonError, '');
  assert.match(validateAmendmentDraft(draft, CONTRACT, 'x'.repeat(1001)).reasonError, /under 1000/);
  // The boundary itself is allowed, so the limit is off-by-one free.
  assert.equal(validateAmendmentDraft(draft, CONTRACT, 'x'.repeat(1000)).reasonError, '');
  // Measured after trimming, because the server stores `reason.trim()` and its
  // `maxlength` is applied to the trimmed value. A trailing space must not fail
  // here and then pass there, or the form refuses something the API accepts.
  assert.equal(validateAmendmentDraft(draft, CONTRACT, `${'x'.repeat(1000)}   `).reasonError, '');
  assert.match(validateAmendmentDraft(draft, CONTRACT, `  ${'x'.repeat(1001)}`).reasonError, /under 1000/);
});

test('an amendment that proposes what already holds is caught in the form', () => {
  // Worth catching here: it would otherwise take the contract's single open
  // request slot and come back as a 400.
  const result = validateAmendmentDraft({ ...emptyAmendmentDraft(), amount: '1000' }, CONTRACT, 'no change really');
  assert.equal(result.valid, false);
  assert.match(result.formError, /already match the contract/);
  assert.match(result.formError, /Amount/, 'the message must name the field that is unchanged');
});

test('a date the contract already holds is not treated as a change', () => {
  // A date input round-trips through UTC midnight, so a string comparison would
  // call this a change and let a no-op through to the server.
  const result = validateAmendmentDraft(
    { ...emptyAmendmentDraft(), endDate: '2026-12-31' },
    CONTRACT,
    'same date'
  );
  assert.match(result.formError, /already match the contract/);
});

test('a partial amendment that changes one field and repeats another is allowed', () => {
  const result = validateAmendmentDraft(
    { ...emptyAmendmentDraft(), amount: '1000', endDate: '2027-06-30' },
    CONTRACT,
    'extended, amount unchanged'
  );
  assert.equal(result.valid, true, `expected a partial change to be valid, got ${JSON.stringify(result)}`);
  assert.equal(result.formError, '');
  assert.deepEqual(result.changed, ['amount', 'endDate']);
});

test('an invalid amount is pointed at, not reported as a request error', () => {
  assert.match(validateAmendmentDraft({ ...emptyAmendmentDraft(), amount: '-5' }, CONTRACT, 'r').fieldErrors.amount, /non-negative/);
  assert.match(validateAmendmentDraft({ ...emptyAmendmentDraft(), amount: 'abc' }, CONTRACT, 'r').fieldErrors.amount, /non-negative/);
  assert.equal(validateAmendmentDraft({ ...emptyAmendmentDraft(), amount: '0' }, CONTRACT, 'r').valid, true, 'zero is a legal amount');
});

test('a resulting date range that is inverted is caught, not just per-field validity', () => {
  // Moving only the start date past the current end date is accepted by a
  // per-field check and refused by the server.
  const result = validateAmendmentDraft({ ...emptyAmendmentDraft(), startDate: '2027-06-01' }, CONTRACT, 'r');
  assert.match(result.fieldErrors.endDate, /on or after the start date/);

  // Both fields supplied, inverted: caught the same way.
  const both = validateAmendmentDraft({ ...emptyAmendmentDraft(), startDate: '2027-06-01', endDate: '2027-01-01' }, CONTRACT, 'r');
  assert.match(both.fieldErrors.endDate, /on or after the start date/);
  // A range with equal ends is legal.
  const same = validateAmendmentDraft({ ...emptyAmendmentDraft(), startDate: '2027-01-01', endDate: '2027-01-01' }, CONTRACT, 'r');
  assert.equal(same.fieldErrors.endDate, undefined);
});

test('an unparseable date is pointed at', () => {
  assert.ok(validateAmendmentDraft({ ...emptyAmendmentDraft(), endDate: 'not-a-date' }, CONTRACT, 'r').fieldErrors.endDate);
});

// ---------------------------------------------------------------------------
// Comparison rules shared with the server
// ---------------------------------------------------------------------------

test('values compare the way the server compares them', () => {
  // Numeric strings from inputs, instants for dates, and a populated user object
  // against a raw id - the three shapes the form and the API actually produce.
  assert.equal(sameAmendmentValue('amount', '1000', 1000), true);
  assert.equal(sameAmendmentValue('amount', '1000.00', 1000), true);
  assert.equal(sameAmendmentValue('amount', '1001', 1000), false);
  assert.equal(sameAmendmentValue('endDate', '2026-12-31', '2026-12-31T00:00:00.000Z'), true);
  assert.equal(sameAmendmentValue('endDate', '2027-01-01', '2026-12-31T00:00:00.000Z'), false);
  assert.equal(sameAmendmentValue('assignedUser', { _id: 'user-1' }, 'user-1'), true);
  assert.equal(sameAmendmentValue('assignedUser', 'user-1', { _id: 'user-1' }), true);
  assert.equal(sameAmendmentValue('assignedUser', 'user-2', 'user-1'), false);
  assert.equal(sameAmendmentValue('currency', 'usd', 'USD'), false, 'currency is case sensitive server-side');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('a change is described from the resolved names, not the raw ids', () => {
  const rows = describeAmendmentChanges({
    proposed: { amount: 2500, assignedUser: 'user-9' },
    before: { amount: 1000, assignedUser: 'user-1' },
    beforeAssignee: 'Ada Lovelace',
    proposedAssignee: 'Grace Hopper'
  });
  assert.deepEqual(rows, [
    { field: 'amount', label: 'Amount', from: '1,000', to: '2,500' },
    { field: 'assignedUser', label: 'Assigned user', from: 'Ada Lovelace', to: 'Grace Hopper' }
  ]);
});

test('a missing resolved name falls back to a readable state instead of a raw id', () => {
  // A bare ObjectId is not something an approver can judge a reassignment by, so
  // it must never reach the screen even if name resolution is unavailable.
  const rows = describeAmendmentChanges({
    proposed: { assignedUser: 'user-9' },
    before: { assignedUser: 'user-1' }
  });
  assert.equal(rows[0].from, 'Unassigned');
  assert.equal(rows[0].to, 'Unassigned');
  assert.equal(rows[0].to.includes('user-'), false);
});

test('a cleared assignee reads as unassigned, and a date is shown as a date', () => {
  const rows = describeAmendmentChanges({
    proposed: { endDate: '2027-06-30T00:00:00.000Z' },
    before: { endDate: '2026-12-31T00:00:00.000Z' },
    beforeAssignee: 'Ada Lovelace',
    proposedAssignee: null
  });
  assert.equal(rows[0].label, 'End date');
  // Contract dates are calendar days stored at UTC midnight, so the value has
  // to be rendered from the same shared helper the page uses. Reading it with a
  // bare toLocaleDateString() here would re-introduce the device-timezone shift
  // this suite exists to prevent.
  assert.equal(rows[0].to, formatDate('2027-06-30T00:00:00.000Z'));
  assert.equal(/T00:00:00/.test(rows[0].to), false, 'an ISO timestamp leaked into the UI');
});

test('an amendment with no proposed fields describes nothing rather than throwing', () => {
  assert.deepEqual(describeAmendmentChanges({}), []);
  assert.deepEqual(describeAmendmentChanges({ proposed: {} }), []);
  assert.deepEqual(describeAmendmentChanges(null), []);
  assert.deepEqual(summariseAmendmentFields({ proposed: { amount: 1, endDate: 2 } }), ['Amount', 'End date']);
});

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

test('an amendment is only offered for a contract that is no longer edited directly', () => {
  // This is the rule that shares its status list with the edit lock. If the
  // import were missing the module would still load and the build would still
  // pass, and this assertion is what notices.
  for (const status of ['Draft', 'Rejected']) {
    const result = canRequestAmendment({ contract: { ...CONTRACT, status }, user: USER });
    assert.equal(result.allowed, false, `${status} must be edited directly`);
    assert.match(result.reason, /edited directly/);
  }
  for (const status of ['Pending Approval', 'Approved', 'Active', 'Expired', 'Closed']) {
    assert.equal(canRequestAmendment({ contract: { ...CONTRACT, status }, user: USER }).allowed, true, `${status} should allow an amendment`);
  }
});

test('an archived contract is never offered, and neither is a missing one', () => {
  assert.match(canRequestAmendment({ contract: { ...CONTRACT, isArchived: true }, user: USER }).reason, /Archived/);
  assert.match(canRequestAmendment({ contract: null, user: USER }).reason, /not found/i);
  assert.match(canRequestAmendment({ contract: CONTRACT, user: null }).reason, /Sign in/);
});

test('the single open request per contract is enforced from the history already loaded', () => {
  // No second request needed: the same list the history renders carries the
  // pending row, so the button and the history cannot disagree.
  const pending = { _id: 'a1', status: 'Pending' };
  assert.match(
    canRequestAmendment({ contract: CONTRACT, amendments: [pending], user: USER }).reason,
    /already awaiting a decision/
  );
  // Decided rows do not block a new request.
  assert.equal(
    canRequestAmendment({ contract: CONTRACT, amendments: [{ status: 'Rejected' }, { status: 'Approved' }], user: USER }).allowed,
    true
  );
});

test('only an admin or manager may decide, and never their own request', () => {
  const amendment = { _id: 'a1', status: 'Pending', requestedBy: { _id: 'user-1', name: 'Ada' } };

  assert.equal(canDecideAmendment({ amendment, user: { _id: 'user-2', role: 'Manager' } }).allowed, true);
  assert.equal(canDecideAmendment({ amendment, user: { _id: 'user-2', role: 'Admin' } }).allowed, true);

  // An Employee is refused by role, and so is a decided request.
  assert.match(
    canDecideAmendment({ amendment, user: { _id: 'user-2', role: 'Employee' } }).reason,
    /administrators and managers/
  );
  assert.match(
    canDecideAmendment({ amendment: { ...amendment, status: 'Approved' }, user: { _id: 'user-2', role: 'Admin' } }).reason,
    /already been approved/
  );

  // Separation of duties, against both shapes the id can arrive in.
  const ownPopulated = canDecideAmendment({ amendment, user: { _id: 'user-1', role: 'Manager' } });
  assert.match(ownPopulated.reason, /your own amendment/);
  const ownRaw = canDecideAmendment({
    amendment: { ...amendment, requestedBy: 'user-1' },
    user: { _id: 'user-1', role: 'Admin' }
  });
  assert.match(ownRaw.reason, /your own amendment/);

  assert.match(canDecideAmendment({ amendment, user: null }).reason, /Sign in/);
  assert.match(canDecideAmendment({ amendment: null, user: USER }).reason, /Sign in/);
});
