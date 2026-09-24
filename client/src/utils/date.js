const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Contract dates and work-item due dates are calendar dates stored at UTC
// midnight (what an <input type="date"> produces). Rendering them with
// toLocaleDateString uses the device timezone, so a user at UTC-5 would see
// the previous day. All formatting/arithmetic here stays in UTC calendar days.
const startOfUtcDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return NaN;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const pad = (number) => String(number).padStart(2, '0');

export const formatDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

// Real timestamps (createdAt, audited-at, etc.) should be shown in the user's
// local time; only calendar/date-picker values use the UTC formatter above.
export const formatDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Convert a stored date back to a "YYYY-MM-DD" value for a date picker, in UTC.
export const toDateInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

// Whole UTC calendar days from today to the given date (negative in the past).
export const daysUntil = (value) => {
  if (!value) return null;
  const target = startOfUtcDay(value);
  const today = startOfUtcDay(new Date());
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  return Math.round((target - today) / MS_PER_DAY);
};

export const daysLabel = (days) => {
  if (days === null || days === undefined) return 'No date';
  if (days === 0) return 'Due today';
  if (days < 0) return `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;
  return `in ${days} day${days === 1 ? '' : 's'}`;
};

// The tightest reminder tier a contract falls into (30/60/90 days).
export const reminderTier = (days) => {
  if (days <= 30) return 30;
  if (days <= 60) return 60;
  return 90;
};

