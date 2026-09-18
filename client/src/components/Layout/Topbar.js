import React, { useContext } from 'react';
import { AuthContext } from '../../context/AuthContext';
import { LogOut, Menu, User as UserIcon } from 'lucide-react';

const Topbar = ({ onMenuClick }) => {
  const { user, logout } = useContext(AuthContext);

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm sm:h-20 sm:px-5 md:px-8">
      <div className="flex h-full items-center justify-between">
        <div className="flex min-w-0 items-center gap-2 text-sm font-bold">
          <button aria-label="Open navigation" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 md:hidden" onClick={onMenuClick}><Menu className="h-5 w-5" /></button>
          <span className="rounded-full bg-[#fff0f0] px-3 py-2 text-[#d51d29]">Workspace</span>
          <span className="hidden text-slate-300 sm:inline">/</span>
          <span className="hidden truncate text-[#0f1d3a] sm:inline">Overview</span>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-3 rounded-full border border-slate-200 bg-[#f8fafc] px-3 py-2 lg:flex">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eaf1ff] text-[#1d4ed8]">
              <UserIcon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-slate-700">{user?.email}</span>
          </div>

          <button className="hidden h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm lg:flex" title="Notifications">•</button>
          <button className="inline-flex items-center gap-2 rounded-xl bg-[#d51d29] px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26] sm:px-4 sm:py-3" onClick={logout}>
            <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default Topbar;