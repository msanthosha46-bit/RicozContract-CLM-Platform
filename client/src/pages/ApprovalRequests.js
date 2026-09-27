import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { CheckCircle2, XCircle, LoaderCircle, Inbox } from 'lucide-react';
import { PageSkeleton } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';

const ApprovalRequests = () => {
  const [requests, setRequests] = useState([]);
  const [comments, setComments] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Keyed by request id so only the row being decided shows a spinner, and a
  // second click on the same row cannot submit a duplicate decision.
  const [deciding, setDeciding] = useState({});

  const fetchApprovals = async () => {
    try {
      setLoading(true);
      const { data } = await API.get('/approvals/pending');
      setRequests(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load approval requests');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovals();
  }, []);

  const handleDecision = async (id, action) => {
    if (deciding[id]) return;
    setDeciding((current) => ({ ...current, [id]: action }));
    try {
      await API.put(`/approvals/${id}/action`, { action, comments: comments[id] || '' });
      setComments((current) => ({ ...current, [id]: '' }));
      await fetchApprovals();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update approval');
    } finally {
      setDeciding((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  if (loading) {
    return <PageSkeleton rows={5} columns={5} />;
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Approval center</p>
        <h1 className="mt-3 text-3xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-4xl">Approval requests</h1>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {requests.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No pending approvals"
            description="Contracts submitted for review appear here with approve and reject actions."
          />
        ) : (
          /* Own scroll container: the table needs 40rem on a phone and this
             parent clips overflow, so the Action column would be cut off. */
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Contract</th>
                  <th scope="col" className="px-4 py-3 font-medium">Requested By</th>
                  <th scope="col" className="px-4 py-3 font-medium">Submitted</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {requests.map((request) => {
                  const busy = Boolean(deciding[request._id]);
                  const label = request.contract?.title || 'Contract';
                  return (
                    <tr key={request._id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{label}</div>
                        <div className="text-xs text-slate-500">{request.contract?.contractNumber || 'N/A'}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{request.requestedBy?.name || 'Unknown'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{new Date(request.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-700 dark:bg-amber-500/15 dark:text-amber-300">
                          {request.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <input
                            aria-label={`Optional comment for ${label}`}
                            value={comments[request._id] || ''}
                            onChange={(event) => setComments((current) => ({ ...current, [request._id]: event.target.value }))}
                            placeholder="Optional comment"
                            disabled={busy}
                            className="w-40 rounded-md border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleDecision(request._id, 'Approved')}
                            aria-label={`Approve ${label}`}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleDecision(request._id, 'Rejected')}
                            aria-label={`Reject ${label}`}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <XCircle className="h-3.5 w-3.5" /> Reject
                          </button>
                          {busy && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />}
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
    </div>
  );
};

export default ApprovalRequests;
