import React, { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../../context/AuthContext';
import API from '../../services/api';
import { Bell, LogOut, Menu, User as UserIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

const Topbar = ({ onMenuClick }) => {
  const { user, logout } = useContext(AuthContext);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState({ count: 0, items: [] });

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await API.get('/notifications');
        setNotifications(data);
      } catch (error) {
        setNotifications({ count: 0, items: [] });
      }
    };
    load();
  }, []);

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

          <div className="relative">
            <button
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm"
              title="Notifications"
              onClick={() => setOpen((value) => !value)}
            >
              <Bell className="h-4 w-4" />
              {notifications.count > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d51d29] px-1 text-[10px] font-bold text-white">
                  {notifications.count}
                </span>
              )}
            </button>
            {open && (
              <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
                <p className="px-2 pb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Notifications</p>
                {notifications.items.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-slate-500">You are caught up.</p>
                ) : (
                  <div className="max-h-80 space-y-1 overflow-y-auto">
                    {notifications.items.map((item) => (
                      <Link key={item.id} to={item.href} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-2 hover:bg-slate-50">
                        <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                        <p className="text-xs text-slate-500">{item.detail}</p>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <button className="inline-flex items-center gap-2 rounded-xl bg-[#d51d29] px-3 py-2.5 text-sm font-bold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26] sm:px-4 sm:py-3" onClick={logout}>
            <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default Topbar;
