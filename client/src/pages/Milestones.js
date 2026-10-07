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
import StatusFilterChips, { filterByStatus } from '../components/Layout/Common/StatusFilterChips';

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
  // Whether the list has actually been READ. An empty list and a failed read both
  // leave `milestones` empty, and only one of them may be reported as "No
  // milestones yet".
  const [milestonesLoaded, setMilestonesLoaded] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchMilestones = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/milestones');
      setMilestones(data);
      setMilestonesLoaded(true);
      setError('');
    } catch (err) {
      // A failed read must not be reported as an empty list. The previous rows
      // are deliberately left in place: on a retry that fails there is still
      // something true on screen, and on the first load `milestonesLoaded`
      // stays false so the table area does not claim there is nothing here.
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
  const percent = total ? Math.round((completed / total) * 100) : 0;

  // The progress bar above and the chip counts stay on the full set: they are a
  // summary of the page, not of the current selection. Only the table narrows,
  // and it narrows through the same helper the chips count with, so the number on
  // a chip is always the number of rows below it.
  const visible = filterByStatus(milestones, statusFilter);

  // The edit form has to be able to name *this* milestone's own contract and
  // assignee, and `loadFormData` cannot always supply them: GET /contracts
  // filters out archived contracts and GET /users/directory filters out
  // deactivated users. A milestone on an archived contract, or one whose
  // assignee has since been deactivated, therefore had no matching <option>,
  // and the browser resolved the value to the first option instead:
  //   - the disabled contract select displayed an unrelated contract,
  //     contradicting the contract number in the row it was opened from;
  //   - the `required` assignee select was left on its empty placeholder, whose
  //     value is "", so native validation refused to submit the form at all and
  //     the milestone could not be edited through the UI by anyone.
  // Appending the real record when it is missing keeps the form's options a
  // superset of what it already offered; nothing is removed or reordered.
  const idOfRef = (ref) => (ref && typeof ref === 'object' ? ref._id : ref) || '';

  const editContracts = editTarget?.contract && !contracts.some((c) => c._id === idOfRef(editTarget.contract))
    ? [...contracts, { _id: idOfRef(editTarget.contract), contractNumber: editTarget.contract.contractNumber, title: editTarget.contract.title }]
    : contracts;

  const editPeople = editTarget?.assignedTo && !people.some((p) => p._id === idOfRef(editTarget.assignedTo))
    ? [...people, { _id: idOfRef(editTarget.assignedTo), name: editTarget.assignedTo.name }]
    : people;

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
        <div className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
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
      )}

      {/* Replaces what were four inert count chips. They read as a filter row,
          so they are one: a click narrows the table below and the pressed chip
          says which one is active. */}
      {total > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-slate-800">Filter</span>
          <StatusFilterChips
            items={milestones}
            value={statusFilter}
            onChange={setStatusFilter}
            statusStyles={statusStyles}
            label="Filter milestones by status"
          />
          {statusFilter !== 'all' && (
            <span className="text-xs text-slate-500" aria-live="polite">
              Showing {visible.length} of {total}
            </span>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {!milestonesLoaded ? (
          /* The list was never read. Reporting "No milestones yet" here would
             contradict the error and retry above, and would invite the user to
             create a milestone that may already exist. */
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              The milestone list could not be loaded. Use Retry above to try again.
            </p>
          </div>
        ) : milestones.length === 0 ? (
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
        ) : visible.length === 0 ? (
          /* The list is not empty, the filter is. Saying "no milestones yet"
             here would be the same lie the dashboard used to tell on a failed
             request: it sends the user off to create something that exists. */
          <EmptyState
            icon={Flag}
            title="No milestones in this status"
            description={`None of the ${total} milestones here are ${statusFilter}. Choose another status or show all.`}
            action={<button onClick={() => setStatusFilter('all')} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-[#d51d29] hover:text-[#d51d29]">Show all</button>}
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
              {visible.map((milestone) => {
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
              {editContracts.map((contract) => <option key={contract._id} value={contract._id}>{contract.contractNumber} · {contract.title}</option>)}
            </select>
            <select required value={editForm.assignedTo} onChange={(e) => setEditForm({ ...editForm, assignedTo: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3 text-sm">
              <option value="">Assign to</option>
              {editPeople.map((person) => <option key={person._id} value={person._id}>{person.name}</option>)}
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

