import React, { useEffect, useMemo, useState } from 'react';
import API from '../../services/api';
import Modal from '../Layout/Common/Modal';
import SubmitButton from '../Layout/Common/SubmitButton';
import { canManage } from '../../utils/roles';
import { formatDate } from '../../utils/date';
import { isEditableStatus } from '../../utils/contractEditLock';
import {
  AMENDABLE_FIELDS,
  CURRENCIES,
  FIELD_LABELS,
  UNASSIGNED,
  buildProposed,
  canRequestAmendment,
  changedFields,
  emptyAmendmentDraft,
  validateAmendmentDraft
} from '../../utils/amendments';

// The same field treatment the create and edit forms use, so the amendment
// form is not a third visual dialect of the same input.
const field = 'mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100';
const errorField = 'border-red-300 focus:border-red-500 focus:ring-red-100';

const formatAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString() : '';
};

const currentValueLabel = (fieldName, contract) => {
  if (fieldName === 'amount') {
    return contract?.currency
      ? `${contract.currency} ${formatAmount(contract.amount)}`
      : formatAmount(contract.amount);
  }
  if (fieldName === 'currency') return contract?.currency || 'Not set';
  if (fieldName === 'startDate' || fieldName === 'endDate') {
    return contract?.[fieldName] ? formatDate(contract[fieldName]) : 'Not set';
  }
  if (fieldName === 'assignedUser') return contract?.assignedUser?.name || 'Unassigned';
  return '';
};

const toDateInput = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

/**
 * The amendment request form.
 *
 * It never touches the contract. It collects a `proposed` map and posts it to
 * the amendment route, which is what makes this a request rather than an edit:
 * the contract is not modified until an Admin or Manager approves it, and the
 * request itself is what the queue shows them.
 *
 * Every input is blank and blank means "leave this field alone"; the value
 * currently in force is shown beside each label rather than pre-filled. That is
 * what lets someone amend only the end date - pre-filling would submit all five
 * fields and the server would reject the four unchanged ones as a no-op.
 */
