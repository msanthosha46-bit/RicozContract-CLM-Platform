import React from 'react';

// The status vocabulary comes from the server: contractTransitions.js for the
// nine contract states and itemTransitions.js for the four work-item states.
//
// The coloured states keep their utility classes. They are built from
// arbitrary hex and rose/emerald/amber values, none of which the theme
// overrides in index.css rewrite, so their `dark:` variants apply as written.
//
// The six neutral states cannot work that way. index.css rewrites
// `bg-slate-*`, `text-slate-*` and `border-slate-*` inside `.ricoz-shell main`
// to theme tokens, and those rules are unlayered so they outrank Tailwind's
// `dark:` utilities -- a slate-built pill silently kept its light values and
// Draft, Expired and Closed all rendered identically. The `rz-*` classes in
// index.css set the fill, label and border for both themes directly, so they
// are immune to that. See the "Status pills" block in index.css.
const neutralStyles = {
  Active: 'rz-active',
  'In Progress': 'rz-inprogress',
  Renewed: 'rz-renewed',
  Draft: 'rz-draft',
  Expired: 'rz-expired',
  Closed: 'rz-closed'
};

const styles = {
  'Pending Review': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa] dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40',
  'Pending Approval': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa] dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40',
  Approved: 'bg-[#eaf8f1] text-[#15803d] border-[#bbf7d0] dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40',
  Rejected: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/40',
  Pending: 'bg-[#fff3e8] text-[#b45309] dark:bg-amber-500/15 dark:text-amber-300',
  Completed: 'bg-[#eaf8f1] text-[#15803d] dark:bg-emerald-500/15 dark:text-emerald-300',
  Overdue: 'bg-[#fff1f2] text-[#be123c] dark:bg-rose-500/15 dark:text-rose-300'
};

const StatusBadge = ({ status }) => {
  if (!status) return null;

  // Coloured states keep their utilities; everything else is a semantic pill,
  // falling back to `rz-unknown` so an unrecognised status stays readable in
  // both themes instead of being flattened by the slate overrides.
  const tone = styles[status] || `rz-pill ${neutralStyles[status] || 'rz-unknown'}`;

  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}
    >
      {status}
    </span>
  );
};

export default StatusBadge;
