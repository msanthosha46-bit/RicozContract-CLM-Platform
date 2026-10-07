import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { Activity, Clock3 } from 'lucide-react';
import { PageSkeleton, SkeletonRows } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';

const ActivityLog = () => {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Whether the log has actually been READ. An empty log and a failed read both
  // leave `activities` empty, and only one of them may be reported as "No
  // activity recorded yet".
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);

  const fetchActivities = async () => {
    try {
      const { data } = await API.get('/activities');
      setActivities(data);
      setActivitiesLoaded(true);
      setError('');
    } catch (requestError) {
      // A failed read must not be reported as an empty log. The previous rows
      // are deliberately left in place: on a retry that fails there is still
      // something true on screen, and on the first load `activitiesLoaded`
      // stays false so the list area does not claim nothing ever happened.
      setError(requestError.response?.data?.message || 'Unable to load activity history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchActivities();
  }, []);

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading activity history…</span>
          <div aria-hidden="true" className="ricoz-skeleton h-3 w-32 rounded-lg" />
          <div aria-hidden="true" className="ricoz-skeleton h-9 w-56 max-w-full rounded-lg" />
          <div aria-hidden="true" className="ricoz-skeleton h-3 w-full max-w-xl rounded-lg" />
        </div>
        <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm px-4">
          <SkeletonRows rows={6} columns={2} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="ricoz-eyebrow">Governance</p>
        <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Activity log</h1>
        <p className="mt-1 text-sm text-slate-500">Recent contract and lifecycle actions across the workspace.</p>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={fetchActivities}
            className="shrink-0 rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {!activitiesLoaded ? (
          /* The log was never read. Reporting "No activity recorded yet" here
             would contradict the error and retry above, and would tell an Admin
             or Manager that nothing has ever happened in the workspace. */
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              The activity log could not be loaded. Use Retry above to try again.
            </p>
          </div>
        ) : activities.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No activity recorded yet"
            description="Contract and lifecycle actions across the workspace are logged here as they happen."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {activities.map((entry) => (
              <div key={entry._id} className="flex gap-4 p-5">
                <div className="mt-0.5 rounded-xl bg-[#fff0f0] p-2 text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
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
