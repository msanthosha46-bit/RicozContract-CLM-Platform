import React, { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import API from '../services/api';
import { AuthContext } from '../context/AuthContext';
import { canTransition, getManualEditTargets } from '../utils/contractTransitions';
import { isFieldLocked, isEditableStatus } from '../utils/contractEditLock';
import { canManage } from '../utils/roles';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import { SkeletonText } from '../components/Layout/Common/Skeleton';

const EditContract = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  // The same question the sidebar and the topbar ask, read from the shared
  // helper so the role vocabulary lives in one place. The server re-checks it:
  // `PUT /contracts/:id` refuses a status from anyone who is not in the
  // allow-list in utils/access.js.
  const canEditStatus = canManage(user?.role);
  const [currentStatus, setCurrentStatus] = useState('Draft');
  // The server refuses a change to the financial terms, the dates or the
  // assignee from submission onwards, for every role. Mirrored here so those
  // inputs are visibly locked instead of failing on save.
  const termsLocked = !isEditableStatus(currentStatus);
  const lockInput = (field) => (isFieldLocked(currentStatus, field) ? ' opacity-60 cursor-not-allowed' : '');
  const lockInputProps = (field) => (isFieldLocked(currentStatus, field) ? { disabled: true } : {});
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
  // Whether the contract actually arrived. The load used to be treated as
  // successful whenever it finished, so a 404 or a 403 cleared the loading
  // flag and left a fully populated, editable form with a working Save button
  // sitting over an empty record - an offer to save a contract that was never
  // read. The form is now rendered only once there is something in it.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const fetchContract = async () => {
      setLoading(true);
      setLoaded(false);
      try {
        const { data } = await API.get(`/contracts/${id}`);
        setFormData({
          title: data.title || '',
          type: data.type || 'Vendor',
          partyName: data.partyName || '',
          description: data.description || '',
          startDate: data.startDate ? new Date(data.startDate).toISOString().slice(0, 10) : '',
          endDate: data.endDate ? new Date(data.endDate).toISOString().slice(0, 10) : '',
          // `data.amount || ''` turned a stored 0 into an empty string, so a
          // zero-amount contract opened in a required field the user had to
          // re-type before anything could be saved. Only an absent amount is
          // absent; 0 is a real amount the server accepts.
          amount: data.amount === undefined || data.amount === null ? '' : String(data.amount),
          currency: data.currency || 'USD',
          status: data.status || 'Draft'
        });
        setCurrentStatus(data.status || 'Draft');
        setError('');
        setLoaded(true);
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

  // Nothing was read, so there is nothing to edit. Shown instead of the form,
  // with a way out - previously this fell through to a populated, editable form
  // over an empty record, and a Save on it would have overwritten the contract
  // with whatever the defaults happened to be.
  if (!loaded) {
    return (
      <div className="mx-auto max-w-4xl rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <p className="ricoz-eyebrow">Contract workspace</p>
        <h1 className="mb-4 text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Edit contract</h1>
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">{error || 'Unable to load contract'}</p>
          <p className="mt-1">The contract was not loaded, so there is nothing to edit.</p>
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => navigate('/contracts')}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" /> Back to contracts
          </button>
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
              {/* step="any" matches the server, which takes any non-negative
                  finite number. The implicit step=1 marked every decimal a
                  mismatch and blocked the submit. */}
              <input id="edit-amount" required type="number" inputMode="decimal" min="0" step="any" name="amount" value={formData.amount} onChange={handleChange} className={`${field}${lockInput('amount')}`} {...lockInputProps('amount')} />
            </div>
            <div>
              <label htmlFor="edit-currency" className="block text-sm font-semibold text-slate-700">Currency</label>
              <select id="edit-currency" name="currency" value={formData.currency} onChange={handleChange} className={`${field}${lockInput('currency')}`} {...lockInputProps('currency')}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="INR">INR</option>
              </select>
            </div>
          </div>
        </div>

        {termsLocked && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="note">
            <p className="font-semibold">
              Amount, currency, dates and the assignee are locked in state &apos;{currentStatus}&apos;.
            </p>
            <p className="mt-1">
              An approval fixed these terms, so changing them needs a separate, approved amendment
              rather than an edit. Title, counterparty and description stay editable. To change a
              locked value, raise an amendment from the contract page.
            </p>
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="edit-start" className="block text-sm font-semibold text-slate-700">Start date</label>
            <input id="edit-start" required type="date" name="startDate" value={formData.startDate} onChange={handleChange} className={`${field}${lockInput('startDate')}`} {...lockInputProps('startDate')} />
          </div>
          <div>
            <label htmlFor="edit-end" className="block text-sm font-semibold text-slate-700">End date</label>
            <input id="edit-end" required type="date" name="endDate" value={formData.endDate} onChange={handleChange} className={`${field}${lockInput('endDate')}`} {...lockInputProps('endDate')} />
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
