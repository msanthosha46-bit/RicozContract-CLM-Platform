// Shared calendar-day arithmetic for the "expiring soon" window.
//
// Contract end dates are calendar dates (UTC midnight when set from a date
// picker), so every window has to be evaluated in UTC calendar days. Using
// local-time `setDate()` arithmetic instead silently drops contracts that
// expire *today*: a contract ending today-at-00:00Z is already earlier than
// `new Date()`, so a `endDate: { $gte: now }` lower bound excludes it. The
// same arithmetic also shifts the boundary by the server's UTC offset, so two
// features could report different counts for the same repository depending on
// where the process happened to be running.
//
// renewalRoutes.js and reportRoutes.js both count the same population, so the
// window lives here once and both consume it.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const startOfUtcDay = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * Bounds for contracts expiring within `windowDays` of today (UTC calendar
 * days). The lower bound is today-at-00:00Z, so a contract expiring today is
 * inside the window. The upper bound is exclusive, because a date-only end
 * date lands on UTC midnight and an inclusive upper bound at exactly that
 * instant would drop the last day of the window.
 */
const expiringWindow = (windowDays = 30, from = new Date()) => {
  const today = new Date(startOfUtcDay(from));
  return {
    $gte: today,
    $lt: new Date(today.getTime() + (Number(windowDays) + 1) * MS_PER_DAY)
  };
};

/** Whole UTC calendar days from `from` to `value` (negative in the past). */
const daysRemainingBetween = (from, value) =>
  Math.round((startOfUtcDay(value) - startOfUtcDay(from)) / MS_PER_DAY);

/**
 * Renders a stored calendar date for a user-facing string, in UTC.
 *
 * A contract/work-item date is a calendar date at UTC midnight, so formatting it
 * with a bare `toLocaleDateString()` renders it in the *host* timezone: on a
 * server at UTC-5 a contract ending 2026-10-09T00:00:00Z is announced as the
 * 8th. That is the same offset-dependent hazard `expiringWindow` exists to
 * avoid, and it disagreed with `client/src/utils/date.js` `formatDate`, which
 * pins `timeZone: 'UTC'` for exactly this reason.
 *
 * The locale is pinned rather than left to the host so the output is identical
 * on every deployment, and it matches the shape `formatDate` produces for an
 * en-US browser, so the same date does not read two ways across the app.
 * Returns an em dash for a missing or unparseable date, as `formatDate` does.
 */
const formatUtcDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

// Contract states the renewal screen actually lists as renewable. Kept here
// so a contract is never counted as "expiring soon" on the dashboard while
// being absent from the renewal list a user is sent to act on it.
// `RENEWABLE_FROM` in contractTransitions.js is the write-side authority; this
// is the read-side subset the renewal query filters on, and
// server/test/report.test.js asserts the two stay in step.
const EXPIRING_STATUSES = ['Active', 'Approved'];

module.exports = {
  MS_PER_DAY,
  startOfUtcDay,
  expiringWindow,
  daysRemainingBetween,
  formatUtcDate,
  EXPIRING_STATUSES
};
