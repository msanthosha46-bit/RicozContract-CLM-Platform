import React, { useEffect, useState } from 'react';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Layers,
  Plus,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const Dashboard = () => {
  const [metrics, setMetrics] = useState(null);
  const [recentContracts, setRecentContracts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        const [repRes, cntRes] = await Promise.all([
          API.get('/reports/summary'),
          API.get('/contracts?sort=newest')
        ]);
        setMetrics(repRes.data.metrics);
        setRecentContracts(cntRes.data.slice(0, 5));
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchDashboardData();
  }, []);

  if (loading) return <div className="p-8 text-slate-500">Loading Dashboard...</div>;

  const totalValue = recentContracts.reduce((sum, contract) => sum + Number(contract.amount || 0), 0);
  const activeValue = recentContracts
    .filter((contract) => contract.status === 'Active')
    .reduce((sum, contract) => sum + Number(contract.amount || 0), 0);
  const outstandingValue = Math.max(totalValue - activeValue, 0);
  const chartData = [
    { period: 'Week 1', billed: totalValue * 0.2, collected: activeValue * 0.25 },
    { period: 'Week 2', billed: totalValue * 0.42, collected: activeValue * 0.45 },
    { period: 'Week 3', billed: totalValue * 0.7, collected: activeValue * 0.62 },
    { period: 'Week 4', billed: totalValue, collected: activeValue },
  ];
  const formatCurrency = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;

  const summaryCards = [
    { label: 'Total contract value', value: totalValue, detail: `${metrics?.total || 0} contracts in this period`, icon: Layers, accent: 'border-t-[#0f1d3a]', iconColor: 'text-[#0f1d3a]' },
    { label: 'Active value', value: activeValue, detail: `${metrics?.active || 0} active contracts`, icon: CheckCircle2, accent: 'border-t-[#16a36b]', iconColor: 'text-[#16a36b]' },
    { label: 'Outstanding value', value: outstandingValue, detail: `${metrics?.pending || 0} awaiting approval`, icon: FileText, accent: 'border-t-[#d51d29]', iconColor: 'text-[#d51d29]' },
    { label: 'Expiring soon', value: metrics?.expiringSoon || 0, detail: 'Within the next 30 days', icon: AlertTriangle, accent: 'border-t-[#f59e0b]', iconColor: 'text-[#f59e0b]', isCount: true },
  ];

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-[#d51d29]">Overview</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.07em] text-[#0f1d3a] md:text-5xl">Financial overview</h1>
          <p className="mt-2 text-lg text-slate-500">Track what is billed, collected, and still outstanding.</p>
        </div>
        <div className="flex gap-3">
          <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm"><CalendarDays className="h-4 w-4" /> This month <ChevronDown className="h-4 w-4" /></button>
          <Link to="/reports" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm"><Download className="h-4 w-4" /> Reports</Link>
        </div>
      </section>

      <section>
        <p className="mb-3 text-sm text-slate-500">This month</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(({ label, value, detail, icon: Icon, accent, iconColor, isCount }) => (
            <div key={label} className={`rounded-2xl border border-slate-200 border-t-4 ${accent} bg-white p-6 shadow-sm`}>
              <div className="flex items-start justify-between"><span className="text-sm font-semibold text-slate-500">{label}</span><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50"><Icon className={`h-5 w-5 ${iconColor}`} /></span></div>
              <div className="mt-6 text-3xl font-black tracking-[-0.06em] text-[#0f1d3a]">{isCount ? value : formatCurrency(value)}</div>
              <p className="mt-1 text-sm text-slate-500">{detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,2.2fr)_minmax(280px,1fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between"><div><h2 className="text-xl font-black text-[#0f1d3a]">Cash flow</h2><p className="mt-1 text-sm text-slate-500">Billed and collected during this period</p></div><TrendingUp className="h-5 w-5 text-[#16a36b]" /></div>
          <div className="mt-6 h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><defs><linearGradient id="billedFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0f1d3a" stopOpacity={0.18} /><stop offset="100%" stopColor="#0f1d3a" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid stroke="#e8ebef" vertical={false} /><XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} tickFormatter={(value) => `₹${Math.round(value / 1000)}k`} /><Tooltip formatter={(value) => formatCurrency(value)} /><Area type="monotone" dataKey="billed" stroke="#0f1d3a" strokeWidth={3} fill="url(#billedFill)" /><Area type="monotone" dataKey="collected" stroke="#d51d29" strokeWidth={3} fill="none" /></AreaChart></ResponsiveContainer></div>
          <div className="mt-3 flex justify-center gap-5 text-xs font-semibold"><span className="text-[#0f1d3a]">● Billed</span><span className="text-[#d51d29]">● Collected</span></div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-xl font-black text-[#0f1d3a]">Quick actions</h2><p className="mt-1 text-sm text-slate-500">Common workspace tasks</p><div className="mt-5 space-y-3"><Link to="/contracts/create" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><FileText className="h-5 w-5 text-[#d51d29]" /> New contract</span><Plus className="h-4 w-4 text-slate-400" /></Link><Link to="/obligations" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-[#d51d29]" /> Track obligation</span><Plus className="h-4 w-4 text-slate-400" /></Link><Link to="/milestones" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8fafc] p-4 font-semibold text-[#0f1d3a] hover:border-[#d51d29]"><span className="flex items-center gap-3"><CalendarDays className="h-5 w-5 text-[#d51d29]" /> Review milestone</span><Plus className="h-4 w-4 text-slate-400" /></Link></div></div>
      </section>

      <section className="grid gap-5 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="text-xl font-black text-[#0f1d3a]">Recent contracts</h2><p className="mt-1 text-sm text-slate-500">Latest contract activity</p></div><Link to="/contracts" className="text-sm font-bold text-[#d51d29]">View all →</Link></div><div className="mt-5 space-y-3">{recentContracts.slice(0, 3).map((contract) => <div key={contract._id} className="flex items-center justify-between border-b border-slate-100 pb-3"><div><p className="text-sm font-bold text-[#0f1d3a]">{contract.contractNumber}</p><StatusBadge status={contract.status} /></div><span className="font-bold text-[#0f1d3a]">{formatCurrency(contract.amount)}</span></div>)}</div></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="text-xl font-black text-[#0f1d3a]">Recent approvals</h2><p className="mt-1 text-sm text-slate-500">Latest workflow status</p></div><Link to="/obligations" className="text-sm font-bold text-[#d51d29]">View all →</Link></div><div className="mt-5 space-y-3">{recentContracts.slice(0, 3).map((contract) => <div key={contract._id} className="flex items-center justify-between border-b border-slate-100 pb-3"><div><p className="text-sm font-bold text-[#0f1d3a]">{contract.title}</p><p className="text-xs text-slate-500">{contract.partyName}</p></div><StatusBadge status={contract.status} /></div>)}</div></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="text-xl font-black text-[#0f1d3a]">Receivables aging</h2><p className="mt-1 text-sm text-slate-500">Outstanding value by status</p></div><Link to="/reports" className="text-sm font-bold text-[#d51d29]">View all →</Link></div><div className="mt-6 space-y-4"><div className="flex justify-between border-b border-slate-100 pb-4 text-sm"><span className="text-slate-500">Active</span><strong className="text-[#0f1d3a]">{formatCurrency(activeValue)}</strong></div><div className="flex justify-between text-sm"><span className="text-slate-500">Awaiting action</span><strong className="text-[#d51d29]">{formatCurrency(outstandingValue)}</strong></div><div className="mt-3 flex items-center gap-2 text-sm font-semibold text-[#d51d29]"><AlertTriangle className="h-4 w-4" /> {metrics?.expiringSoon || 0} contracts need attention</div></div></div>
      </section>
    </div>
  );
};

export default Dashboard;
