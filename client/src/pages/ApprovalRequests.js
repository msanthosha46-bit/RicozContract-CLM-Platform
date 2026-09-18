import React, { useEffect, useState } from 'react';
import API from '../services/api';
import { CheckCircle2, XCircle, LoaderCircle } from 'lucide-react';

const ApprovalRequests = () => {
  const [requests, setRequests] = useState([]);
  const [comments, setComments] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
    try {
      await API.put(`/approvals/${id}/action`, { action, comments: comments[id] || '' });
      setComments((current) => ({ ...current, [id]: '' }));
      await fetchApprovals();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update approval');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading approval requests...</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Approval center</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Approval requests</h1>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {requests.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No pending approval requests.</div>
        ) : (
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Requested By</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.map((request) => (
                <tr key={request._id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{request.contract?.title || 'Contract'}</div>
                    <div className="text-xs text-slate-500">{request.contract?.contractNumber || 'N/A'}</div>
                  </td>
                  <td className="px-4 py-3">{request.requestedBy?.name || 'Unknown'}</td>
                  <td className="px-4 py-3">{new Date(request.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-700">
                      {request.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <input
                        value={comments[request._id] || ''}
                        onChange={(event) => setComments((current) => ({ ...current, [request._id]: event.target.value }))}
                        placeholder="Optional comment"
                        className="w-40 rounded-md border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => handleDecision(request._id, 'Approved')}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => handleDecision(request._id, 'Rejected')}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                      >
                        <XCircle className="h-3.5 w-3.5" /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default ApprovalRequests;
