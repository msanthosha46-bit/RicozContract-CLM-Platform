import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { Flag, ArrowUpRight } from 'lucide-react';

const statusStyles = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700'
};

const Milestones = () => {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchMilestones = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/milestones');
      setMilestones(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load milestones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMilestones();
  }, []);

  const updateStatus = async (id, status) => {
    try {
      await API.put(`/milestones/${id}`, { status });
      await fetchMilestones();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update milestone');
    }
  };

  if (loading) return <div className="p-8 text-slate-500">Loading milestones...</div>;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf1ff] text-[#1d4ed8]"><Flag className="h-6 w-6" /></div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Contract lifecycle</p>
            <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Milestones</h1>
            <p className="mt-2 text-slate-500">Give each agreement a visible path from kickoff to completion.</p>
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {milestones.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No milestones assigned.</div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Milestone</th>
                <th className="px-4 py-3 font-medium">Assigned To</th>
                <th className="px-4 py-3 font-medium">Due Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {milestones.map((milestone) => (
                <tr key={milestone._id} className="transition hover:bg-[#f8fafc]">
                  <td className="px-4 py-3 font-medium text-slate-800">{milestone.contract?.contractNumber || 'N/A'}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{milestone.title}</div>
                    <div className="text-xs text-slate-500">{milestone.description || milestone.contract?.title || ''}</div>
                  </td>
                  <td className="px-4 py-3">{milestone.assignedTo?.name || 'Unassigned'}</td>
                  <td className="px-4 py-3">{new Date(milestone.dueDate).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[milestone.status] || 'bg-slate-100 text-slate-700'}`}>
                      {milestone.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {milestone.status !== 'In Progress' && milestone.status !== 'Completed' && (
                        <button onClick={() => updateStatus(milestone._id, 'In Progress')} className="inline-flex items-center gap-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100">Start <ArrowUpRight className="h-3 w-3" /></button>
                      )}
                      {milestone.status !== 'Completed' && (
                        <button onClick={() => updateStatus(milestone._id, 'Completed')} className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">Complete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default Milestones;
