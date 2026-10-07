import React from 'react';
import StatusBadge from '../Layout/Common/StatusBadge';
import EmptyState from '../Layout/Common/EmptyState';
import { FilePen, ShieldCheck, XCircle, Clock, Lock } from 'lucide-react';
import { describeAmendmentChanges } from '../../utils/amendments';

const iconFor = (status) => {
  if (status === 'Approved') return { Icon: ShieldCheck, tone: 'text-emerald-600 dark:text-emerald-400' };
  if (status === 'Rejected') return { Icon: XCircle, tone: 'text-red-600 dark:text-red-400' };
  return { Icon: Clock, tone: 'text-amber-600 dark:text-amber-400' };
};

const formatStamp = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const FieldChange = ({ fieldName, from, to }) => (
  <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
    <span className="font-semibold text-slate-700 dark:text-slate-200">{fieldName}</span>
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 line-through decoration-slate-400 dark:bg-slate-700/50 dark:text-slate-300">
      {from || '—'}
    </span>
    <span aria-hidden="true" className="text-slate-400">&rarr;</span>
    <span className="font-semibold text-slate-800 dark:text-slate-100">{to || '—'}</span>
  </li>
);

/**
 * The amendment trail for one contract: every request, whatever its outcome.
 *
 * Rendered from `GET /contract-amendments?contract=<id>`, which the server
 * already scopes to the contracts the caller may read, so nothing here decides
 * what is visible.
 *
 * Only what a decision needs is shown: who asked, what they asked for, why, and
 * who decided it and when. The requester's and the approver's email addresses
 * are not rendered - the names are enough to identify a colleague, and the feed
 * does not need the address book.
 */
const AmendmentHistory = ({ amendments = [], loading = false, isEditableStatus: editable = false }) => {
  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-busy="true">
        <span className="sr-only">Loading amendment history…</span>
        {[0, 1].map((row) => (
          <div key={row} aria-hidden="true" className="ricoz-skeleton h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!amendments.length) {
    return (
      <EmptyState
        compact
        icon={Lock}
        title={editable ? 'No amendments needed' : 'No amendments yet'}
        description={
          editable
            ? 'This contract is edited directly, so its amount, dates and assignee are not locked.'
            : 'Amount, currency, dates and the assignee are locked from submission. A change to any of them is raised as an amendment and decided separately.'
        }
      />
    );
  }

  return (
    <ul className="space-y-3">
      {amendments.map((amendment) => {
        const { Icon, tone } = iconFor(amendment.status);
        const changes = describeAmendmentChanges(amendment);
        return (
          <li
            key={amendment._id}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    Requested by {amendment.requestedBy?.name || 'Unknown'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {formatStamp(amendment.createdAt)}
                  </p>
                </div>
              </div>
              <StatusBadge status={amendment.status} />
            </div>

            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Reason:</span>{' '}
              {amendment.reason}
            </p>

            <ul className="mt-2.5 space-y-1">
              {changes.map((change) => (
                <FieldChange key={change.field} fieldName={change.label} from={change.from} to={change.to} />
              ))}
            </ul>

            {amendment.status !== 'Pending' && (
              <p className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">
                {amendment.status === 'Approved' ? 'Approved' : 'Rejected'} by{' '}
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {amendment.decidedBy?.name || 'Unknown'}
                </span>
                {amendment.decidedAt ? ` on ${formatStamp(amendment.decidedAt)}` : ''}
                {amendment.decisionComments ? ` — ${amendment.decisionComments}` : ''}
              </p>
            )}

            {amendment.status === 'Pending' && (
              <p className="mt-2.5 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <FilePen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Awaiting a decision from an administrator or manager.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default AmendmentHistory;
