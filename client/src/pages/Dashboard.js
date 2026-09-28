import React, { useContext, useEffect, useState } from 'react';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  FileText,
  Layers,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AuthContext } from '../context/AuthContext';
import { PageSkeleton, SkeletonRows } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';

const currencyLocale = (currency) => (currency === 'INR' ? 'en-IN' : 'en-US');

const formatCurrency = (value, currency = 'USD') => {
  const safe = Number(value) || 0;
  const locale = currencyLocale(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(safe);
};

const totalLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(r.total, r.currency)}`) : [formatCurrency(0)]);
const activeLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(r.active, r.currency)}`) : [formatCurrency(0)]);
const outstandingLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(Math.max(r.total - r.active, 0), r.currency)}`) : [formatCurrency(0)]);

// Every contract not in Active, whatever state it is in. Used to caption the
// "outstanding" figures so the money shown is described by the same
// population it is actually summed over.
const notActiveCount = (metrics) => Math.max((metrics?.total || 0) - (metrics?.active || 0), 0);

// Contracts sitting in a review/approval state, i.e. the ones a user can
// actually move forward. Ordered to match the lifecycle so the queue reads
// top to bottom.
const IN_FLIGHT = ['Draft', 'Pending Review', 'Pending Approval', 'Approved'];

const Dashboard = () => {
  const { user } = useContext(AuthContext);
  const [metrics, setMetrics] = useState(null);
  const [statusBreakdown, setStatusBreakdown] = useState([]);
  const [valueByCurrency, setValueByCurrency] = useState([]);
  const [recentContracts, setRecentContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const canViewReports = ['Admin', 'Manager'].includes(user?.role);

  const fetchDashboardData = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await API.get('/reports/dashboard');
      setMetrics(data.metrics);
      setStatusBreakdown(data.statusBreakdown || []);
      setValueByCurrency(data.valueByCurrency || []);
      setRecentContracts(data.recentContracts || []);
    } catch (err) {
      setMetrics(null);
      setStatusBreakdown([]);
      setValueByCurrency([]);
      setRecentContracts([]);
      setError(err.response?.data?.message || 'Unable to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  if (loading) {
    return (
      <div className="space-y-7">
        <PageSkeleton cards={4} />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2.2fr)_minmax(280px,1fr)]">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <SkeletonRows rows={5} />
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <SkeletonRows rows={3} />
          </div>
        </div>
      </div>
    );
  }

  const totalValue = totalLines(valueByCurrency);
  const activeValue = activeLines(valueByCurrency);
  const outstandingValue = outstandingLines(valueByCurrency);
  // The server returns statuses in lifecycle order; `item._id || 'Unknown'`
  // guards a legacy document with a blank status, which would otherwise
  // render an unlabelled bar.
  const chartData = statusBreakdown.map((item) => ({ status: item._id || 'Unknown', count: item.count }));
  const workflowRows = IN_FLIGHT
    .map((status) => ({ status, count: statusBreakdown.find((item) => (item._id || 'Unknown') === status)?.count || 0 }))
    .filter((row) => row.count > 0);

  const summaryCards = [
    { label: 'Total contract value', value: totalValue, detail: `${metrics?.total || 0} contracts in your repository`, icon: Layers, accent: 'border-t-[#0f1d3a]', iconColor: 'text-[#0f1d3a]' },
    { label: 'Active value', value: activeValue, detail: `${metrics?.active || 0} active contracts`, icon: CheckCircle2, accent: 'border-t-[#16a36b]', iconColor: 'text-[#16a36b]' },
    // Captioned by the population the figure sums over: total minus Active,
    // which is every draft, pending, expired, renewed and closed contract.
    // It used to read "<n> awaiting approval", a different and much smaller
    // set than the money above it.
    { label: 'Non-active value', value: outstandingValue, detail: `${notActiveCount(metrics)} contracts outside Active status`, icon: FileText, accent: 'border-t-[#d51d29]', iconColor: 'text-[#d51d29]' },
    { label: 'Expiring soon', value: [String(metrics?.expiringSoon || 0)], detail: 'Active or approved, ending within 30 days', icon: AlertTriangle, accent: 'border-t-[#f59e0b]', iconColor: 'text-[#f59e0b]', isCount: true },
  ];

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="ricoz-eyebrow">Overview</p>
          <h1 className="text-4xl font-black tracking-[-0.07em] text-[#0f1d3a] md:text-5xl">Contract overview</h1>
          <p className="mt-2 text-lg text-slate-500">Track live agreements, approvals, and upcoming expiries.</p>
        </div>
        <div className="flex gap-3">
          <span className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm"><CalendarDays className="h-4 w-4" /> Current workspace</span>
          {canViewReports && (
            <Link to="/reports" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm">Reports</Link>
          )}
        </div>
      </section>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchDashboardData} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      {/* Without data every figure above would render as a real-looking 0,
          which reads as "you have no contracts" rather than "we could not
          ask". Only the panels that have something to show are rendered. */}
      {!metrics ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <EmptyState
            icon={AlertTriangle}
            title={error ? 'Dashboard data unavailable' : 'No dashboard data'}
            description={error
              ? 'The figures could not be loaded. Use Retry above to try again.'
              : 'Once contracts are added, your overview appears here.'}
            action={error ? null : <Link to="/contracts" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-[#d51d29] hover:text-[#d51d29]">Browse contracts</Link>}
          />
        </div>
      ) : (
        <>
      <section>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(({ label, value, detail, icon: Icon, accent, iconColor, isCount }) => (
            <div key={label} className={`rounded-2xl border border-slate-200 border-t-4 ${accent} bg-white p-6 shadow-sm`}>
              <div className="flex items-start justify-between"><span className="text-sm font-semibold text-slate-500">{label}</span><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50"><Icon className={`h-5 w-5 ${iconColor}`} /></span></div>
              <div className="mt-6 space-y-1">
                {value.map((line, index) => (
                  <div key={index} className={`${isCount ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'} break-words font-black tabular-nums tracking-[-0.06em] text-[#0f1d3a]`}>{line}</div>
                ))}
              </div>
              <p className="mt-1 text-sm text-slate-500">{detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,2.2fr)_minmax(280px,1fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-black text-[#0f1d3a]">Status breakdown</h2>
          <p className="mt-1 text-sm text-slate-500">
            Counts from your current contract repository
            {chartData.length > 0 && <span className="text-slate-400"> · {metrics?.total || 0} contracts in total</span>}
          </p>
          <div className="mt-6 h-64">
            {chartData.length === 0 ? (
              <EmptyState title="No contract data yet" description="Once contracts are added, their status spread appears here." compact />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#e8ebef" vertical={false} />
                  <XAxis dataKey="status" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#0f1d3a" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-black text-[#0f1d3a]">Quick actions</h2>
          <p className="mt-1 text-sm text-slate-500">Common workspace tasks</p>
          <div className="mt-5 space-y-3">
            <Link to="/contracts/create" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><FileText className="h-5 w-5 text-[#d51d29]" /> New contract</span><Plus className="h-4 w-4 text-slate-400" /></Link>
            <Link to="/obligations" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-[#d51d29]" /> Track obligation</span><Plus className="h-4 w-4 text-slate-400" /></Link>
            <Link to="/milestones" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><CalendarDays className="h-5 w-5 text-[#d51d29]" /> Review milestone</span><Plus className="h-4 w-4 text-slate-400" /></Link>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-black text-[#0f1d3a]">Recent contracts</h2>
              <p className="mt-1 text-sm text-slate-500">Latest contract activity</p>
            </div>
            <Link to="/contracts" className="text-sm font-bold text-[#d51d29]">View all →</Link>
          </div>
          <div className="mt-5 space-y-3">
            {recentContracts.slice(0, 3).map((contract) => (
              <Link
                key={contract._id}
                to={`/contracts/${contract._id}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 transition last:border-0 hover:border-[#d51d29]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#0f1d3a]">{contract.contractNumber}</p>
                  <StatusBadge status={contract.status} />
                </div>
                <span className="shrink-0 font-bold tabular-nums text-[#0f1d3a]">{formatCurrency(contract.amount, contract.currency)}</span>
              </Link>
            ))}
            {recentContracts.length === 0 && (
              <EmptyState
                compact
                title="No contracts yet"
                description="Contracts you add or approve will show up here."
                action={<Link to="/contracts/create" className="inline-flex items-center gap-2 rounded-xl bg-[#d51d29] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#b91c26]"><Plus className="h-4 w-4" /> New contract</Link>}
              />
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-black text-[#0f1d3a]">Workflow status</h2>
          <p className="mt-1 text-sm text-slate-500">Contracts waiting on a review or approval step</p>
          <div className="mt-5 space-y-3">
            {workflowRows.map(({ status, count }) => (
              <Link
                key={status}
                to={`/contracts?status=${encodeURIComponent(status)}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 transition last:border-0 hover:border-[#d51d29]"
              >
                <StatusBadge status={status} />
                <span className="shrink-0 text-sm font-bold tabular-nums text-[#0f1d3a]">{count}</span>
              </Link>
            ))}
            {workflowRows.length === 0 && (
              <EmptyState
                compact
                title="Nothing in motion"
                description="Every contract is either active, expired or closed. Nothing is waiting on a review or approval step."
                action={<Link to="/contracts" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-[#d51d29] hover:text-[#d51d29]">Browse contracts</Link>}
              />
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-black text-[#0f1d3a]">Value snapshot</h2>
              <p className="mt-1 text-sm text-slate-500">From all contracts in your repository</p>
            </div>
            {canViewReports && <Link to="/reports" className="text-sm font-bold text-[#d51d29]">View all →</Link>}
          </div>
          <div className="mt-6 space-y-4">
            <div className="flex justify-between border-b border-slate-100 pb-4 text-sm"><span className="text-slate-500">Active</span><div className="text-right"><strong className="block text-[#0f1d3a]">{activeValue.join(' · ')}</strong></div></div>
            <div className="flex justify-between text-sm"><span className="text-slate-500">Outside Active</span><div className="text-right"><strong className="block text-[#d51d29]">{outstandingValue.join(' · ')}</strong></div></div>
            <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-[#d51d29]"><AlertTriangle className="h-4 w-4" /> {metrics?.expiringSoon || 0} contracts need attention</div>
          </div>
        </div>
      </section>
        </>
      )}
    </div>
  );
};

export default Dashboard;