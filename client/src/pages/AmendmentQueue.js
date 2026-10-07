import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import API from '../services/api';
import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { CheckCircle2, XCircle, LoaderCircle, Inbox, FilePen } from 'lucide-react';
import { PageSkeleton } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import StatusFilterChips, { filterByStatus } from '../components/Layout/Common/StatusFilterChips';
import Toast from '../components/Layout/Common/Toast';
import { canDecideAmendment, describeAmendmentChanges } from '../utils/amendments';

const ALL = 'all';

// Pending first: it is the only status with anything to do, so it must not sit
// below a page of already-decided history. Within a group the server's
// newest-first order is kept.
const STATUS_ORDER = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

const statusStyles = {
  Pending: 'bg-[#fff3e8] text-[#b45309] dark:bg-amber-500/15 dark:text-amber-300',
  Approved: 'bg-[#eaf8f1] text-[#15803d] dark:bg-emerald-500/15 dark:text-emerald-300',
  Rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300'
};

const sortForQueue = (amendments) =>
  [...amendments].sort((a, b) => {
    const rank = (amendment) => {
      const index = STATUS_ORDER.indexOf(amendment?.status);
      return index === -1 ? STATUS_ORDER.length : index;
    };
    return rank(a) - rank(b) || new Date(b.createdAt) - new Date(a.createdAt);
  });

/**
 * The amendment queue for administrators and managers.
 *
 * Mirrors pages/ApprovalRequests.js: a table, one optional comment per row, an
 * approve and a reject action per row, and the row's own busy state so a second
 * click cannot submit the same decision twice.
 *
 * Three differences are deliberate:
 *   * every status is listed, not only Pending, because an amendment that was
 *     rejected and then has to be resubmitted is only understandable next to
 *     the attempts that came before it;
 *   * the requested values are shown as an explicit before -> after per field,
 *     because the whole point of the decision is whether that change is right;
 *   * a requester's own row has no buttons at all, with the reason stated, so
 *     the separation-of-duties rule is visible rather than enforced by a 400.
 */
