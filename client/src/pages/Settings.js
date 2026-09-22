import React, { useContext, useState } from 'react';
import API from '../services/api';
import { AuthContext } from '../context/AuthContext';
import Toast from '../components/Layout/Common/Toast';

const Settings = () => {
  const { user, updateProfile } = useContext(AuthContext);
  const [preferences, setPreferences] = useState({
    emailNotifications: user?.preferences?.emailNotifications !== false,
    approvalReminders: user?.preferences?.approvalReminders !== false,
    expiryAlerts: user?.preferences?.expiryAlerts !== false
  });
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  const toggle = (key) => {
    setPreferences((current) => ({ ...current, [key]: !current[key] }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await API.put('/users/me', { preferences });
      updateProfile(data);
      setToast({ type: 'success', message: 'Settings saved' });
    } catch (error) {
      setToast({ type: 'error', message: error.response?.data?.message || 'Unable to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const rows = [
    { key: 'emailNotifications', label: 'Email notifications' },
    { key: 'approvalReminders', label: 'Approval reminders' },
    { key: 'expiryAlerts', label: 'Contract expiry alerts' }
  ];

  return (
    <div className="space-y-8">
      {toast && <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">System</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Settings</h1>
      </div>

      <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-black tracking-[-0.05em] text-[#0f172a]">Preferences</h2>
        <div className="mt-4 space-y-4 text-sm text-slate-600">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
              <span>{row.label}</span>
              <button
                type="button"
                onClick={() => toggle(row.key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${preferences[row.key] ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}
              >
                {preferences[row.key] ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          ))}
        </div>
        <button onClick={save} disabled={saving} className="mt-5 rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
          {saving ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </div>
  );
};

export default Settings;
