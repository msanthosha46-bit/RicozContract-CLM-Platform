import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { CheckCircle2, Clock3, LoaderCircle, AlertTriangle, ShieldCheck } from 'lucide-react';

const statusStyles = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700'
};

const Obligations = () => {
  const [obligations, setObligations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchObligations = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/obligations');
      setObligations(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load obligations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchObligations();
  }, []);

  const updateStatus = async (id, status) => {
    try {
      await API.put(`/obligations/${id}`, { status });
      fetchObligations();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update obligation');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading obligations...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Compliance workspace</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Obligations</h1>
          <p className="mt-2 text-slate-500">Track every promise, owner, and deadline before it becomes a risk.</p>
        </div>
        <div className="hidden h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf1ff] text-[#1d4ed8] sm:flex"><ShieldCheck className="h-6 w-6" /></div>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {obligations.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No obligations assigned.</div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Assigned To</th>
                <th className="px-4 py-3 font-medium">Due Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {obligations.map((ob) => (
                <tr key={ob._id} className="transition hover:bg-[#f8fafc]">
                  <td className="px-4 py-3 font-medium text-slate-800">{ob.contract?.contractNumber || 'N/A'}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{ob.title}</div>
                    <div className="text-xs text-slate-500">{ob.contract?.title || ''}</div>
                  </td>
                  <td className="px-4 py-3">{ob.assignedTo?.name || 'Unassigned'}</td>
                  <td className="px-4 py-3">{new Date(ob.dueDate).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[ob.status] || 'bg-slate-100 text-slate-700'}`}>
                      {ob.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {ob.status !== 'In Progress' && (
                        <button onClick={() => updateStatus(ob._id, 'In Progress')} className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100">
                          Start
                        </button>
                      )}
                      {ob.status !== 'Completed' && (
                        <button onClick={() => updateStatus(ob._id, 'Completed')} className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                          Complete
                        </button>
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

export default Obligations;
