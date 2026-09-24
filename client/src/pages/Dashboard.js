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

const currencyLocale = (currency) => (currency === 'INR' ? 'en-IN' : 'en-US');

const formatCurrency = (value, currency = 'USD') => {
  const safe = Number(value) || 0;
  const locale = currencyLocale(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(safe);
};

const totalLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(r.total, r.currency)}`) : [formatCurrency(0)]);
const activeLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(r.active, r.currency)}`) : [formatCurrency(0)]);
const outstandingLines = (rows) => (rows.length ? rows.map((r) => `${r.currency} ${formatCurrency(Math.max(r.total - r.active, 0), r.currency)}`) : [formatCurrency(0)]);

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

  if (loading) return <div className="p-8 text-slate-500">Loading Dashboard...</div>;

  const totalValue = totalLines(valueByCurrency);
  const activeValue = activeLines(valueByCurrency);
  const outstandingValue = outstandingLines(valueByCurrency);
  const chartData = statusBreakdown.map((item) => ({ status: item._id, count: item.count }));

  const summaryCards = [
    { label: 'Total contract value', value: totalValue, detail: `${metrics?.total || 0} contracts in your repository`, icon: Layers, accent: 'border-t-[#0f1d3a]', iconColor: 'text-[#0f1d3a]' },
    { label: 'Active value', value: activeValue, detail: `${metrics?.active || 0} active contracts`, icon: CheckCircle2, accent: 'border-t-[#16a36b]', iconColor: 'text-[#16a36b]' },
    { label: 'Outstanding value', value: outstandingValue, detail: `${metrics?.pending || 0} awaiting approval`, icon: FileText, accent: 'border-t-[#d51d29]', iconColor: 'text-[#d51d29]' },
    { label: 'Expiring soon', value: [String(metrics?.expiringSoon || 0)], detail: 'Within the next 30 days', icon: AlertTriangle, accent: 'border-t-[#f59e0b]', iconColor: 'text-[#f59e0b]', isCount: true },
  ];

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#d51d29]">Overview</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.07em] text-[#0f1d3a] md:text-5xl">Contract overview</h1>
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
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchDashboardData} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      <section>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(({ label, value, detail, icon: Icon, accent, iconColor, isCount }) => (
            <div key={label} className={`rounded-2xl border border-slate-200 border-t-4 ${accent} bg-white p-6 shadow-sm`}>
              <div className="flex items-start justify-between"><span className="text-sm font-semibold text-slate-500">{label}</span><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50"><Icon className={`h-5 w-5 ${iconColor}`} /></span></div>
              <div className="mt-6 space-y-1">
                {value.map((line, index) => (
                  <div key={index} className={`${isCount ? 'text-4xl' : 'text-2xl'} font-black tracking-[-0.06em] text-[#0f1d3a]`}>{line}</div>
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
          <p className="mt-1 text-sm text-slate-500">Counts from your current contract repository</p>
          <div className="mt-6 h-64">
            {chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">No contract data yet.</div>
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
              <div key={contract._id} className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <p className="text-sm font-bold text-[#0f1d3a]">{contract.contractNumber}</p>
                  <StatusBadge status={contract.status} />
                </div>
                <span className="font-bold text-[#0f1d3a]">{formatCurrency(contract.amount, contract.currency)}</span>
              </div>
            ))}
            {recentContracts.length === 0 && <div className="text-sm text-slate-500">No contracts yet.</div>}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-black text-[#0f1d3a]">Workflow status</h2>
              <p className="mt-1 text-sm text-slate-500">Latest agreements in motion</p>
            </div>
            <Link to={canViewReports ? '/approvals' : '/contracts'} className="text-sm font-bold text-[#d51d29]">View all →</Link>
          </div>
          <div className="mt-5 space-y-3">
            {recentContracts.slice(0, 3).map((contract) => (
              <div key={contract._id} className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <p className="text-sm font-bold text-[#0f1d3a]">{contract.title}</p>
                  <p className="text-xs text-slate-500">{contract.partyName}</p>
                </div>
                <StatusBadge status={contract.status} />
              </div>
            ))}
            {recentContracts.length === 0 && <div className="text-sm text-slate-500">No contracts yet.</div>}
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
            <div className="flex justify-between text-sm"><span className="text-slate-500">Awaiting action</span><div className="text-right"><strong className="block text-[#d51d29]">{outstandingValue.join(' · ')}</strong></div></div>
            <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-[#d51d29]"><AlertTriangle className="h-4 w-4" /> {metrics?.expiringSoon || 0} contracts need attention</div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Dashboard;