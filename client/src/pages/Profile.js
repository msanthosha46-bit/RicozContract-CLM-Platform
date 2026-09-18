import React, { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { LogOut, UserCircle2, Briefcase, Mail, ShieldCheck, CheckCircle2 } from 'lucide-react';

const Profile = () => {
  const { user, logout } = useContext(AuthContext);

  if (!user) {
    return <div className="p-8 text-slate-500">Please sign in to view your profile.</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#1d4ed8]">Account workspace</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.06em] text-[#0f172a]">My profile</h1>
          <p className="mt-2 text-slate-500">Your identity, access level, and workspace details.</p>
        </div>
        <button
          onClick={logout}
          className="inline-flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-100"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="rounded-[26px] border border-slate-200 bg-[#0f1d3a] p-6 text-white shadow-[0_20px_50px_rgba(15,23,42,0.14)]">
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 rounded-full bg-white/10 p-4 text-white">
              <UserCircle2 className="h-12 w-12" />
            </div>
            <h2 className="text-xl font-black">{user.name}</h2>
            <p className="mt-1 text-sm text-slate-300">{user.role}</p>
            <div className="mt-6 flex items-center gap-2 text-xs font-semibold text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Active workspace member</div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 text-2xl font-black tracking-[-0.05em] text-[#0f172a]">Profile details</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Mail className="h-4 w-4" /> Email
                </div>
                <p className="text-sm font-medium text-slate-800">{user.email}</p>
              </div>

              <div className="rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <ShieldCheck className="h-4 w-4" /> Role
                </div>
                <p className="text-sm font-medium text-slate-800">{user.role}</p>
              </div>

              <div className="rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Briefcase className="h-4 w-4" /> Department
                </div>
                <p className="text-sm font-medium text-slate-800">{user.department || 'General'}</p>
              </div>

              <div className="rounded-2xl border border-slate-100 bg-[#f7f7f8] p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <UserCircle2 className="h-4 w-4" /> Status
                </div>
                <p className="text-sm font-medium text-slate-800">Active</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Profile;
