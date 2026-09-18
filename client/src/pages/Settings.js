import React from 'react';

const Settings = () => {
  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">System</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">Settings</h1>
      </div>

      <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-black tracking-[-0.05em] text-[#0f172a]">Preferences</h2>
        <div className="mt-4 space-y-4 text-sm text-slate-600">
          <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
            <span>Email notifications</span>
            <span className="font-medium text-emerald-600">Enabled</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
            <span>Approval reminders</span>
            <span className="font-medium text-emerald-600">Enabled</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
            <span>Contract expiry alerts</span>
            <span className="font-medium text-amber-600">Warning mode</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
