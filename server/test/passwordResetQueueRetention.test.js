const assert = require('node:assert/strict');
const test = require('node:test');

const PasswordResetEmailJob = require('../models/PasswordResetEmailJob');
const { JOB_RETENTION_MS, removeOldJobs } = require('../services/passwordResetEmailQueue');

test('TTL retention is based on completion, not job creation', () => {
  const ttlIndex = PasswordResetEmailJob.schema.indexes()
    .find(([, options]) => options.expireAfterSeconds !== undefined);

  assert.ok(ttlIndex);
  assert.deepEqual(ttlIndex[0], { completedAt: 1 });
  assert.equal(ttlIndex[1].expireAfterSeconds, JOB_RETENTION_MS / 1000);
  assert.equal(PasswordResetEmailJob.schema.path('completedAt').defaultValue, null);
});

test('manual cleanup removes only expired terminal jobs and retains open or recent jobs', async () => {
  const now = Date.now();
  const expired = new Date(now - JOB_RETENTION_MS - 1000);
  const recent = new Date(now - JOB_RETENTION_MS + 1000);
  const records = [
    { _id: 'pending', status: 'pending', createdAt: expired, completedAt: null },
    { _id: 'sending', status: 'sending', createdAt: expired, completedAt: null },
    { _id: 'sent-old', status: 'sent', createdAt: expired, completedAt: expired },
    { _id: 'failed-old', status: 'failed', createdAt: expired, completedAt: expired },
    { _id: 'skipped-old', status: 'skipped', createdAt: expired, completedAt: expired },
    { _id: 'sent-recent', status: 'sent', createdAt: expired, completedAt: recent },
    { _id: 'failed-no-completion', status: 'failed', createdAt: expired, completedAt: null }
  ];
  const originalDeleteMany = PasswordResetEmailJob.deleteMany;
  let capturedFilter;

  PasswordResetEmailJob.deleteMany = async (filter) => {
    capturedFilter = filter;
    const statuses = new Set(filter.status.$in);
    const cutoff = filter.completedAt.$lt;
    const removed = records.filter((record) => (
      statuses.has(record.status)
      && record.completedAt instanceof Date
      && record.completedAt < cutoff
    ));
    for (const record of removed) records.splice(records.indexOf(record), 1);
    return { deletedCount: removed.length };
  };

  try {
    assert.equal(await removeOldJobs(), 3);
    assert.deepEqual(capturedFilter.status, { $in: ['sent', 'failed', 'skipped'] });
    assert.ok(capturedFilter.completedAt.$lt instanceof Date);
    assert.equal(capturedFilter.createdAt, undefined);
    assert.deepEqual(records.map(({ _id }) => _id).sort(), [
      'failed-no-completion', 'pending', 'sending', 'sent-recent'
    ]);
  } finally {
    PasswordResetEmailJob.deleteMany = originalDeleteMany;
  }
});
