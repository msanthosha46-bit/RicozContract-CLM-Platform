const User = require('../models/User');
const PasswordResetEmailJob = require('../models/PasswordResetEmailJob');
const mailer = require('../utils/mailer');
const { deliverPasswordResetEmail } = require('./passwordResetDelivery');

// The password-reset email queue.
//
// A request that asks for a reset link must not wait for the mail provider.
// While it did, the response time told an unauthenticated caller whether the
// address had an account: an existing account took as long as the provider
// needed to answer, an unknown address answered at once. So the request
// records a job and answers at once, and a worker in this process delivers the
// job afterwards.
//
// The queue lives in the application's own database, so it is durable: there is
// no new infrastructure and no new dependency, and an accepted request is not
// lost when the process dies. The job is picked up again after a restart.
//
// Delivery guarantees:
//
//   * A recorded job is attempted. A worker that dies after the provider
//     accepted the mail but before the job was marked as sent sends it again,
//     so a recipient can receive two links; the newest one is the one that
//     works.
//   * A delivery that fails is not retried automatically and is not discarded:
//     the job is marked as failed, the sanitised reason is kept on the job and
//     one sanitised line is logged. The person who asked for the link is told
//     nothing, because the answer must not reveal whether the account exists.
//   * A claim that is never finished is taken back and attempted again, so a
//     crash in the middle of a delivery cannot strand a job.
//
// The jobs are delivered one at a time and in the order they were requested, so
// the newest email always carries the token the account can use.

const DEFAULT_INTERVAL_MS = 200;
// Bounded work per pass: a burst of requests cannot make the worker hammer the
// provider without limit.
const MAX_JOBS_PER_PASS = 20;
// A claim that is older than this was left behind by a worker that died.
const STALE_CLAIM_MS = 5 * 60 * 1000;
// How long a finished job is kept for inspection.
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPLETED_JOB_STATUSES = ['sent', 'failed', 'skipped'];
// How often finished jobs are cleaned up.
const CLEANUP_INTERVAL_MS = 60 * 1000;

let timer = null;
let stopped = true;
let currentPass = null;
let lastCleanupAt = 0;

// Records the job. The write is awaited by the caller, so a request that was
// answered has its job in the database before the response goes out.
const enqueuePasswordResetEmail = async ({ userId, to }) =>
  PasswordResetEmailJob.create({ user: userId, to, status: 'pending' });

// Takes the oldest pending job. The claim is a single atomic document update,
// so two workers (two application instances, or a manual pass next to the
// polling one) can never take the same job.
const claimNextJob = async () =>
  PasswordResetEmailJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'sending', claimedAt: new Date() }, $unset: { completedAt: 1 } },
    // The oldest job first, so the newest email always carries the token the
    // account can use. The id breaks a tie between two jobs created in the
    // same millisecond.
    { sort: { createdAt: 1, _id: 1 }, new: true }
  );

// Puts back a job whose worker never finished it.
const reclaimStaleClaims = async () => {
  const result = await PasswordResetEmailJob.updateMany(
    { status: 'sending', claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    { $set: { status: 'pending', claimedAt: null }, $unset: { completedAt: 1 } }
  );
  return result.modifiedCount || 0;
};

// Removes finished jobs that are no longer worth keeping. The collection can
// therefore not grow without bound even when the TTL index is not present.
const removeOldJobs = async () => {
  const result = await PasswordResetEmailJob.deleteMany({
    status: { $in: COMPLETED_JOB_STATUSES },
    completedAt: { $lt: new Date(Date.now() - JOB_RETENTION_MS) }
  });
  return result.deletedCount || 0;
};

// Delivers one job. A delivery that fails is recorded on the job and logged;
// it is never silently dropped.
const processJob = async (job) => {
  const user = await User.findById(job.user).select('+passwordResetToken +passwordResetExpires');
  if (!user) {
    // The account is gone: there is nobody to send a link to.
    await PasswordResetEmailJob.updateOne(
      { _id: job._id },
      { $set: { status: 'skipped', sentAt: new Date(), completedAt: new Date() } }
    );
    return;
  }

  try {
    await deliverPasswordResetEmail({ user, to: job.to });
    await PasswordResetEmailJob.updateOne(
      { _id: job._id },
      { $set: { status: 'sent', sentAt: new Date(), completedAt: new Date(), lastError: null } }
    );
  } catch (error) {
    const description = mailer.describeEmailError(error);
    await PasswordResetEmailJob.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', failedAt: new Date(), completedAt: new Date(), lastError: description } }
    ).catch(() => {});

    // describeEmailError is the only sanitised form: the transports tried and
    // their reasons, never the token, the reset link, the API key or the
    // recipient address.
    console.error('Password reset email could not be sent:', description);
  }
};

// One pass over the queue: take the jobs that are waiting and deliver them.
const runPasswordResetEmailWorkerPass = async () => {
  await reclaimStaleClaims();

  let processed = 0;
  while (processed < MAX_JOBS_PER_PASS) {
    const job = await claimNextJob();
    if (!job) break;
    processed += 1;
    try {
      await processJob(job);
    } catch (error) {
      // An unexpected failure (a database error, not a delivery error) must not
      // strand the job: it goes back to the queue and is tried again.
      await PasswordResetEmailJob.updateOne(
        { _id: job._id },
        { $set: { status: 'pending', claimedAt: null }, $unset: { completedAt: 1 } }
      ).catch(() => {});
      console.error('Password reset email job could not be processed:', mailer.sanitizeForLog(error.message));
    }
  }

  const now = Date.now();
  if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now;
    await removeOldJobs();
  }

  return processed;
};

const scheduleNextPass = (intervalMs) => {
  if (stopped) return;
  timer = setTimeout(() => {
    void tick(intervalMs);
  }, intervalMs);
  // The timer must not keep the process alive on its own.
  timer.unref?.();
};

const tick = async (intervalMs) => {
  if (stopped) return;
  currentPass = runPasswordResetEmailWorkerPass().catch((error) => {
    console.error('Password reset email worker pass failed:', mailer.sanitizeForLog(error.message));
  });
  await currentPass;
  currentPass = null;
  if (!stopped) scheduleNextPass(intervalMs);
};

// Starts the worker. Calling it again while it runs does nothing.
const startPasswordResetEmailWorker = async ({ intervalMs = DEFAULT_INTERVAL_MS } = {}) => {
  if (timer) return;
  stopped = false;

  // The production connection builds indexes by hand, and the claim query runs
  // on every pass, so the index is created here as well. Creating an index is
  // idempotent and touches no document.
  try {
    await PasswordResetEmailJob.createIndexes();
  } catch (error) {
    console.warn(
      'Password reset email queue index could not be created:',
      mailer.sanitizeForLog(error.message)
    );
  }

  scheduleNextPass(0);
};

// Stops the worker and waits for the job in flight, so a delivery that is
// halfway through is not cut off by the shutdown.
const stopPasswordResetEmailWorker = async () => {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (currentPass) await currentPass;
};

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAX_JOBS_PER_PASS,
  STALE_CLAIM_MS,
  JOB_RETENTION_MS,
  removeOldJobs,
  enqueuePasswordResetEmail,
  runPasswordResetEmailWorkerPass,
  startPasswordResetEmailWorker,
  stopPasswordResetEmailWorker
};
