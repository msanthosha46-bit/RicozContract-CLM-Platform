// The three roles the server defines in models/User.js. The sidebar link
// filters, the route guards in App.js and the per-page permission checks all
// read from here so they cannot drift apart.
export const ROLES = ['Admin', 'Manager', 'Employee'];
export const ADMIN_ROLES = ['Admin'];
export const MANAGER_ROLES = ['Admin', 'Manager'];
export const ALL_ROLES = ['Admin', 'Manager', 'Employee'];

export const isAdmin = (role) => role === 'Admin';
export const isManager = (role) => role === 'Manager';
export const isEmployee = (role) => role === 'Employee';

// Everything gated behind `authorize('Admin', 'Manager')` on the server:
// approval decisions, renewals, reports, the activity log, the user
// directory, and the pending-approval notifications.
export const canManage = (role) => isAdmin(role) || isManager(role);

export const roleLabel = (role) => (ROLES.includes(role) ? role : 'Member');

export const initialsFor = (name) => {
	const parts = String(name || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!parts.length) return 'R';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};
