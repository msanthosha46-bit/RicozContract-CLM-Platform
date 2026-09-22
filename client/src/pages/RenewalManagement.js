import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { CalendarClock } from 'lucide-react';
import Modal from '../components/Layout/Common/Modal';
import Toast from '../components/Layout/Common/Toast';

const RenewalManagement = () => {
  const [expiringContracts, setExpiringContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(null);
  const [newEndDate, setNewEndDate] = useState('');
  const [notes, setNotes] = useState('');

  const fetchExpiringContracts = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/renewals/expiring');
      setExpiringContracts(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load renewals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExpiringContracts();
  }, []);

  const renewContract = async (event) => {
    event.preventDefault();
    try {
      await API.post(`/renewals/renew/${selected._id}`, { newEndDate, notes: notes || 'Renewed from workspace' });
      setSelected(null);
      setToast({ type: 'success', message: 'Contract renewed and kept active' });
      await fetchExpiringContracts();
    } catch (err) {
      setError(err.response?.data?.message || 'Renewal failed');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading renewal records...</div>;
  }

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Lifecycle</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Renewal management</h1>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {expiringContracts.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No contracts expiring in the next 90 days.</div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Party</th>
                <th className="px-4 py-3 font-medium">Current End Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {expiringContracts.map((contract) => (
                <tr key={contract._id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{contract.title}</div>
                    <div className="text-xs text-slate-500">{contract.contractNumber}</div>
                  </td>
                  <td className="px-4 py-3">{contract.partyName}</td>
                  <td className="px-4 py-3">{new Date(contract.endDate).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                      {contract.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => {
                        setSelected(contract);
                        setNewEndDate('');
                        setNotes('');
                      }}
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

      <Modal
        isOpen={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Renew ${selected.contractNumber}` : 'Renew contract'}
        footer={
          <>
            <button onClick={() => setSelected(null)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button form="renew-form" className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white">Confirm renewal</button>
          </>
        }
      >
        <form id="renew-form" onSubmit={renewContract} className="space-y-3">
          <label className="block text-sm font-medium">
            New end date
            <input required type="date" value={newEndDate} onChange={(event) => setNewEndDate(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 p-3" />
          </label>
          <textarea placeholder="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
        </form>
      </Modal>
    </div>
  );
};

export default RenewalManagement;
