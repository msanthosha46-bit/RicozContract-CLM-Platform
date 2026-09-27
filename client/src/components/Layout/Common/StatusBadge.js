import React from 'react';

// The status vocabulary comes from the server: contractTransitions.js for the
// nine contract states and itemTransitions.js for the four work-item states.
// The dark variants lift the pill background and brighten the text so the
// foreground still clears 4.5:1 against the dark card.
const styles = {
  Draft: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-700/40 dark:text-slate-200 dark:border-slate-600',
  'Pending Review': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa] dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40',
  'Pending Approval': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa] dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40',
  Approved: 'bg-[#eaf8f1] text-[#15803d] border-[#bbf7d0] dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40',
  Rejected: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/40',
  Active: 'bg-[#eaf1ff] text-[#1d4ed8] border-[#bfdbfe] dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/40',
  Expired: 'bg-[#f1f3f5] text-[#475569] border-[#cbd5e1] dark:bg-slate-700/40 dark:text-slate-300 dark:border-slate-600',
  Renewed: 'bg-[#eef4ff] text-[#1e40af] border-[#c7d2fe] dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/40',
  Closed: 'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-700/50 dark:text-slate-300 dark:border-slate-600',
  Pending: 'bg-[#fff3e8] text-[#b45309] dark:bg-amber-500/15 dark:text-amber-300',
  'In Progress': 'bg-[#eaf1ff] text-[#1d4ed8] dark:bg-blue-500/15 dark:text-blue-300',
  Completed: 'bg-[#eaf8f1] text-[#15803d] dark:bg-emerald-500/15 dark:text-emerald-300',
  Overdue: 'bg-[#fff1f2] text-[#be123c] dark:bg-rose-500/15 dark:text-rose-300'
};

const StatusBadge = ({ status }) => {
  if (!status) return null;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[status] || 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200'}`}
    >
      {status}
    </span>
  );
};

export default StatusBadge;
