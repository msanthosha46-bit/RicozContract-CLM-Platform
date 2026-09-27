import React, { useContext, useEffect, useState } from 'react';
import API from '../services/api';
import { CheckCircle2, Eye, Flag } from 'lucide-react';
import { AuthContext } from '../context/AuthContext';
import Modal from '../components/Layout/Common/Modal';
import Toast from '../components/Layout/Common/Toast';
import { formatDate, toDateInput, daysUntil, daysLabel } from '../utils/date';
import { canTransitionItem, statusOptionsFor } from '../utils/itemTransitions';
import { PageSkeleton } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';

// Work-item statuses are their own four-state vocabulary, deliberately
// separate from the thirteen contract statuses in StatusBadge. Pending,
// Completed and Overdue keep their bright hue so the meaning still reads at
// a glance; In Progress borrows the neutral `rz-inprogress` fill so the same
// word looks the same wherever it appears. These chips stay borderless, which
// is why they use `rz-inprogress` without `rz-pill`.
const statusStyles = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'rz-inprogress',
  Completed: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700'
};

const emptyForm = { title: '', description: '', contract: '', assignedTo: '', dueDate: '', status: 'Pending' };

const Milestones = () => {
  const { user } = useContext(AuthContext);
  const canManage = ['Admin', 'Manager'].includes(user?.role);
  const [milestones, setMilestones] = useState([]);
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

  const fetchMilestones = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/milestones');
      setMilestones(data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load milestones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMilestones();
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

  const openEdit = async (milestone) => {
    try {
      setError('');
      await loadFormData();
      const fullMilestone = milestone;
      setEditForm({
        title: fullMilestone.title || '',
        description: fullMilestone.description || '',
        contract: fullMilestone.contract?._id || fullMilestone.contract || '',
        assignedTo: fullMilestone.assignedTo?._id || fullMilestone.assignedTo || '',
        dueDate: toDateInput(fullMilestone.dueDate),
        status: fullMilestone.status || 'Pending'
      });
      setEditTarget(fullMilestone);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load edit form');
    }
  };

  const createMilestone = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await API.post('/milestones', form);
      setCreateOpen(false);
      setToast({ type: 'success', message: 'Milestone created' });
      await fetchMilestones();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to create milestone');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await API.put(`/milestones/${editTarget._id}`, editForm);
      setEditTarget(null);
      setToast({ type: 'success', message: 'Milestone updated' });
      await fetchMilestones();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update milestone');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id, status) => {
    setError('');
    try {
      await API.put(`/milestones/${id}`, { status });
      await fetchMilestones();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update milestone');
    }
  };

  const quickActions = (milestone) => {
    const actions = [];
    if (canTransitionItem(milestone.status, 'In Progress') && milestone.status !== 'In Progress') {
      const label = milestone.status === 'Completed' ? 'Reopen' : 'Start';
      actions.push(
        <button
          key="start"
          onClick={() => updateStatus(milestone._id, 'In Progress')}
          className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
        >
          {label}
        </button>
      );
    }
    if (canTransitionItem(milestone.status, 'Completed') && milestone.status !== 'Completed') {
      actions.push(
        <button
          key="complete"
          onClick={() => updateStatus(milestone._id, 'Completed')}
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          Complete
        </button>
      );
    }
    return actions;
  };

  const total = milestones.length;
  const completed = milestones.filter((m) => m.status === 'Completed').length;
  const overdue = milestones.filter((m) => m.status === 'Overdue').length;
  const inProgress = milestones.filter((m) => m.status === 'In Progress').length;
  const pending = milestones.filter((m) => m.status === 'Pending').length;
  const percent = total ? Math.round((completed / total) * 100) : 0;

  if (loading) return <PageSkeleton rows={6} columns={6} />;

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]"><Flag className="h-6 w-6" /></div>
          <div>
            <p className="ricoz-eyebrow">Contract lifecycle</p>
            <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Milestones</h1>
            <p className="mt-2 text-slate-500">Give each agreement a visible path from kickoff to completion.</p>
          </div>
        </div>
        {canManage && <button onClick={openCreate} className="shrink-0 self-start rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white">New milestone</button>}
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchMilestones} className="shrink-0 rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100">Retry</button>
        </div>
      )}

      {total > 0 && (
        <div className="flex flex-col gap-4 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center">
          <div className="flex-1">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-semibold text-slate-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Milestone progress
              </span>
              <span className="text-slate-500">{completed} of {total} completed · {percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-[#1d4ed8]" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold">
            {[
              ['Pending', pending],
              ['In Progress', inProgress],
              ['Overdue', overdue],
              ['Completed', completed]
            ].map(([label, count]) => (
              <span key={label} className={`rounded-full px-2.5 py-1 ${statusStyles[label]}`}>
                {label} {count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {milestones.length === 0 ? (
          <EmptyState
            icon={Flag}
            title={canManage ? 'No milestones yet' : 'No milestones assigned to you'}
            description={
              canManage
                ? 'Create a milestone to map out contract timelines from kickoff to completion.'
                : 'Milestones assigned to you will appear here.'
            }
            action={canManage ? <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-xl bg-[#d51d29] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#b91c26]">New milestone</button> : undefined}
          />
        ) : (
          /* Own scroll container: the table needs 40rem on a phone and this
             parent clips overflow, so Due Date / Status / Actions would be cut. */
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Contract</th>
                <th scope="col" className="px-4 py-3 font-medium">Milestone</th>
                <th scope="col" className="px-4 py-3 font-medium">Assigned To</th>
                <th scope="col" className="px-4 py-3 font-medium">Due Date</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {milestones.map((milestone) => {
                const days = daysUntil(milestone.dueDate);
                return (
                  <tr key={milestone._id} className="transition hover:bg-[#f8fafc]">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-slate-800">{milestone.contract?.contractNumber || 'N/A'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{milestone.title}</div>
                      <div className="text-xs text-slate-500">{milestone.description || milestone.contract?.title || ''}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{milestone.assignedTo?.name || 'Unassigned'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div>{formatDate(milestone.dueDate)}</div>
                      {milestone.status !== 'Completed' && <div className="text-xs text-slate-400">{daysLabel(days)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[milestone.status] || 'rz-pill rz-unknown'}`}>
                        {milestone.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setViewTarget(milestone)}
                          aria-label={`View ${milestone.title}`}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" /> View
                        </button>
                        {canManage && (
                          <button type="button" onClick={() => openEdit(milestone)} aria-label={`Edit ${milestone.title}`} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                            Edit
                          </button>
                        )}
                        {quickActions(milestone)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create milestone"
        footer={
          <>
            <button type="button" onClick={() => setCreateOpen(false)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button type="submit" form="milestone-form" disabled={saving} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form id="milestone-form" onSubmit={createMilestone} className="space-y-3">
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
        title={editTarget ? `Edit · ${editTarget.title}` : 'Edit milestone'}
        footer={
          <>
            <button onClick={() => setEditTarget(null)} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600">Cancel</button>
            <button form="milestone-edit-form" disabled={saving} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </>
        }
      >
        {editForm && (
          <form id="milestone-edit-form" onSubmit={saveEdit} className="space-y-3">
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
        title="Milestone details"
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
              <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[viewTarget.status] || 'rz-pill rz-unknown'}`}>
                {viewTarget.status}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default Milestones;

