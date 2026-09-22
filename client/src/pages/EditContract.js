import React, { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import API from '../services/api';
import { AuthContext } from '../context/AuthContext';

const EditContract = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  const canEditStatus = ['Admin', 'Manager'].includes(user?.role);
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
      } catch (err) {
        setError(err.response?.data?.message || 'Unable to load contract');
      } finally {
        setLoading(false);
      }
    };

    fetchContract();
  }, [id]);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...formData };
      if (!canEditStatus) delete payload.status;
      await API.put(`/contracts/${id}`, payload);
      navigate(`/contracts/${id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update contract');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading contract editor...</div>;
  }

  return (
    <div className="mx-auto max-w-4xl rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Contract workspace</p>
      <h1 className="mt-3 mb-6 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Edit contract</h1>
      {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
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

        {canEditStatus && (
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Status</label>
          <select name="status" value={formData.status} onChange={handleChange} className="w-full border p-2 rounded text-sm">
            <option value="Draft">Draft</option>
            <option value="Pending Approval">Pending Approval</option>
            <option value="Active">Active</option>
            <option value="Expired">Expired</option>
            <option value="Renewed">Renewed</option>
            <option value="Closed">Closed</option>
          </select>
        </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Description / Summary</label>
          <textarea rows="4" name="description" value={formData.description} onChange={handleChange} className="w-full border p-2 rounded text-sm" />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <button type="button" onClick={() => navigate(`/contracts/${id}`)} className="px-4 py-2 border rounded text-sm font-medium text-slate-600">Cancel</button>
          <button type="submit" className="rounded-xl bg-[#0f172a] px-5 py-3 text-sm font-semibold text-white hover:bg-[#1e293b]">Save changes</button>
        </div>
      </form>
    </div>
  );
};

export default EditContract;
