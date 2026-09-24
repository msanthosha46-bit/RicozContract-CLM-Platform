import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { CalendarClock, History } from 'lucide-react';
import Modal from '../components/Layout/Common/Modal';
import Toast from '../components/Layout/Common/Toast';
import { formatDate, formatDateTime, toDateInput, daysLabel, reminderTier } from '../utils/date';

const reminderStyles = {
  30: 'bg-red-100 text-red-700',
  60: 'bg-amber-100 text-amber-700',
  90: 'bg-blue-100 text-blue-700'
};

const STATUS_BADGE = {
  Active: 'bg-emerald-100 text-emerald-700',
  Approved: 'bg-blue-100 text-blue-700',
  Expired: 'bg-red-100 text-red-700'
};

const RenewalManagement = () => {
  const [expiringContracts, setExpiringContracts] = useState([]);
  const [history, setHistory] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(null);
  const [newEndDate, setNewEndDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchRenewals = async () => {
    try {
      setLoading(true);
      const [expiringRes, historyRes] = await Promise.all([
        API.get('/renewals/expiring'),
        API.get('/renewals/history')
      ]);
      setExpiringContracts(expiringRes.data);
      setHistory(historyRes.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load renewals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRenewals();
  }, []);

  const openRenew = (contract) => {
    setSelected(contract);
    setNewEndDate('');
    setNotes('');
  };

  const renewContract = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await API.post(`/renewals/renew/${selected._id}`, { newEndDate, notes: notes.trim() || 'Renewed from workspace' });
      setSelected(null);
      setToast({ type: 'success', message: 'Contract renewed and kept active' });
      await fetchRenewals();
    } catch (err) {
      setError(err.response?.data?.message || 'Renewal failed');
    } finally {
      setSaving(false);
    }
  };

  const filtered = filter === 'all'
    ? expiringContracts
    : expiringContracts.filter((contract) => reminderTier(contract.daysRemaining) === filter);

  if (loading) {
    return <div className="p-8 text-slate-500">Loading renewal records...</div>;
  }

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Lifecycle</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Renewal management</h1>
        <p className="mt-2 text-slate-500">Stay ahead of every expiring agreement with 30/60/90-day reminders and a full renewal trail.</p>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchRenewals} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100">Retry</button>
        </div>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-800">Expiring contracts</h2>
          <div className="flex flex-wrap gap-2">
            {[{ value: 'all', label: 'All' }, { value: 30, label: 'Within 30 days' }, { value: 60, label: 'Within 60 days' }, { value: 90, label: 'Within 90 days' }].map((option) => (
              <button
                key={String(option.value)}
                onClick={() => setFilter(option.value)}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${filter === option.value ? 'bg-[#0f172a] text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              {filter === 'all' ? 'No contracts expiring in the next 90 days.' : 'No contracts in this reminder window.'}
            </div>
          ) : (
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Contract</th>
                  <th className="px-4 py-3 font-medium">Party</th>
                  <th className="px-4 py-3 font-medium">End Date</th>
                  <th className="px-4 py-3 font-medium">Days Remaining</th>
                  <th className="px-4 py-3 font-medium">Reminder</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((contract) => (
                  <tr key={contract._id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{contract.title}</div>
                      <div className="text-xs text-slate-500">{contract.contractNumber}</div>
                    </td>
                    <td className="px-4 py-3">{contract.partyName}</td>
                    <td className="px-4 py-3">{formatDate(contract.endDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${contract.daysRemaining <= 30 ? 'bg-red-100 text-red-700' : contract.daysRemaining <= 60 ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                        {daysLabel(contract.daysRemaining)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${reminderStyles[contract.reminder] || 'bg-slate-100 text-slate-600'}`}>
                        {contract.reminder}-day
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_BADGE[contract.status] || 'bg-slate-100 text-slate-700'}`}>
                        {contract.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openRenew(contract)}
                        className="inline-flex items-center gap-2 rounded-xl bg-[#0f172a] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1e293b]"
                      >
                        <CalendarClock className="h-3.5 w-3.5" /> Renew
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-[#1d4ed8]" />
          <h2 className="text-lg font-bold text-slate-800">Renewal history</h2>
        </div>
        <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
          {history.length === 0 ? (
            <div className="p-8 text-center text-slate-500">No renewals recorded yet. Renew a contract to build your history.</div>
          ) : (
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Contract</th>
                  <th className="px-4 py-3 font-medium">Previous End Date</th>
                  <th className="px-4 py-3 font-medium">New End Date</th>
                  <th className="px-4 py-3 font-medium">Renewed By</th>
                  <th className="px-4 py-3 font-medium">Renewed On</th>
                  <th className="px-4 py-3 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((entry) => (
                  <tr key={entry._id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{entry.contract?.title || 'Unknown contract'}</div>
                      <div className="text-xs text-slate-500">{entry.contract?.contractNumber || ''}</div>
                    </td>
                    <td className="px-4 py-3">{formatDate(entry.oldEndDate)}</td>
                    <td className="px-4 py-3">{formatDate(entry.newEndDate)}</td>
                    <td className="px-4 py-3">{entry.renewedBy?.name || 'Unknown'}</td>
                    <td className="px-4 py-3">{formatDateTime(entry.createdAt)}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{entry.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        isOpen={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Renew ${selected.contractNumber}` : 'Renew contract'}
        footer={
          <>
            <button onClick={() => setSelected(null)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button form="renew-form" disabled={saving} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? 'Renewing...' : 'Confirm renewal'}
            </button>
          </>
        }
      >
        <form id="renew-form" onSubmit={renewContract} className="space-y-3">
          <label className="block text-sm font-medium">
            New end date
            <input
              required
              type="date"
              min={toDateInput(new Date(Date.now() + (selected ? selected.daysRemaining + 1 : 1) * 86400000))}
              value={newEndDate}
              onChange={(event) => setNewEndDate(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-200 p-3"
            />
            {selected && <span className="mt-1 block text-xs text-slate-400">Current end date: {formatDate(selected.endDate)} ({daysLabel(selected.daysRemaining)}). Must be later than the current end date.</span>}
          </label>
          <textarea placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
        </form>
      </Modal>
    </div>
  );
};

export default RenewalManagement;

