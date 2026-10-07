import React, { useContext, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import API from '../services/api';
import StatusBadge from '../components/Layout/Common/StatusBadge';
import { ArrowLeft, Pencil, FileText, Upload, Download, BadgeCheck, LoaderCircle, FilePen } from 'lucide-react';
import { AuthContext } from '../context/AuthContext';
import { canSubmitForApproval } from '../utils/contractTransitions';
import { isEditableStatus } from '../utils/contractEditLock';
import { canRequestAmendment } from '../utils/amendments';
import { formatDate, formatDateTime } from '../utils/date';
import Modal from '../components/Layout/Common/Modal';
import RequestAmendmentModal from '../components/Amendments/RequestAmendmentModal';
import AmendmentHistory from '../components/Amendments/AmendmentHistory';
import Toast from '../components/Layout/Common/Toast';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'doc'];

const formatFileSize = (bytes) => {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return 'Unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const uploadValidationMessage = (selectedFile) => {
  if (!selectedFile) return 'Please choose a file to upload.';
  const extension = selectedFile.name.split('.').pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(extension)) return 'Only PDF, DOCX and DOC documents are allowed.';
  if (selectedFile.size > MAX_UPLOAD_BYTES) return 'File exceeds the 10 MiB upload limit.';
  return '';
};

const readErrorMessage = async (error, fallback) => {
  const data = error?.response?.data;
  if (data && typeof data.text === 'function') {
    try {
      const parsed = JSON.parse(await data.text());
      return parsed?.message || fallback;
    } catch (parseError) {
      return fallback;
    }
  }
  return data?.message || fallback;
};

const ContractDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  const [contract, setContract] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [downloadId, setDownloadId] = useState(null);
  const [error, setError] = useState('');
  const [documentError, setDocumentError] = useState('');
  // Whether the document list was actually READ. An empty list and a failed
  // read both leave `documents` empty, and only one of them may be shown as
  // "No documents yet".
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [toast, setToast] = useState(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [submittingForApproval, setSubmittingForApproval] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // The amendment trail is a separate resource from the contract, so it is
  // fetched separately and can settle after the contract has. A failure here
  // must not blank the page: the contract itself is already on screen.
  const [amendments, setAmendments] = useState([]);
  const [amendmentsLoading, setAmendmentsLoading] = useState(true);
  const [amendmentsError, setAmendmentsError] = useState('');
  const [amendmentOpen, setAmendmentOpen] = useState(false);
  const isAdmin = user?.role === 'Admin';

  const fetchAmendments = async () => {
    try {
      setAmendmentsLoading(true);
      const { data } = await API.get(`/contract-amendments`, { params: { contract: id } });
      setAmendments(Array.isArray(data) ? data : []);
      setAmendmentsError('');
    } catch (err) {
      // A failed read must not be shown as an empty history. Two things depend
      // on this list: the trail the requester reads, and the one-open-request
      // rule that decides whether the request button is offered. Reporting an
      // empty list for a failed request would claim no request is open and offer
      // a request the server then refuses with a 409, so the failure is kept
      // visible and the button is withheld until the list is known.
      setAmendments([]);
      setAmendmentsError(err.response?.data?.message || 'The amendment history could not be loaded.');
    } finally {
      setAmendmentsLoading(false);
    }
  };

  const fetchContract = async () => {
    try {
      setLoading(true);
      // The contract and its document list are read in parallel but settled
      // SEPARATELY, deliberately. `Promise.all` rejects as soon as either
      // request fails and discards the sibling's successful result, so a
      // failure in the document list - which reads a different collection and
      // can fail on its own - took down the whole page: the contract title,
      // Key Details, obligations and milestones all disappeared even though
      // `GET /contracts/:id` had succeeded, and the user was told the contract
      // could not be loaded. The amendment trail below is already fetched this
      // way for exactly this reason.
      //
      // Only the contract read may blank the page. A document-list failure is
      // reported inside the Documents panel, which then declines to show an
      // empty state, because "no documents" and "the list could not be read"
      // are different facts and only one of them is true.
      const [contractResult, documentsResult] = await Promise.allSettled([
        API.get(`/contracts/${id}`),
        API.get(`/documents/contract/${id}`),
      ]);

      if (contractResult.status === 'fulfilled') {
        setContract(contractResult.value.data);
        setError('');
      } else {
        setContract(null);
        setError(contractResult.reason?.response?.data?.message || 'Unable to load contract details');
      }

      if (documentsResult.status === 'fulfilled') {
        const list = documentsResult.value.data;
        setDocuments(Array.isArray(list) ? list : []);
        setDocumentsLoaded(true);
        setDocumentError('');
      } else {
        setDocuments([]);
        setDocumentsLoaded(false);
        setDocumentError(
          documentsResult.reason?.response?.data?.message
            || 'The document list could not be loaded.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContract();
    fetchAmendments();
  }, [id]);

  const handleFileUpload = async () => {
    const validationError = uploadValidationMessage(file);
    if (validationError) {
      setDocumentError(validationError);
      return;
    }

    try {
      setUploading(true);
      setUploadProgress(0);
      setDocumentError('');
      const formData = new FormData();
      formData.append('document', file);
      await API.post(`/documents/upload/${id}`, formData, {
        onUploadProgress: (event) => {
          if (event.total) setUploadProgress(Math.min(99, Math.round((event.loaded * 100) / event.total)));
        },
      });
      setUploadProgress(100);
      setFile(null);
      setFileInputKey((value) => value + 1);
      setToast({ type: 'success', message: 'Document uploaded successfully' });
      await fetchContract();
    } catch (err) {
      setDocumentError(await readErrorMessage(err, 'Upload failed'));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      await API.patch(`/contracts/${id}/archive`);
      setToast({ type: 'success', message: 'Contract archived' });
      navigate('/contracts');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to archive contract');
      setArchiving(false);
    }
  };

  const handleSubmitForApproval = async () => {
    // Guard: the button stays visible while the request is in flight, so a
    // double-click would otherwise queue two approval submissions.
    if (submittingForApproval) return;
    setSubmittingForApproval(true);
    try {
      await API.post(`/approvals/submit/${id}`);
      await fetchContract();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to submit for approval');
    } finally {
      setSubmittingForApproval(false);
    }
  };

  const handleDownload = async (docId, filename) => {
    try {
      setDownloadId(docId);
      setDocumentError('');
      const response = await API.get(`/documents/download/${docId}`, { responseType: 'blob' });
      if (response.data?.type?.includes('application/json')) {
        const payload = JSON.parse(await response.data.text());
        throw new Error(payload.message || 'Unable to download file');
      }
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setDocumentError(await readErrorMessage(err, err.message || 'Unable to download file'));
    } finally {
      setDownloadId(null);
    }
  };

  // Not a hook: a pure predicate over state the page already holds. Evaluated on
  // every render so the button reflects the contract's state and any open
  // request as soon as either changes.
  const amendmentRequest = canRequestAmendment({ contract, amendments, user });

  if (loading) {
    return (
      <div className="space-y-6" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading contract details…</span>
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="ricoz-skeleton h-9 w-9 rounded-xl" />
          <div className="flex-1 space-y-2">
            <div aria-hidden="true" className="ricoz-skeleton h-3 w-28 rounded-lg" />
            <div aria-hidden="true" className="ricoz-skeleton h-8 w-64 max-w-full rounded-lg" />
          </div>
        </div>
        <div className="grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
              <div aria-hidden="true" className="ricoz-skeleton mb-5 h-6 w-40 rounded-lg" />
              <div className="grid gap-4 md:grid-cols-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} aria-hidden="true" className="ricoz-skeleton h-10 w-full rounded-lg" />
                ))}
              </div>
            </div>
            <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
              <div aria-hidden="true" className="ricoz-skeleton mb-5 h-6 w-32 rounded-lg" />
              <div aria-hidden="true" className="ricoz-skeleton h-24 w-full rounded-lg" />
            </div>
          </div>
          <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
            <div aria-hidden="true" className="ricoz-skeleton mb-5 h-6 w-28 rounded-lg" />
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} aria-hidden="true" className="ricoz-skeleton mb-3 h-9 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
        {error || 'Contract not found'}
        <Link to="/contracts" className="mt-3 block font-semibold underline">Back to contracts</Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={() => navigate('/contracts')} aria-label="Back to contracts" className="shrink-0 rounded-xl border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.16em] text-[#1d4ed8]">{contract.contractNumber}</p>
            <h1 className="mt-2 break-words text-2xl font-black tracking-[-0.06em] text-[#0f172a] sm:text-3xl lg:text-4xl">{contract.title}</h1>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Link to={`/contracts/${id}/edit`} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Pencil className="w-4 h-4" /> Edit
          </Link>
          {/* The forward path for the fields the Edit screen now locks. Shown
              only where the server would accept the request, so a Draft or a
              contract with an open request is never invited to raise one. */}
          {!amendmentsError && amendmentRequest.allowed && (
            <button
              type="button"
              onClick={() => setAmendmentOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-[#d51d29]/40 bg-[#fff0f0] px-4 py-3 text-sm font-semibold text-[#d51d29] hover:bg-[#ffe4e4] dark:border-[#d51d29]/50 dark:bg-[#d51d29]/15 dark:text-[#ff8a90]"
            >
              <FilePen className="w-4 h-4" /> Request Amendment
            </button>
          )}
          {canSubmitForApproval(contract.status) && (
            <button
              type="button"
              onClick={handleSubmitForApproval}
              disabled={submittingForApproval}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1e293b] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submittingForApproval ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <BadgeCheck className="w-4 h-4" />}
              {submittingForApproval ? 'Submitting…' : 'Submit for Approval'}
            </button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}

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
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Start Date</span><span className="font-medium text-slate-800">{formatDate(contract.startDate)}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">End Date</span><span className="font-medium text-slate-800">{formatDate(contract.endDate)}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Value</span><span className="font-medium text-slate-800">{contract.currency} {Number(contract.amount || 0).toLocaleString()}</span></div>
              <div><span className="block text-xs uppercase tracking-wide text-slate-500">Created By</span><span className="font-medium text-slate-800">{contract.createdBy?.name || 'Unknown'}</span></div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">Description</h3>
              <p className="text-slate-700 leading-7">{contract.description || 'No description provided.'}</p>
            </div>
          </div>

          {/* The amendment trail. Rendered for every role that can open the
              contract, because the requester has to be able to see what
              happened to their request; the server scopes the list to the
              contracts the caller may read. */}
          <div className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-bold text-slate-800">Amendments</h2>
              {amendmentsError ? (
                /* Unknown, not empty: withhold the request control rather than
                   offer one the server may refuse. */
                <p className="text-xs text-slate-500 sm:text-right">
                  Reload the page to try again before requesting an amendment.
                </p>
              ) : amendmentRequest.allowed ? (
                <button
                  type="button"
                  onClick={() => setAmendmentOpen(true)}
                  className="inline-flex items-center gap-1.5 self-start rounded-xl border border-[#d51d29]/40 bg-[#fff0f0] px-3 py-2 text-xs font-semibold text-[#d51d29] hover:bg-[#ffe4e4] dark:border-[#d51d29]/50 dark:bg-[#d51d29]/15 dark:text-[#ff8a90]"
                >
                  <FilePen className="w-3.5 h-3.5" /> Request Amendment
                </button>
              ) : (
                <p className="text-xs text-slate-500 sm:text-right">{amendmentRequest.reason}</p>
              )}
            </div>
            {amendmentsError ? (
              <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {amendmentsError}
              </p>
            ) : (
              <AmendmentHistory
                amendments={amendments}
                loading={amendmentsLoading}
                isEditableStatus={isEditableStatus(contract.status)}
              />
            )}
          </div>

          <div className="rounded-[26px] border border-slate-200 bg-white p-4 sm:p-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-4">
              <h2 className="text-lg font-bold text-slate-800">Documents</h2>
              {/* The count is only stated once the list has actually been read;
                  otherwise a failed read would report "0 files" as though the
                  contract were known to have none. */}
              {documentsLoaded && (
                <span className="text-sm text-slate-500">{documents.length} {documents.length === 1 ? 'file' : 'files'}</span>
              )}
            </div>

            <div className="flex flex-col gap-3 mb-3">
              <label htmlFor="document-upload" className="sr-only">Choose a contract document</label>
              <input
                id="document-upload"
                key={fileInputKey}
                type="file"
                accept=".pdf,.docx,.doc,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={uploading}
                onChange={(event) => {
                  const selectedFile = event.target.files?.[0] || null;
                  setFile(selectedFile);
                  setDocumentError(selectedFile ? uploadValidationMessage(selectedFile) : '');
                }}
                className="block w-full rounded-xl text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2.5 file:text-slate-700 hover:file:bg-slate-200 disabled:opacity-60"
              />
              <button
                onClick={handleFileUpload}
                disabled={!file || uploading}
                aria-busy={uploading}
                className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {uploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? `Uploading ${uploadProgress}%` : 'Upload document'}
              </button>
            </div>

            <p className="mb-5 text-xs text-slate-500">PDF, DOCX or DOC up to 10 MiB. Each upload is stored as a new contract version.</p>

            {uploading && (
              <div className="mb-5" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={uploadProgress} aria-label="Document upload progress">
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-[#0f172a] transition-[width] duration-200" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}

            {documentError && (
              <div role="alert" className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{documentError}</div>
            )}

            <div className="space-y-3">
              {!documentsLoaded ? (
                // The list was never read, so the count and the rows below would
                // both be inventions. The reason is already announced above.
                <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  The document list is unavailable right now.
                </p>
              ) : documents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <FileText className="mx-auto h-8 w-8 text-slate-400" />
                  <p className="mt-3 text-sm font-semibold text-slate-700">No documents yet</p>
                  <p className="mt-1 text-sm text-slate-500">Upload the first signed copy, addendum or supporting file.</p>
                </div>
              ) : (
                documents.map((doc) => {
                  const isDownloading = downloadId === doc._id;
                  return (
                    <div key={doc._id} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <FileText className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-800">{doc.originalname}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">Version {doc.version}</span>
                            <span>{formatFileSize(doc.fileSize)}</span>
                            <span>{formatDateTime(doc.createdAt)}</span>
                            {doc.uploadedBy?.name && <span>Uploaded by {doc.uploadedBy.name}</span>}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDownload(doc._id, doc.originalname)}
                        disabled={downloadId !== null}
                        aria-busy={isDownloading}
                        className="inline-flex w-full flex-shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-blue-600 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                      >
                        {isDownloading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        {isDownloading ? 'Downloading' : 'Download'}
                      </button>
                    </div>
                  );
                })
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
                <dd className="font-medium text-slate-800">{formatDateTime(contract.updatedAt)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {/* The amendment form. The contract is not reloaded on submit because
          nothing about the contract changed: a request is not a change. The
          trail is, so only that is refetched. */}
      <RequestAmendmentModal
        isOpen={amendmentOpen}
        contract={contract}
        amendments={amendments}
        user={user}
        onClose={() => setAmendmentOpen(false)}
        onSubmitted={async () => {
          setAmendmentOpen(false);
          setToast({ type: 'success', message: 'Amendment requested. An administrator or manager will decide it.' });
          await fetchAmendments();
        }}
      />

      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
};

export default ContractDetails;
