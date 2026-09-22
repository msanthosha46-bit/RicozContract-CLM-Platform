import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import API from '../services/api';
import { ArrowLeft, FilePlus2 } from 'lucide-react';

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

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await API.post('/contracts', formData);
      navigate('/contracts');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create contract');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf1ff] text-[#1d4ed8]"><FilePlus2 className="h-6 w-6" /></div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Contract workspace</p>
          <h1 className="mt-2 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Create a new contract</h1>
          <p className="mt-2 text-slate-500">Capture the commercial details now and keep the agreement ready for review.</p>
        </div>
      </div>

      <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label className="block text-sm font-semibold text-slate-700">Contract title</label>
            <input required type="text" name="title" value={formData.title} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700">Contract type</label>
            <select name="type" value={formData.type} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100">
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
            <label className="block text-sm font-semibold text-slate-700">Counterparty or vendor name</label>
            <input required type="text" name="partyName" value={formData.partyName} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-semibold text-slate-700">Amount</label>
              <input required type="number" name="amount" value={formData.amount} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700">Currency</label>
              <select name="currency" value={formData.currency} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:ring-4 focus:ring-blue-100">
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
            <label className="block text-sm font-semibold text-slate-700">Start date</label>
            <input required type="date" name="startDate" value={formData.startDate} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700">End date</label>
            <input required type="date" name="endDate" value={formData.endDate} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700">Description or summary</label>
          <textarea rows="4" name="description" value={formData.description} onChange={handleChange} className="mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100" />
        </div>

        <div className="flex flex-col-reverse justify-between gap-3 border-t border-slate-100 pt-5 sm:flex-row">
          <button type="button" onClick={() => navigate('/contracts')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" /> Cancel</button>
          <button type="submit" className="rounded-xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-200 hover:bg-[#1e293b]">Save draft</button>
        </div>
      </form>
      </div>
    </div>
  );
};

export default CreateContract;