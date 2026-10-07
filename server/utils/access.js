const idOf = (ref) => {
  if (!ref) return null;
  if (typeof ref === 'object' && ref._id) return ref._id.toString();
  return ref.toString();
};

// The roles that may see every contract, derived from the same two constants the
// route guards use (`authorize('Admin', 'Manager')`).
//
// This used to be a negative test - "anything that is not an Employee is
// privileged" - which fails open: a user whose role is missing, misspelled or
// left over from a future/renamed role would be granted read and write access to
// the entire repository, while `authorize` (an allow-list) would still refuse
// that same user on every role-gated route. The two checks disagreed, and the
// permissive one was the one guarding contract, document and work-item access.
// An allow-list cannot disagree with `authorize` in that way.
const PRIVILEGED_ROLES = new Set(['Admin', 'Manager']);

// The single question every scope check must answer: "does this user see the
// whole repository?". It is an allow-list, exactly like the `authorize` route
// guard, so the two cannot disagree.
//
// The call sites used to ask the inverse - "is this user an Employee?" - and
// answer `false` (i.e. repository-wide) for everything else. That fails open
// for a role value that is merely *not* 'Employee': a missing, null, renamed or
// future role was granted the whole contract list, the whole dashboard and
// every obligation and milestone, while `canAccessContract` - which is an
// allow-list - refused the very same user on `GET /contracts/:id` and on
// document downloads. The permissive check was the one guarding the listing
// routes. Deriving the predicate from one set means a role added to the
// allow-list in a single place is honoured everywhere at once.
const isPrivileged = (user) => Boolean(user && PRIVILEGED_ROLES.has(user.role));

const canAccessContract = (user, contract) => {
  if (!user || !contract) return false;
  if (isPrivileged(user)) return true;
  const uid = idOf(user._id);
  if (!uid) return false;
  return idOf(contract.createdBy) === uid || idOf(contract.assignedUser) === uid;
};

const employeeContractScope = (userId) => ({
  $or: [{ createdBy: userId }, { assignedUser: userId }]
});

module.exports = { idOf, isPrivileged, canAccessContract, employeeContractScope, PRIVILEGED_ROLES };
