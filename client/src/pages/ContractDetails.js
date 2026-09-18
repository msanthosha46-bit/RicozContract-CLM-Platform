import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import { ArrowLeft, Pencil, FileText, Upload, Download, BadgeCheck } from 'lucide-react';

const ContractDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);

  const fetchContract = async () => {
    try {
      setLoading(true);
      const [contractRes, docsRes] = await Promise.all([
        API.get(`/contracts/${id}`),
        API.get(`/documents/contract/${id}`),
      ]);
      setContract(contractRes.data);
      setDocuments(docsRes.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load contract details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContract();
  }, [id]);

  const handleFileUpload = async () => {
    if (!file) return;
    try {
      setUploading(true);
      setError('');
      const formData = new FormData();
      formData.append('document', file);
      await API.post(`/documents/upload/${id}`, formData);
      setFile(null);
      await fetchContract();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmitForApproval = async () => {
    try {
      await API.post(`/approvals/submit/${id}`);
      await fetchContract();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to submit for approval');
    }
  };

  const handleDownload = async (docId, filename) => {
    try {
      const response = await API.get(`/documents/download/${docId}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to download file');
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-500">Loading contract details...</div>;
  }

  if (!contract) {
    return <div className="p-8 text-red-600">{error || 'Contract not found'}</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/contracts')} className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-[#1d4ed8]">{contract.contractNumber}</p>
            <h1 className="mt-2 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">{contract.title}</h1>
          </div>
        </div>

        <div className="flex gap-2">
          <Link to={`/contracts/${id}/edit`} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Pencil className="w-4 h-4" /> Edit
          </Link>
          {contract.status !== 'Pending Approval' && contract.status !== 'Active' && (
            <button onClick={handleSubmitForApproval} className="inline-flex items-center gap-2 rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1e293b]">
              <BadgeCheck className="w-4 h-4" /> Submit for Approval
            </button>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-800">Contract Overview</h2>
              <StatusBadge status={contract.status} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-600">
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Type</span><span className="font-medium text-slate-800">{contract.type}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Counterparty</span><span className="font-medium text-slate-800">{contract.partyName}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Start Date</span><span className="font-medium text-slate-800">{new Date(contract.startDate).toLocaleDateString()}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">End Date</span><span className="font-medium text-slate-800">{new Date(contract.endDate).toLocaleDateString()}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Value</span><span className="font-medium text-slate-800">{contract.currency} {Number(contract.amount || 0).toLocaleString()}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Created By</span><span className="font-medium text-slate-800">{contract.createdBy?.name || 'Unknown'}</span></div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Description</h3>
              <p className="text-slate-700 leading-7">{contract.description || 'No description provided.'}</p>
            </div>
          </div>

          <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">Documents</h2>
              <span className="text-sm text-slate-500">{documents.length} file(s)</span>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 mb-5">
              <input type="file" onChange={(e) => setFile(e.target.files[0])} className="flex-1 block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200" />
              <button onClick={handleFileUpload} disabled={!file || uploading} className="inline-flex items-center gap-2 rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                <Upload className="w-4 h-4" /> {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>

            <div className="space-y-3">
              {documents.length === 0 ? (
                <div className="text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg p-4 text-center">No documents uploaded yet.</div>
              ) : (
                documents.map((doc) => (
                  <div key={doc._id} className="flex items-center justify-between gap-4 border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText className="w-5 h-5 text-slate-400 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{doc.originalname}</p>
                        <p className="text-xs text-slate-500">v{doc.version} • {new Date(doc.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <button onClick={() => handleDownload(doc._id, doc.originalname)} className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700">
                      <Download className="w-4 h-4" /> Download
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Key Details</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4 py-2 border-b border-slate-100">
                <dt className="text-slate-500">Status</dt>
                <dd><StatusBadge status={contract.status} /></dd>
              </div>
              <div className="flex justify-between gap-4 py-2 border-b border-slate-100">
                <dt className="text-slate-500">Assigned User</dt>
                <dd className="font-medium text-slate-800">{contract.assignedUser?.name || 'Unassigned'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2 border-b border-slate-100">
                <dt className="text-slate-500">Approval Cycle</dt>
                <dd className="font-medium text-slate-800">{contract.status === 'Pending Approval' ? 'In review' : 'Not started'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-slate-500">Last Updated</dt>
                <dd className="font-medium text-slate-800">{new Date(contract.updatedAt).toLocaleString()}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContractDetails;