const AmendmentQueue = () => {
  const { user } = useContext(AuthContext);
  const [searchParams, setSearchParams] = useSearchParams();
  const [amendments, setAmendments] = useState([]);
  const [comments, setComments] = useState({});
  const [filter, setFilter] = useState(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  // Keyed by amendment id so only the row being decided shows a spinner.
  const [deciding, setDeciding] = useState({});
  const rowRefs = useRef({});

  const focusId = searchParams.get('focus');

  const fetchAmendments = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/contract-amendments');
      setAmendments(sortForQueue(Array.isArray(data) ? data : []));
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load amendment requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAmendments();
  }, [fetchAmendments]);

  // The notification feed links here with ?focus=<id>. Scrolling the row into
  // view is what makes that a shortcut to the request rather than to the top of
  // a list the reader then has to search.
  useEffect(() => {
    if (!focusId || loading) return;
    const node = rowRefs.current[focusId];
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center' });
    }
  }, [focusId, loading]);

  // A filter that would hide the focused request defeats the shortcut, so the
  // focus switches the filter to the status that request is in.
  useEffect(() => {
    if (!focusId) return;
    const target = amendments.find((amendment) => amendment._id === focusId);
    if (target) setFilter(ALL);
  }, [focusId, amendments]);

  const clearFocus = () => {
    if (!focusId) return;
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  };

  const handleDecision = async (amendment, action) => {
    if (deciding[amendment._id]) return;
    setDeciding((current) => ({ ...current, [amendment._id]: action }));
    setError('');
    try {
      await API.put(`/contract-amendments/${amendment._id}/action`, {
        action,
        comments: comments[amendment._id] || ''
      });
      setComments((current) => ({ ...current, [amendment._id]: '' }));
      setToast({
        type: 'success',
        message: action === 'Approved'
          ? 'Amendment approved and applied to the contract'
          : 'Amendment rejected'
      });
      clearFocus();
      await fetchAmendments();
    } catch (err) {
      // A 409 here is a real state change, not a bad value: the contract moved
      // under the request (a renewal, or another amendment) and the request has
      // to be re-raised against the current terms. It is shown as a page-level
      // error rather than a toast because the request is still open and the
      // reader has to act on it.
      setError(err.response?.data?.message || 'Unable to update the amendment');
    } finally {
      setDeciding((current) => {
        const next = { ...current };
        delete next[amendment._id];
        return next;
      });
    }
  };

  if (loading) {
    return <PageSkeleton rows={5} columns={5} />;
  }

  const visible = filterByStatus(amendments, filter);

  return (
    <div className="space-y-7">
      <div>
        <p className="ricoz-eyebrow">Amendment center</p>
        <h1 className="text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Amendment requests</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Changes to the amount, currency, dates or assignee of a submitted contract. Approving one
          writes the proposed values onto the contract; you cannot decide a request you raised yourself.
        </p>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {amendments.length > 0 && (
        <StatusFilterChips items={amendments} value={filter} onChange={setFilter} statusStyles={statusStyles} label="Filter amendments by status" />
      )}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-[#141c2e]">
        {visible.length === 0 ? (
          <EmptyState
            icon={amendments.length ? Inbox : FilePen}
            title={amendments.length ? 'No amendments with that status' : 'No amendment requests'}
            description={
              amendments.length
                ? 'Choose another status above, or All to see every request for every contract.'
                : 'When someone needs to change the amount, currency, dates or assignee of a submitted contract, the request appears here for approval.'
            }
          />
        ) : (
          /* Own scroll container, as on the approval page: the table needs more
             than a phone is wide and this parent clips overflow, so the Action
             column would otherwise be cut off. */
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm text-slate-600 dark:text-slate-300">
              <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Contract</th>
                  <th scope="col" className="px-4 py-3 font-medium">Requested changes</th>
                  <th scope="col" className="px-4 py-3 font-medium">Reason</th>
                  <th scope="col" className="px-4 py-3 font-medium">Requester</th>
                  <th scope="col" className="px-4 py-3 font-medium">Created</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {visible.map((amendment) => {
                  const busy = Boolean(deciding[amendment._id]);
                  const contractLabel = amendment.contract?.title || 'Contract';
                  const changes = describeAmendmentChanges(amendment);
                  const decision = canDecideAmendment({ amendment, user });
                  const focused = amendment._id === focusId;
                  return (
                    <tr
                      key={amendment._id}
                      ref={(node) => {
                        if (node) rowRefs.current[amendment._id] = node;
                        else delete rowRefs.current[amendment._id];
                      }}
                      data-amendment-id={amendment._id}
                      aria-current={focused ? 'true' : undefined}
                      className={`align-top hover:bg-slate-50/60 dark:hover:bg-slate-800/30${focused ? ' bg-[#fff7f7] ring-2 ring-inset ring-[#d51d29] dark:bg-[#d51d29]/10' : ''}`}
                    >
                      <td className="px-4 py-3">
                        {amendment.contract?._id ? (
                          <Link to={`/contracts/${amendment.contract._id}`} className="font-medium text-slate-800 hover:text-[#d51d29] hover:underline dark:text-slate-100">
                            {contractLabel}
                          </Link>
                        ) : (
                          <span className="font-medium text-slate-800 dark:text-slate-100">{contractLabel}</span>
                        )}
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {amendment.contract?.contractNumber || 'N/A'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <ul className="space-y-1">
                          {changes.map((change) => (
                            <li key={change.field} className="text-xs">
                              <span className="font-semibold text-slate-700 dark:text-slate-200">{change.label}: </span>
                              <span className="text-slate-500 line-through decoration-slate-400 dark:text-slate-400">{change.from}</span>
                              <span aria-hidden="true" className="mx-1 text-slate-400">&rarr;</span>
                              <span className="font-semibold text-slate-800 dark:text-slate-100">{change.to}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="max-w-[18rem] px-4 py-3">
                        <p className="whitespace-pre-line break-words text-xs text-slate-600 dark:text-slate-300">{amendment.reason}</p>
                        {amendment.decisionComments && (
                          <p className="mt-1.5 whitespace-pre-line break-words text-xs text-slate-500 dark:text-slate-400">
                            Decision note: {amendment.decisionComments}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{amendment.requestedBy?.name || 'Unknown'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{new Date(amendment.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={amendment.status} />
                        {amendment.decidedBy?.name && (
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            by {amendment.decidedBy.name}
                            {amendment.decidedAt ? ` on ${new Date(amendment.decidedAt).toLocaleDateString()}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {decision.allowed ? (
                          <div className="flex items-center justify-end gap-2">
                            <input
                              aria-label={`Optional comment for ${amendment.contract?.contractNumber || contractLabel}`}
                              value={comments[amendment._id] || ''}
                              onChange={(event) => setComments((current) => ({ ...current, [amendment._id]: event.target.value }))}
                              placeholder="Optional comment"
                              disabled={busy}
                              className="w-40 rounded-md border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-slate-600 dark:bg-slate-800"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDecision(amendment, 'Approved')}
                              aria-label={`Approve amendment for ${amendment.contract?.contractNumber || contractLabel}`}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDecision(amendment, 'Rejected')}
                              aria-label={`Reject amendment for ${amendment.contract?.contractNumber || contractLabel}`}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300"
                            >
                              <XCircle className="h-3.5 w-3.5" /> Reject
                            </button>
                            {busy && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />}
                          </div>
                        ) : (
                          /* The reason is stated rather than the control being
                             hidden silently, so a requester understands why
                             there is nothing to click. */
                          <p className="text-xs text-slate-500 dark:text-slate-400">{decision.reason}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
};

export default AmendmentQueue;
