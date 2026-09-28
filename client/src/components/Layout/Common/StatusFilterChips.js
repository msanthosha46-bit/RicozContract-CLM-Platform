import React from 'react';

// Shared status filter for the work-item tables (obligations, milestones).
//
// Both pages already fetched their complete, unpaginated list -- `GET
// /obligations` and `GET /milestones` return every item the caller is allowed
// to see, scoping Employees to their own on the server and nothing more -- so
// the counts and the filtering are both done here rather than by adding query
// parameters the routes do not support. That keeps the authorization rules
// exactly where they are: the client only ever reorders what the server chose
// to send.
//
// The counts are always derived from the unfiltered list, never from what is
// currently displayed. Deriving them from the visible rows is the classic way
// filter chips become a one-way door: pick "Completed", the other counts
// collapse to zero, and the chips you need to switch back disappear with them.

const ALL = 'all';

// A row whose status is missing or blank must still be reachable, so it is
// grouped under the same "Unknown" the rz-unknown fallback pill already implies
// elsewhere on these pages. Without this, such a row is only visible under All.
const keyOf = (status) => (typeof status === 'string' && status.trim() ? status : 'Unknown');

/**
 * The rows to show for a given selection. Exported, and used by the pages
 * instead of each re-deriving the predicate, because the chip count and the table
 * have to agree by construction: two copies of "is this row in this status?" is
 * how a chip comes to advertise 1 while the table underneath it reports the
 * status as empty. They already drifted once -- the chips normalised a
 * whitespace-only status to Unknown, the pages only special-cased a falsy one.
 */
export const filterByStatus = (items, value) => {
  if (!Array.isArray(items)) return [];
  return value === ALL ? items : items.filter((item) => keyOf(item?.status) === value);
};

const StatusFilterChips = ({ items, value, onChange, statusStyles, label = 'Filter by status' }) => {
  // Both pages guard this row behind `total > 0`, but the component must not
  // depend on that: filterByStatus() below already answers [] for a missing
  // list, and it would be inconsistent for the chips that count to throw where
  // the helper that filters does not. A failed fetch that leaves `items`
  // undefined must render an inert control, not a blank page.
  const rows = Array.isArray(items) ? items : [];
  const known = statusStyles || {};

  // The known vocabulary first, then any status actually present in the data,
  // so a newly added server-side status gets a chip without a client change.
  const statuses = [...new Set([...Object.keys(known), ...rows.map((item) => keyOf(item.status))])];

  const options = [
    // Literal hexes, not `bg-slate-200 text-slate-700`: index.css rewrites
    // `.dark .ricoz-shell main .text-slate-700` to a light body colour but
    // leaves the background alone, which would put light text on a pale chip.
    // A hex the override block does not match stays put, and the pale fill
    // matches the status chips beside it in both themes.
    { value: ALL, label: 'All', count: rows.length, style: 'bg-[#e2e8f0] text-[#334155]' },
    ...statuses.map((status) => ({
      value: status,
      label: status,
      count: rows.filter((item) => keyOf(item.status) === status).length,
      style: known[status] || 'rz-pill rz-unknown'
    }))
  ];

  return (
    /* role=group + aria-pressed per chip: this is a set of toggle buttons, not
       a list of links, so a screen reader announces "Pending 4, toggle button,
       not pressed" rather than pretending the counts are navigation. */
    <div role="group" aria-label={label} className="flex flex-wrap gap-2 text-xs font-semibold">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 transition ${option.style} ${
              selected
                ? 'font-bold ring-2 ring-[#0f172a] ring-offset-2 ring-offset-white dark:ring-white dark:ring-offset-[#141c2e]'
                : 'opacity-80 hover:opacity-100 focus-visible:opacity-100'
            } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0f172a] dark:focus-visible:outline-white`}
          >
            {option.label}
            <span className="tabular-nums">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
};

export default StatusFilterChips;
