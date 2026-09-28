import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink } from 'lucide-react';
import API from '../services/api';
import { PageSkeleton } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';

// Every figure carries an explicit light/dark pair rather than a bare palette
// utility, for two reasons:
//
//  - index.css rewrites `.ricoz-shell main .text-blue-600` to the brand red
//    #d51d29, so the "Renewals" number used to paint in the same red as the
//    "Overdue" figure. A neutral KPI reading as an alert. A hex literal is not
//    matched by that rule, so the blue stays blue.
//  - A bare `text-emerald-600` has no dark variant, so it kept its light-theme
//    weight on the dark card and measured 4.51:1 there.
//
// `neutral` carries no `dark:` value on purpose: index.css already maps
// `text-[#0f1d3a]` onto --rz-text-strong, which is #f1f5f9 in dark mode, and
// that rule is unlayered so it would beat a `dark:` utility anyway.
//
// The light values are the -700 steps and the dark values the -300 steps of the
// same palette, which is the pairing StatusBadge uses for the matching status
// pills -- the Active figure is literally the Approved pill's pair, so a figure
// and its badge can never read as two different colours. All six clear WCAG AA
// as normal text on #ffffff and on the dark card #141c2e (lowest 5.02:1).
const METRIC_TONE = {
  neutral: 'text-[#0f1d3a]',
  active: 'text-[#15803d] dark:text-emerald-300',
  pending: 'text-[#b45309] dark:text-amber-300',
  expiring: 'text-[#c2410c] dark:text-orange-300',
  overdue: 'text-[#be123c] dark:text-rose-300',
  renewals: 'text-[#1d4ed8] dark:text-[#93b4fb]'
};

const totalOf = (rows) => rows.reduce((sum, row) => sum + (row.count || 0), 0);

const Breakdown = ({ title, rows, filterKey, emptyTitle, emptyDescription }) => (
  // Row order is the server's, not a second sort here: reportRoutes.js already
  // returns statuses in lifecycle order and types by descending count, and two
  // orderings in two places is how the dashboard chart and this table drifted
  // apart in the first place.
  <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-bold text-slate-800">{title}</h2>
      {rows.length > 0 && (
        <span className="text-sm tabular-nums text-slate-500">{totalOf(rows)} contracts</span>
      )}
    </div>
    {rows.length === 0 ? (
      <EmptyState compact title={emptyTitle} description={emptyDescription} />
    ) : (
      <div className="space-y-2">
        {rows.map((item) => (
          <Link
            key={item._id || 'unknown'}
            to={`/contracts?${filterKey}=${encodeURIComponent(item._id || '')}`}
            className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 transition hover:bg-slate-100"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-700">
              <span className="truncate">{item._id || 'Unspecified'}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-slate-400" aria-hidden="true" />
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900">{item.count || 0}</span>
          </Link>
        ))}
      </div>
    )}
  </div>
);

const Reports = () => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const fetchSummary = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await API.get('/reports/summary');
      setSummary(data);
      setLoaded(true);
    } catch (err) {
      // Keep the last good payload. Blanking it would turn a transient
      // failure into "no analytics yet" on the next render, which reads as an
      // empty repository rather than a failed request.
      setError(err.response?.data?.message || 'Unable to load reports');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  if (loading && !loaded) {
    return <PageSkeleton cards={6} rows={4} columns={3} />;
  }

  const metrics = summary?.metrics || {};
  const statusBreakdown = summary?.statusBreakdown || [];
  const typeBreakdown = summary?.typeBreakdown || [];
  // Only an empty repository is an empty state. `!summary` means the request
  // never succeeded, which is a failure to report, not an absence of data.
  const isEmpty = Boolean(summary) && statusBreakdown.length === 0 && typeBreakdown.length === 0;
  const failed = !summary;

  const overdueTotal = (metrics.overdueObligations || 0) + (metrics.overdueMilestones || 0);

  const cards = [
    { label: 'Total Contracts', value: metrics.total || 0, tone: 'neutral' },
    { label: 'Active Contracts', value: metrics.active || 0, tone: 'active' },
    { label: 'Pending Approvals', value: metrics.pending || 0, tone: 'pending' },
    { label: 'Expiring Soon', value: metrics.expiringSoon || 0, tone: 'expiring', detail: 'Active or approved, 30 days' },
    { label: 'Overdue Items', value: overdueTotal, tone: 'overdue', detail: `${metrics.overdueObligations || 0} obligations · ${metrics.overdueMilestones || 0} milestones` },
    { label: 'Renewals', value: metrics.renewals || 0, tone: 'renewals', detail: 'Renewal records to date' }
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="ricoz-eyebrow">Insights</p>
          <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Reports &amp; analytics</h1>
          <p className="mt-2 max-w-2xl text-slate-500">Counts are drawn from every non-archived contract. Select a row to open the matching list.</p>
        </div>
        <button
          type="button"
          onClick={fetchSummary}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-[#d51d29] hover:text-[#d51d29] disabled:opacity-60 md:self-auto"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={fetchSummary}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {failed ? (
        <div className="rounded-[26px] border border-slate-200 bg-white shadow-sm">
          <EmptyState
            title="Reports unavailable"
            description="The analytics could not be loaded, so no figures can be shown. This is a loading failure rather than an empty repository."
          />
        </div>
      ) : isEmpty ? (
        <div className="rounded-[26px] border border-slate-200 bg-white shadow-sm">
          <EmptyState
            title="No analytics yet"
            description="Reports are generated from the contracts in your repository. Add or approve contracts and the figures will appear here."
          />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {cards.map(({ label, value, tone, detail }) => (
              <div key={label} className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="text-sm text-slate-500">{label}</div>
                <div className={`mt-2 text-3xl font-bold tabular-nums ${METRIC_TONE[tone]}`}>{value}</div>
                {detail && <div className="mt-1 text-xs leading-snug text-slate-500">{detail}</div>}
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown
              title="Status Breakdown"
              rows={statusBreakdown}
              filterKey="status"
              emptyTitle="No status breakdown"
              emptyDescription="Contracts grouped by lifecycle status will appear here."
            />
            <Breakdown
              title="Type Breakdown"
              rows={typeBreakdown}
              filterKey="type"
              emptyTitle="No type breakdown"
              emptyDescription="Contracts grouped by agreement type will appear here."
            />
          </div>
        </>
      )}
    </div>
  );
};

export default Reports;
