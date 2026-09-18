import React, { useEffect, useState } from 'react';
import API from '../services/api';

const Reports = () => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        const { data } = await API.get('/reports/summary');
        setSummary(data);
      } catch (err) {
        setError(err.response?.data?.message || 'Unable to load reports');
      } finally {
        setLoading(false);
      }
    };

    fetchSummary();
  }, []);

  if (loading) {
    return <div className="p-8 text-slate-500">Loading reports...</div>;
  }

  const metrics = summary?.metrics || {};

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Insights</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Reports & analytics</h1>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Total Contracts</div>
          <div className="mt-2 text-3xl font-bold text-slate-800">{metrics.total || 0}</div>
        </div>
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Active Contracts</div>
          <div className="mt-2 text-3xl font-bold text-emerald-600">{metrics.active || 0}</div>
        </div>
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Pending Approvals</div>
          <div className="mt-2 text-3xl font-bold text-amber-600">{metrics.pending || 0}</div>
        </div>
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Expiring Soon</div>
          <div className="mt-2 text-3xl font-bold text-orange-600">{metrics.expiringSoon || 0}</div>
        </div>
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Overdue Items</div>
          <div className="mt-2 text-3xl font-bold text-red-600">{(metrics.overdueObligations || 0) + (metrics.overdueMilestones || 0)}</div>
        </div>
        <div className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">Renewals</div>
          <div className="mt-2 text-3xl font-bold text-blue-600">{metrics.renewals || 0}</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-slate-800">Status Breakdown</h2>
          <div className="space-y-3">
            {(summary?.statusBreakdown || []).map((item) => (
              <div key={item._id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-sm font-medium text-slate-700">{item._id}</span>
                <span className="text-sm font-bold text-slate-900">{item.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-slate-800">Type Breakdown</h2>
          <div className="space-y-3">
            {(summary?.typeBreakdown || []).map((item) => (
              <div key={item._id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-sm font-medium text-slate-700">{item._id}</span>
                <span className="text-sm font-bold text-slate-900">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Reports;
