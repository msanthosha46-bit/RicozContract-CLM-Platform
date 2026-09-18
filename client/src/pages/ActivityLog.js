import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { Activity, Clock3 } from 'lucide-react';

const ActivityLog = () => {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchActivities = async () => {
      try {
        const { data } = await API.get('/activities');
        setActivities(data);
      } catch (requestError) {
        setError(requestError.response?.data?.message || 'Unable to load activity history');
      } finally {
        setLoading(false);
      }
    };

    fetchActivities();
  }, []);

  if (loading) return <div className="p-8 text-slate-500">Loading activity history...</div>;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Governance</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Activity log</h1>
        <p className="mt-1 text-sm text-slate-500">Recent contract and lifecycle actions across the workspace.</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {activities.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No activity recorded yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {activities.map((entry) => (
              <div key={entry._id} className="flex gap-4 p-5">
                <div className="mt-0.5 rounded-xl bg-[#eaf1ff] p-2 text-[#1d4ed8]">
                  <Activity className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-slate-800">{entry.action}</p>
                    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                      <Clock3 className="h-3.5 w-3.5" />
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{entry.details || 'No additional details.'}</p>
                  <p className="mt-2 text-xs text-slate-400">
                    {entry.user?.name || 'System'}{entry.contract?.contractNumber ? ` · ${entry.contract.contractNumber}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityLog;
