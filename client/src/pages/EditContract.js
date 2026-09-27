import React, { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import API from '../services/api';
import { AuthContext } from '../context/AuthContext';
import { canTransition, getManualEditTargets } from '../utils/contractTransitions';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import { SkeletonText } from '../components/Layout/Common/Skeleton';

const EditContract = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  const canEditStatus = ['Admin', 'Manager'].includes(user?.role);
  const [currentStatus, setCurrentStatus] = useState('Draft');
  const [formData, setFormData] = useState({
    title: '',
    type: 'Vendor',
    partyName: '',
    description: '',
    startDate: '',
    endDate: '',
    amount: '',
    currency: 'USD',
    status: 'Draft'
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchContract = async () => {
      try {
        const { data } = await API.get(`/contracts/${id}`);
        setFormData({
          title: data.title || '',
          type: data.type || 'Vendor',
          partyName: data.partyName || '',
          description: data.description || '',
          startDate: data.startDate ? new Date(data.startDate).toISOString().slice(0, 10) : '',
          endDate: data.endDate ? new Date(data.endDate).toISOString().slice(0, 10) : '',
          amount: data.amount || '',
          currency: data.currency || 'USD',
          status: data.status || 'Draft'
        });
        setCurrentStatus(data.status || 'Draft');
      } catch (err) {
        setError(err.response?.data?.message || 'Unable to load contract');
      } finally {
        setLoading(false);
      }
    };

    fetchContract();
  }, [id]);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const field = 'mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (canEditStatus && formData.status !== currentStatus && !canTransition(currentStatus, formData.status)) {
      setError(`Status cannot change from '${currentStatus}' to '${formData.status}'. Please pick an allowed option.`);
      return;
    }
    setError('');
    setSaving(true);
    try {
      const payload = { ...formData };
      if (!canEditStatus) delete payload.status;
      await API.put(`/contracts/${id}`, payload);
      navigate(`/contracts/${id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update contract');
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading contract editor…</span>
        <SkeletonText lines={1} className="w-32 max-w-[10rem]" />
        <div className="my-6">
          <SkeletonText lines={1} className="h-9 w-64 max-w-full" />
        </div>
        <div className="space-y-4">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} aria-hidden="true" className="ricoz-skeleton h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <p className="ricoz-eyebrow">Contract workspace</p>
      <h1 className="mb-6 text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Edit contract</h1>
      {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="edit-title" className="block text-sm font-semibold text-slate-700">Contract title</label>
            <input id="edit-title" required type="text" name="title" value={formData.title} onChange={handleChange} className={field} />
          </div>
          <div>
            <label htmlFor="edit-type" className="block text-sm font-semibold text-slate-700">Contract type</label>
            <select id="edit-type" name="type" value={formData.type} onChange={handleChange} className={field}>
              <option value="Vendor">Vendor</option>
              <option value="Client">Client</option>
              <option value="NDA">NDA</option>
              <option value="SLA">SLA</option>
              <option value="Employment">Employment</option>
              <option value="Partnership">Partnership</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="edit-party" className="block text-sm font-semibold text-slate-700">Counterparty or vendor name</label>
            <input id="edit-party" required type="text" name="partyName" value={formData.partyName} onChange={handleChange} className={field} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="edit-amount" className="block text-sm font-semibold text-slate-700">Amount</label>
              <input id="edit-amount" required type="number" inputMode="decimal" min="0" name="amount" value={formData.amount} onChange={handleChange} className={field} />
            </div>
            <div>
              <label htmlFor="edit-currency" className="block text-sm font-semibold text-slate-700">Currency</label>
              <select id="edit-currency" name="currency" value={formData.currency} onChange={handleChange} className={field}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="INR">INR</option>
              </select>
            </div>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="edit-start" className="block text-sm font-semibold text-slate-700">Start date</label>
            <input id="edit-start" required type="date" name="startDate" value={formData.startDate} onChange={handleChange} className={field} />
          </div>
          <div>
            <label htmlFor="edit-end" className="block text-sm font-semibold text-slate-700">End date</label>
            <input id="edit-end" required type="date" name="endDate" value={formData.endDate} onChange={handleChange} className={field} />
          </div>
        </div>

        {canEditStatus && (
        <div>
          <label htmlFor="edit-status" className="mb-1 block text-xs font-semibold text-slate-600">Status</label>
          <select id="edit-status" name="status" value={formData.status} onChange={handleChange} className={field}>
            {getManualEditTargets(currentStatus).map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            From 'Draft' or 'Rejected', submit via the contract page for approval. Only the backend-approved moves are offered.
          </p>
        </div>
        )}

        <div>
          <label htmlFor="edit-description" className="mb-1 block text-xs font-semibold text-slate-600">Description / Summary</label>
          <textarea id="edit-description" rows="4" name="description" value={formData.description} onChange={handleChange} className={field} />
        </div>

        <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => navigate(`/contracts/${id}`)} className="rounded-xl border px-4 py-2 text-sm font-medium text-slate-600">Cancel</button>
          <SubmitButton
            loading={saving}
            loadingLabel="Saving…"
            className="rounded-xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white hover:bg-[#1e293b]"
          >
            Save changes
          </SubmitButton>
        </div>
      </form>
    </div>
  );
};

export default EditContract;
