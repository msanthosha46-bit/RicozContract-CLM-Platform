import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import { Search, Plus, FileText, SlidersHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { SkeletonRows } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';
import { VALID_STATUSES } from '../utils/contractTransitions';

const PAGE_SIZE = 20;

// The contract type vocabulary, mirrored from server/models/Contract.js. The
// filter list used to offer only Vendor/Client/NDA/SLA, so Employment,
// Partnership and Other contracts were impossible to isolate from the
// repository even though the API accepts them.
const CONTRACT_TYPES = ['Vendor', 'Client', 'NDA', 'SLA', 'Employment', 'Partnership', 'Other'];

const ContractsList = () => {
  // The Dashboard workflow panel and the Reports breakdown tables link here with
  // ?status= / ?type=. The URL is the single source of truth for all three
  // filters, so an in-app link replaces the previous filter instead of merging
  // with it (React Router reuses this component when only the query string
  // changes, so a mirrored useState would have kept the stale filter) and
  // pagination state is shareable.
  const [searchParams, setSearchParams] = useSearchParams();

  const rawStatus = searchParams.get('status') || '';
  const rawType = searchParams.get('type') || '';
  const rawPage = Number(searchParams.get('page'));

  // Values outside the server's vocabulary are dropped rather than sent: an
  // unknown status is rejected with a 400, and an unknown type would quietly
  // return an empty page with no explanation.
  const status = VALID_STATUSES.includes(rawStatus) ? rawStatus : '';
  const type = CONTRACT_TYPES.includes(rawType) ? rawType : '';
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [contracts, setContracts] = useState([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const updateParams = (patch) => {
    const next = { status, type, page: String(page), ...patch };
    const clean = {};
    if (next.status) clean.status = next.status;
    if (next.type) clean.type = next.type;
    // Page 1 is the default, so it stays out of the URL.
    if (Number(next.page) > 1) clean.page = next.page;
    setSearchParams(clean, { replace: true });
  };

  const resetToFirstPage = () => {
    if (page !== 1) updateParams({ page: '1' });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      resetToFirstPage();
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchContracts = async () => {
    try {
      setLoading(true);
      setError('');
      const query = new URLSearchParams({ search: debouncedSearch, status, type, page, limit: PAGE_SIZE }).toString();
      const { data } = await API.get(`/contracts?${query}`);
      setContracts(data.contracts);
      setTotal(data.total);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setContracts([]);
      setError(err.response?.data?.message || 'Unable to load contracts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContracts();
  }, [debouncedSearch, status, type, page]);

  const prevPage = () => updateParams({ page: String(page - 1) });
  const nextPage = () => updateParams({ page: String(page + 1) });
  // Rows seen so far, not rows on this page. `Math.min(total, PAGE_SIZE)` said
  // "Showing 20 of 137" on page 3, where rows 41-60 were actually on screen.
  const resultsCount = Math.min(page * PAGE_SIZE, total);
  const hasFilters = Boolean(debouncedSearch || status || type);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="ricoz-eyebrow">Your workspace</p>
          <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Contract repository</h1>
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
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#fff0f0] text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]"><FileText className="h-4 w-4" /></div>
        <span>{total} contracts in your repository {totalPages > 1 && <span className="font-normal text-slate-400">· page {page} of {totalPages}</span>}</span>
      </div>

      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          <SlidersHorizontal className="h-4 w-4" /> Filter and search
        </div>
        <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0 sm:min-w-[240px] relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            type="search"
            aria-label="Search contracts"
            placeholder="Search by Title, Number, or Party..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-[#f8fafc] py-3 pl-9 pr-4 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100"
          />
        </div>

        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => updateParams({ status: e.target.value, page: '1' })}
          className="rounded-xl border border-slate-200 bg-[#f8fafc] px-3 py-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100"
        >
          <option value="">All Statuses</option>
          {VALID_STATUSES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>

        <select
          aria-label="Filter by type"
          value={type}
          onChange={(e) => updateParams({ type: e.target.value, page: '1' })}
          className="rounded-xl border border-slate-200 bg-[#f8fafc] px-3 py-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100"
        >
          <option value="">All Types</option>
          {CONTRACT_TYPES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="px-4 py-2" role="status" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading contracts…</span>
            <SkeletonRows rows={8} columns={6} />
          </div>
        ) : contracts.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No contracts found"
            description={
              hasFilters
                ? 'No contracts match these filters. Try clearing the search or filters.'
                : 'Create your first contract to start tracking agreements, obligations, and renewals.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setDebouncedSearch(''); updateParams({ status: '', type: '', page: '1' }); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-[#d51d29] hover:text-[#d51d29]"
                >
                  <SlidersHorizontal className="h-4 w-4" /> Clear filters
                </button>
              ) : (
                <Link to="/contracts/create" className="inline-flex items-center gap-2 rounded-xl bg-[#d51d29] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#b91c26]">
                  <Plus className="h-4 w-4" /> Create contract
                </Link>
              )
            }
          />
        ) : (
          /* Own scroll container: index.css floors tables at 40rem on a phone
             and this parent clips, so without it the right-hand columns
             (End Date, Amount, Status) would be unreachable. */
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="border-b border-slate-200 bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th scope="col" className="py-3 px-4">Contract #</th>
                  <th scope="col" className="py-3 px-4">Title</th>
                  <th scope="col" className="py-3 px-4">Type</th>
                  <th scope="col" className="py-3 px-4">Party Name</th>
                  <th scope="col" className="py-3 px-4">End Date</th>
                  <th scope="col" className="py-3 px-4">Amount</th>
                  <th scope="col" className="py-3 px-4">Status</th>
                  <th scope="col" className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {contracts.map((c) => (
                  <tr key={c._id} className="transition hover:bg-[#f8fafc]">
                    <td className="py-3 px-4 font-mono text-xs text-slate-500">{c.contractNumber}</td>
                    <td className="py-3 px-4 font-semibold text-slate-800">{c.title}</td>
                    <td className="py-3 px-4">{c.type}</td>
                    <td className="py-3 px-4">{c.partyName}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{new Date(c.endDate).toLocaleDateString()}</td>
                    <td className="py-3 px-4 whitespace-nowrap font-medium tabular-nums">{c.currency} {Number(c.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="py-3 px-4"><StatusBadge status={c.status} /></td>
                    <td className="py-3 px-4 text-right">
                      <Link to={`/contracts/${c._id}`} className="inline-flex rounded-md px-2 py-1 text-xs font-semibold text-[#1d4ed8] hover:text-[#1e40af] focus-visible:bg-blue-100 dark:hover:bg-blue-500/20">
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-slate-500">Showing {resultsCount} of {total}</span>
          <div className="flex items-center gap-1">
            <button onClick={prevPage} disabled={page <= 1} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={nextPage} disabled={page >= totalPages} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractsList;