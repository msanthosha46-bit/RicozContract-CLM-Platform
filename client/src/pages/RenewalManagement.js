import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { AlertTriangle, CalendarClock } from 'lucide-react';

const RenewalManagement = () => {
  const [expiringContracts, setExpiringContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
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

    fetchExpiringContracts();
  }, []);

  const renewContract = async (contractId) => {
    const newEndDate = window.prompt('Enter new end date (YYYY-MM-DD):');
    if (!newEndDate) return;

    try {
      await API.post(`/renewals/renew/${contractId}`, { newEndDate, notes: 'Renewed from dashboard' });
      const { data } = await API.get('/renewals/expiring');
      setExpiringContracts(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Renewal failed');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading renewal records...</div>;
  }

  return (
    <div className="space-y-8">
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
                      onClick={() => renewContract(contract._id)}
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
  );
};

export default RenewalManagement;
