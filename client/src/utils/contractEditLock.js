// Client-side mirror of the server edit-lock policy in server/utils/contractEditLock.js.
//
// The server is the authority - it returns 409 for a locked field regardless of
// what the form does. This exists so the user is not invited to make an edit that
// is guaranteed to fail: the inputs are disabled and the reason is shown, instead
// of a save that appears to succeed and then returns "cannot change amount".
//
// The two lists are duplicated rather than fetched. Keeping them here mirrors how
// contractTransitions.js already shares the status vocabulary with the server, and
// avoids a request on every form render. A test pins this list to the server's so
// the two cannot drift apart unnoticed.
export const UNLOCKED_STATUSES = ['Draft', 'Rejected'];

export const LOCKED_FIELDS = ['amount', 'currency', 'startDate', 'endDate', 'assignedUser'];

// True when the financial terms, the dates and the assignee may still be edited
// directly for a contract in this state.
export const isEditableStatus = (status) => UNLOCKED_STATUSES.includes(status);

export const isFieldLocked = (status, field) =>
  !isEditableStatus(status) && LOCKED_FIELDS.includes(field);
