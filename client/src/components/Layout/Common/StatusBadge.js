import React from 'react';

const StatusBadge = ({ status }) => {
  const styles = {
    Draft: 'bg-slate-100 text-slate-700 border-slate-300',
    'Pending Review': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa]',
    'Pending Approval': 'bg-[#fff3e8] text-[#b45309] border-[#fed7aa]',
    Approved: 'bg-[#eaf8f1] text-[#15803d] border-[#bbf7d0]',
    Rejected: 'bg-rose-100 text-rose-800 border-rose-300',
    Active: 'bg-[#eaf1ff] text-[#1d4ed8] border-[#bfdbfe]',
    Expired: 'bg-[#f1f3f5] text-[#475569] border-[#cbd5e1]',
    Renewed: 'bg-[#eef4ff] text-[#1e40af] border-[#c7d2fe]',
    Closed: 'bg-slate-200 text-slate-600 border-slate-300',
    Pending: 'bg-[#fff3e8] text-[#b45309]',
    'In Progress': 'bg-[#eaf1ff] text-[#1d4ed8]',
    Completed: 'bg-[#eaf8f1] text-[#15803d]',
    Overdue: 'bg-[#fff1f2] text-[#be123c]',
  };

  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${styles[status] || 'bg-slate-100 text-slate-700'}`}>
      {status}
    </span>
  );
};

export default StatusBadge;