import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import API from '../services/api';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import SubmitButton from '../components/Layout/Common/SubmitButton';

const CreateContract = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    title: '',
    type: 'Vendor',
    partyName: '',
    description: '',
    startDate: '',
    endDate: '',
    amount: '',
    currency: 'USD'
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      await API.post('/contracts', formData);
      navigate('/contracts');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create contract');
      setSaving(false);
    }
  };

  const field = 'mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#eaf1ff] text-[#1d4ed8]"><FilePlus2 className="h-6 w-6" /></div>
        <div>
          <p className="ricoz-eyebrow">Contract workspace</p>
          <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Create a new contract</h1>
          <p className="mt-2 text-slate-500">Capture the commercial details now and keep the agreement ready for review.</p>
        </div>
      </div>

      <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            {/* `htmlFor` + `id` pairs: the label text is not nested around the
                control here, so without them a tap on the label does nothing. */}
            <label htmlFor="create-title" className="block text-sm font-semibold text-slate-700">Contract title</label>
            <input id="create-title" required type="text" name="title" value={formData.title} onChange={handleChange} className={field} />
          </div>
          <div>
            <label htmlFor="create-type" className="block text-sm font-semibold text-slate-700">Contract type</label>
            <select id="create-type" name="type" value={formData.type} onChange={handleChange} className={field}>
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
            <label htmlFor="create-party" className="block text-sm font-semibold text-slate-700">Counterparty or vendor name</label>
            <input id="create-party" required type="text" name="partyName" value={formData.partyName} onChange={handleChange} className={field} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="create-amount" className="block text-sm font-semibold text-slate-700">Amount</label>
              <input id="create-amount" required type="number" inputMode="decimal" min="0" name="amount" value={formData.amount} onChange={handleChange} className={field} />
            </div>
            <div>
              <label htmlFor="create-currency" className="block text-sm font-semibold text-slate-700">Currency</label>
              <select id="create-currency" name="currency" value={formData.currency} onChange={handleChange} className={field}>
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
            <label htmlFor="create-start" className="block text-sm font-semibold text-slate-700">Start date</label>
            <input id="create-start" required type="date" name="startDate" value={formData.startDate} onChange={handleChange} className={field} />
          </div>
          <div>
            <label htmlFor="create-end" className="block text-sm font-semibold text-slate-700">End date</label>
            <input id="create-end" required type="date" name="endDate" value={formData.endDate} onChange={handleChange} className={field} />
          </div>
        </div>

        <div>
          <label htmlFor="create-description" className="block text-sm font-semibold text-slate-700">Description or summary</label>
          <textarea id="create-description" rows="4" name="description" value={formData.description} onChange={handleChange} className={field} />
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-between">
          <button type="button" onClick={() => navigate('/contracts')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Cancel</button>
          <SubmitButton
            loading={saving}
            loadingLabel="Saving draft…"
            className="rounded-xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-200 hover:bg-[#1e293b]"
          >
            Save draft
          </SubmitButton>
        </div>
      </form>
      </div>
    </div>
  );
};

export default CreateContract;
