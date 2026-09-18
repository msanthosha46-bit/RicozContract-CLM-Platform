import React, { useEffect, useState } from 'react';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import { Link } from 'react-router-dom';
import { Search, Plus, FileText, SlidersHorizontal } from 'lucide-react';

const ContractsList = () => {
  const [contracts, setContracts] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchContracts = async () => {
    try {
      setLoading(true);
      const query = new URLSearchParams({ search, status, type }).toString();
      const { data } = await API.get(`/contracts?${query}`);
      setContracts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContracts();
  }, [search, status, type]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Your workspace</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Contract repository</h1>
          <p className="mt-2 max-w-xl text-slate-500">Keep every agreement, owner, renewal date, and commercial detail in one clear view.</p>
        </div>
        <Link
          to="/contracts/create"
          className="inline-flex items-center gap-2 rounded-2xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-200 transition hover:bg-[#1e293b]"
        >
          <Plus className="h-4 w-4" /> Create contract
        </Link>
      </div>

      <div className="flex items-center gap-3 text-sm font-semibold text-slate-700">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#eaf1ff] text-[#1d4ed8]"><FileText className="h-4 w-4" /></div>
        <span>{contracts.length} contracts in your repository</span>
      </div>

      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          <SlidersHorizontal className="h-4 w-4" /> Filter and search
        </div>
        <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by Title, Number, or Party..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-[#f8fafc] py-3 pl-9 pr-4 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100"
          />
        </div>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-xl border border-slate-200 bg-[#f8fafc] px-3 py-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100"
        >
          <option value="">All Statuses</option>
          <option value="Draft">Draft</option>
          <option value="Pending Approval">Pending Approval</option>
          <option value="Active">Active</option>
          <option value="Expired">Expired</option>
          <option value="Renewed">Renewed</option>
        </select>

        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-xl border border-slate-200 bg-[#f8fafc] px-3 py-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100"
        >
          <option value="">All Types</option>
          <option value="Vendor">Vendor</option>
          <option value="Client">Client</option>
          <option value="NDA">NDA</option>
          <option value="SLA">SLA</option>
        </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-10 text-center text-slate-500">Loading contracts...</div>
        ) : contracts.length === 0 ? (
          <div className="p-10 text-center text-slate-500">No contracts found matching these filters.</div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="border-b border-slate-200 bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="py-3 px-4">Contract #</th>
                <th className="py-3 px-4">Title</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Party Name</th>
                <th className="py-3 px-4">End Date</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contracts.map((c) => (
                <tr key={c._id} className="transition hover:bg-[#f8fafc]">
                  <td className="py-3 px-4 font-mono text-xs text-slate-500">{c.contractNumber}</td>
                  <td className="py-3 px-4 font-semibold text-slate-800">{c.title}</td>
                  <td className="py-3 px-4">{c.type}</td>
                  <td className="py-3 px-4">{c.partyName}</td>
                  <td className="py-3 px-4">{new Date(c.endDate).toLocaleDateString()}</td>
                  <td className="py-3 px-4 font-medium">{c.currency} {c.amount.toLocaleString()}</td>
                  <td className="py-3 px-4"><StatusBadge status={c.status} /></td>
                  <td className="py-3 px-4 text-right space-x-2">
                    <Link to={`/contracts/${c._id}`} className="text-xs font-semibold text-[#1d4ed8] hover:text-[#1e40af]">
                      Details
                    </Link>
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

export default ContractsList;