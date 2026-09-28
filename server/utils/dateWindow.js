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
  EXPIRING_STATUSES
};
