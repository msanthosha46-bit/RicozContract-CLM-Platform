import React, { useContext, useEffect, useState } from 'react';
import API from '../services/api';
import { Eye, ShieldCheck } from 'lucide-react';
import { AuthContext } from '../context/AuthContext';
import Modal from '../components/Layout/Common/Modal';
import Toast from '../components/Layout/Common/Toast';
import { formatDate, toDateInput, daysUntil, daysLabel } from '../utils/date';
import { canTransitionItem, statusOptionsFor } from '../utils/itemTransitions';

const statusStyles = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700'
};

const emptyForm = { title: '', description: '', contract: '', assignedTo: '', dueDate: '', status: 'Pending' };

const Obligations = () => {
  const { user } = useContext(AuthContext);
  const canManage = ['Admin', 'Manager'].includes(user?.role);
  const [obligations, setObligations] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [viewTarget, setViewTarget] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchObligations = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/obligations');
      setObligations(data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load obligations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchObligations();
  }, []);

  const loadFormData = async () => {
    const [contractRes, userRes] = await Promise.all([
      API.get('/contracts?fields=contractNumber,title'),
      API.get('/users/directory')
    ]);
    setContracts(contractRes.data);
    setPeople(userRes.data);
  };

  const openCreate = async () => {
    try {
      setError('');
      await loadFormData();
      setForm(emptyForm);
      setCreateOpen(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load create form');
    }
  };

  const openEdit = async (obligation) => {
    try {
      setError('');
      await loadFormData();
      setEditForm({
        title: obligation.title || '',
        description: obligation.description || '',
        contract: obligation.contract?._id || obligation.contract || '',
        assignedTo: obligation.assignedTo?._id || obligation.assignedTo || '',
        dueDate: toDateInput(obligation.dueDate),
        status: obligation.status || 'Pending'
      });
      setEditTarget(obligation);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load edit form');
    }
  };

  const createObligation = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await API.post('/obligations', form);
      setCreateOpen(false);
      setToast({ type: 'success', message: 'Obligation created' });
      await fetchObligations();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to create obligation');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await API.put(`/obligations/${editTarget._id}`, editForm);
      setEditTarget(null);
      setToast({ type: 'success', message: 'Obligation updated' });
      await fetchObligations();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update obligation');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id, status) => {
    setError('');
    try {
      await API.put(`/obligations/${id}`, { status });
      await fetchObligations();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update obligation');
    }
  };

  const quickActions = (obligation) => {
    const actions = [];
    if (canTransitionItem(obligation.status, 'In Progress') && obligation.status !== 'In Progress') {
      const label = obligation.status === 'Completed' ? 'Reopen' : 'Start';
      actions.push(
        <button
          key="start"
          onClick={() => updateStatus(obligation._id, 'In Progress')}
          className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
        >
          {label}
        </button>
      );
    }
    if (canTransitionItem(obligation.status, 'Completed') && obligation.status !== 'Completed') {
      actions.push(
        <button
          key="complete"
          onClick={() => updateStatus(obligation._id, 'Completed')}
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          Complete
        </button>
      );
    }
    return actions;
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading obligations...</div>;
  }

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Compliance workspace</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Obligations</h1>
          <p className="mt-2 text-slate-500">Track every promise, owner, and deadline before it becomes a risk.</p>
        </div>
        {canManage ? (
          <button onClick={openCreate} className="rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white">New obligation</button>
        ) : (
          <div className="hidden h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf1ff] text-[#1d4ed8] sm:flex"><ShieldCheck className="h-6 w-6" /></div>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchObligations} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100">Retry</button>
        </div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {obligations.length === 0 ? (
          <div className="p-8 text-center text-slate-500">
            {canManage ? 'No obligations yet. Create one to start tracking commitments.' : 'No obligations assigned to you.'}
          </div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Assigned To</th>
                <th className="px-4 py-3 font-medium">Due Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {obligations.map((ob) => {
                const days = daysUntil(ob.dueDate);
                return (
                  <tr key={ob._id} className="transition hover:bg-[#f8fafc]">
                    <td className="px-4 py-3 font-medium text-slate-800">{ob.contract?.contractNumber || 'N/A'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{ob.title}</div>
                      <div className="text-xs text-slate-500">{ob.description || ob.contract?.title || ''}</div>
                    </td>
                    <td className="px-4 py-3">{ob.assignedTo?.name || 'Unassigned'}</td>
                    <td className="px-4 py-3">
                      <div>{formatDate(ob.dueDate)}</div>
                      {ob.status !== 'Completed' && <div className="text-xs text-slate-400">{daysLabel(days)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[ob.status] || 'bg-slate-100 text-slate-700'}`}>
                        {ob.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setViewTarget(ob)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" /> View
                        </button>
                        {canManage && (
                          <button onClick={() => openEdit(ob)} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                            Edit
                          </button>
                        )}
                        {quickActions(ob)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create obligation"
        footer={
          <>
            <button onClick={() => setCreateOpen(false)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button form="obligation-form" disabled={saving} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form id="obligation-form" onSubmit={createObligation} className="space-y-3">
          <input required placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
          <select required value={form.contract} onChange={(e) => setForm({ ...form, contract: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm">
            <option value="">Select contract</option>
            {contracts.map((contract) => <option key={contract._id} value={contract._id}>{contract.contractNumber} · {contract.title}</option>)}
          </select>
          <select required value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm">
            <option value="">Assign to</option>
            {people.map((person) => <option key={person._id} value={person._id}>{person.name}</option>)}
          </select>
          <input required type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
          <textarea placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(editForm && editTarget)}
        onClose={() => setEditTarget(null)}
        title={editTarget ? `Edit · ${editTarget.title}` : 'Edit obligation'}
        footer={
          <>
            <button onClick={() => setEditTarget(null)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button form="obligation-edit-form" disabled={saving} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </>
        }
      >
        {editForm && (
          <form id="obligation-edit-form" onSubmit={saveEdit} className="space-y-3">
            <input required placeholder="Title" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
            <select required value={editForm.contract} disabled className="w-full rounded-xl border border-slate-200 p-3 text-sm disabled:bg-slate-50">
              {contracts.map((contract) => <option key={contract._id} value={contract._id}>{contract.contractNumber} · {contract.title}</option>)}
            </select>
            <select required value={editForm.assignedTo} onChange={(e) => setEditForm({ ...editForm, assignedTo: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm">
              <option value="">Assign to</option>
              {people.map((person) => <option key={person._id} value={person._id}>{person.name}</option>)}
            </select>
            <input required type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
            <textarea placeholder="Description" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm" />
            <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm">
              {statusOptionsFor(editForm.status).map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(viewTarget)}
        onClose={() => setViewTarget(null)}
        title="Obligation details"
      >
        {viewTarget && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Title</p>
              <p className="mt-1 font-semibold text-slate-800">{viewTarget.title}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Description</p>
              <p className="mt-1 text-slate-600">{viewTarget.description || 'No description provided.'}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Contract</p>
              <p className="mt-1 text-slate-600">{viewTarget.contract?.contractNumber || 'N/A'}{viewTarget.contract?.title ? ` · ${viewTarget.contract.title}` : ''}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Assigned to</p>
                <p className="mt-1 text-slate-600">{viewTarget.assignedTo?.name || 'Unassigned'}{viewTarget.assignedTo?.email ? ` · ${viewTarget.assignedTo.email}` : ''}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Due date</p>
                <p className="mt-1 text-slate-600">{formatDate(viewTarget.dueDate)} {viewTarget.status !== 'Completed' && `(${daysLabel(daysUntil(viewTarget.dueDate))})`}</p>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Status</p>
              <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[viewTarget.status] || 'bg-slate-100 text-slate-700'}`}>
                {viewTarget.status}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default Obligations;

