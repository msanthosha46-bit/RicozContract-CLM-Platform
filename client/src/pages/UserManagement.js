import React, { useEffect, useState } from 'react';
import API from '../services/api';
import Toast from '../components/Layout/Common/Toast';
import { PageSkeleton } from '../components/Layout/Common/Skeleton';
import EmptyState from '../components/Layout/Common/EmptyState';
import { ROLES } from '../utils/roles';

const UserManagement = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState('');

  const fetchUsers = async () => {
    try {
      const { data } = await API.get('/users');
      setUsers(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const updateUser = async (id, field, value) => {
    try {
      await API.put(`/users/${id}/role`, { [field]: value });
      setToast({ type: 'success', message: 'User updated' });
      const { data } = await API.get('/users');
      setUsers(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update user');
    }
  };

  if (loading) {
    return <PageSkeleton rows={6} columns={5} />;
  }

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div>
        <p className="ricoz-eyebrow">Admin</p>
        <h1 className="text-4xl font-black tracking-[-0.06em] text-[#0f172a]">User management</h1>
      </div>

      {error && <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
        {users.length === 0 ? (
          <EmptyState title="No users yet" description="Accounts appear here as people join the workspace." />
        ) : (
          /* The table needs its own scroll container: index.css gives tables a
             40rem floor on a phone, and this parent clips overflow, so without
             this the Role and Status columns would be unreachable. */
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-[#f7f7f8] text-xs uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Name</th>
                  <th scope="col" className="px-4 py-3 font-medium">Email</th>
                  <th scope="col" className="px-4 py-3 font-medium">Role</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Department</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((user) => (
                  <tr key={user._id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-800">{user.name}</td>
                    <td className="px-4 py-3">{user.email}</td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Role for ${user.name}`}
                        value={user.role}
                        onChange={(event) => updateUser(user._id, 'role', event.target.value)}
                        className="rounded-lg border border-slate-200 bg-[#eaf1ff] px-2 py-1.5 text-xs font-semibold text-[#1d4ed8]"
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Status for ${user.name}`}
                        value={user.status || 'Active'}
                        onChange={(event) => updateUser(user._id, 'status', event.target.value)}
                        className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold"
                      >
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">{user.department || 'General'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserManagement;