const RequestAmendmentModal = ({ isOpen, contract, amendments = [], user, onClose, onSubmitted }) => {
  const [draft, setDraft] = useState(emptyAmendmentDraft());
  const [reason, setReason] = useState('');
  const [directory, setDirectory] = useState([]);
  const [directoryError, setDirectoryError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [touched, setTouched] = useState(false);

  const permitted = canRequestAmendment({ contract, amendments, user });
  const editable = Boolean(contract) && !isEditableStatus(contract?.status) && !contract?.isArchived;

  // The assignee picker needs a list of people to offer. The only source,
  // GET /users/directory, is gated to Admin and Manager, so it is requested
  // only for those roles: an Employee sees the current assignee read-only
  // rather than an empty dropdown they can never fill in. This widens no
  // existing data exposure; it just does not offer a control the caller's role
  // cannot back.
  const mayPickAssignee = canManage(user?.role);

  useEffect(() => {
    if (!isOpen || !mayPickAssignee) return undefined;
    let active = true;
    API.get('/users/directory')
      .then(({ data }) => {
        if (!active) return;
        setDirectory(Array.isArray(data) ? data : []);
        setDirectoryError('');
      })
      .catch(() => {
        if (!active) return;
        setDirectory([]);
        setDirectoryError('The user directory could not be loaded, so the assignee cannot be changed in this request.');
      });
    return () => { active = false; };
  }, [isOpen, mayPickAssignee]);

  // Reopening the dialog must not show the previous request's values or a
  // stale validation message.
  useEffect(() => {
    if (!isOpen) return;
    setDraft(emptyAmendmentDraft());
    setReason('');
    setSubmitError('');
    setTouched(false);
  }, [isOpen]);

  const validation = useMemo(
    () => validateAmendmentDraft(draft, contract, reason),
    [draft, contract, reason]
  );

  const set = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setTouched(true);
    if (!validation.valid) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      await API.post('/contract-amendments', {
        contract: contract._id,
        proposed: buildProposed(draft),
        reason: reason.trim()
      });
      onSubmitted();
    } catch (err) {
      // The server is the authority on every rule here, so its message is what
      // the user reads. The only one worth translating is the stale/direct-edit
      // pair, which is a state change rather than a bad value.
      setSubmitError(err.response?.data?.message || 'Unable to submit the amendment request');
      setSubmitting(false);
    }
  };

  const selected = changedFields(draft);
  const showFieldError = (name) => (touched ? validation.fieldErrors[name] : '');
  const inputProps = (name) => ({
    id: `amend-${name}`,
    name,
    value: draft[name],
    onChange: set(name),
    'aria-invalid': Boolean(showFieldError(name)) || undefined,
    'aria-describedby': showFieldError(name) ? `amend-${name}-error` : undefined,
    className: `${field}${showFieldError(name) ? ` ${errorField}` : ''}`
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Request an amendment"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <SubmitButton
            /* The button lives in the modal's footer, outside the <form> in the
               scrollable body, so it is associated by id rather than by
               nesting. Without this it would be a dead control. */
            form="amendment-request-form"
            loading={submitting}
            loadingLabel="Submitting…"
            disabled={!editable || !permitted.allowed}
            className="rounded-xl bg-[#d51d29] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#b91c26]"
          >
            Submit request
          </SubmitButton>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {contract?.contractNumber} is in state &apos;{contract?.status}&apos;. Its amount, currency, dates
          and assignee were fixed by an approval, so they can only be changed through an approved
          amendment. Title, counterparty and description stay editable from the Edit screen.
        </p>

        {!permitted.allowed && (
          <p role="note" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            {permitted.reason}
          </p>
        )}

        {submitError && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
            {submitError}
          </p>
        )}

        <form id="amendment-request-form" onSubmit={handleSubmit} className="space-y-4">
          {AMENDABLE_FIELDS.map((fieldName) => (
            <div key={fieldName}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <label htmlFor={`amend-${fieldName}`} className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  {FIELD_LABELS[fieldName]}
                </label>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Current: {currentValueLabel(fieldName, contract)}
                </span>
              </div>

              {fieldName === 'amount' && (
                <>
                  <input type="number" inputMode="decimal" min="0" step="any" placeholder="No change" {...inputProps(fieldName)} />
                  {showFieldError(fieldName) && (
                    <p id={`amend-${fieldName}-error`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                      {showFieldError(fieldName)}
                    </p>
                  )}
                </>
              )}

              {fieldName === 'currency' && (
                <>
                  <select {...inputProps(fieldName)}>
                    <option value="">No change</option>
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </>
              )}

              {(fieldName === 'startDate' || fieldName === 'endDate') && (
                <>
                  <input
                    type="date"
                    placeholder="No change"
                    min={fieldName === 'endDate' ? toDateInput(draft.startDate || contract?.startDate) : undefined}
                    {...inputProps(fieldName)}
                  />
                  {showFieldError(fieldName) && (
                    <p id={`amend-${fieldName}-error`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                      {showFieldError(fieldName)}
                    </p>
                  )}
                </>
              )}

              {fieldName === 'assignedUser' && (
                mayPickAssignee && !directoryError ? (
                  <select {...inputProps(fieldName)}>
                    <option value="">No change</option>
                    <option value={UNASSIGNED}>Unassigned (clear assignee)</option>
                    {directory.map((person) => (
                      <option key={person._id} value={person._id}>{person.name}</option>
                    ))}
                  </select>
                ) : (
                  /* Read-only for everyone else, and for an approver whose
                     directory read failed. The current value is still stated
                     above, so nothing is hidden - it just cannot be changed. */
                  <p className="mt-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-400">
                    {directoryError || 'Ask an administrator or manager to reassign this contract.'}
                  </p>
                )
              )}
            </div>
          ))}

          <div>
            <label htmlFor="amend-reason" className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Reason for the amendment
            </label>
            <textarea
              id="amend-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why the approved terms need to change. An approver decides on this text."
              aria-invalid={touched && Boolean(validation.reasonError) ? true : undefined}
              aria-describedby={touched && validation.reasonError ? 'amend-reason-error' : undefined}
              className={`mt-2 w-full rounded-xl border border-slate-200 bg-[#f8fafc] p-3 text-sm outline-none transition focus:border-[#1d4ed8] focus:bg-white focus:ring-4 focus:ring-blue-100${touched && validation.reasonError ? ` ${errorField}` : ''}`}
            />
            {touched && validation.reasonError && (
              <p id="amend-reason-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {validation.reasonError}
              </p>
            )}
          </div>

          {touched && validation.formError && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
              {validation.formError}
            </p>
          )}

          <p className="text-xs text-slate-500 dark:text-slate-400">
            {selected.length
              ? `${selected.length} field${selected.length === 1 ? '' : 's'} proposed: ${selected.map((f) => FIELD_LABELS[f]).join(', ')}.`
              : 'No fields selected yet. Leave a field blank to keep its current value.'}
            {' '}The contract is not changed until an administrator or manager approves this request,
            and you cannot approve your own.
          </p>
        </form>
      </div>
    </Modal>
  );
};

export default RequestAmendmentModal;
