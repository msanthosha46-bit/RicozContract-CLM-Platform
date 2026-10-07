import React, { useContext, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, FileText, CheckSquare, Clock, Flag,
  BarChart3, Users, Settings, ShieldCheck, FilePlus, User, Activity, X, FilePen
} from 'lucide-react';
import { AuthContext } from '../../context/AuthContext';
import { ALL_ROLES, MANAGER_ROLES, ADMIN_ROLES, canManage } from '../../utils/roles';

const LINKS = [
  { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, roles: ALL_ROLES },
  { name: 'Contracts', path: '/contracts', icon: FileText, roles: ALL_ROLES },
  { name: 'Create Contract', path: '/contracts/create', icon: FilePlus, roles: ALL_ROLES },
  { name: 'Approval Requests', path: '/approvals', icon: ShieldCheck, roles: MANAGER_ROLES },
  { name: 'Amendment Requests', path: '/amendments', icon: FilePen, roles: MANAGER_ROLES },
  { name: 'Obligations', path: '/obligations', icon: CheckSquare, roles: ALL_ROLES },
  { name: 'Milestones', path: '/milestones', icon: Flag, roles: ALL_ROLES },
  { name: 'Renewals', path: '/renewals', icon: Clock, roles: MANAGER_ROLES },
  { name: 'Reports', path: '/reports', icon: BarChart3, roles: MANAGER_ROLES },
  { name: 'Activity Log', path: '/activity', icon: Activity, roles: MANAGER_ROLES },
  { name: 'User Management', path: '/users', icon: Users, roles: ADMIN_ROLES },
  { name: 'Profile', path: '/profile', icon: User, roles: ALL_ROLES },
  { name: 'Settings', path: '/settings', icon: Settings, roles: ADMIN_ROLES }
];

// A link covers the current path when it is that path or a parent of it, so a
// contract detail page still lights up "Contracts". `NavLink` cannot decide
// this on its own: it derives `aria-current="page"` from the very same prefix
// test and the attribute is not overridable, so on `/contracts/create` both the
// parent "Contracts" and the peer "Create Contract" item were marked current.
const coversPath = (pathname, path) => pathname === path || pathname.startsWith(`${path}/`);

const Sidebar = ({ isOpen, onClose }) => {
  const { user } = useContext(AuthContext);
  const location = useLocation();
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  const links = LINKS.filter((link) => link.roles.includes(user?.role));

  // The most specific link that covers the current path owns the highlight, so
  // a nested sibling wins over its parent section while a detail page with no
  // link of its own still falls back to the section it belongs to.
  const activePath = links.reduce(
    (best, link) =>
      coversPath(location.pathname, link.path) && link.path.length > (best ? best.length : -1) ? link.path : best,
    null
  );

  // A tap outside the drawer closes it, and so does Escape.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' || event.key === 'Esc') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Move focus into the drawer when it opens so keyboard users land inside it.
  useEffect(() => {
    if (isOpen && closeRef.current) closeRef.current.focus();
  }, [isOpen]);

  // Below md the drawer is off-canvas, so while it is closed it must also be
  // hidden: `visibility: hidden` takes it out of the tab order and out of the
  // accessibility tree without unmounting it. md:visible brings it back from
  // 768px up, where the drawer is permanently on screen.
  const drawerState = isOpen ? 'translate-x-0' : '-translate-x-full invisible md:visible';

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={isOpen ? 0 : -1}
        className={`fixed inset-0 z-30 bg-[#0f1d3a]/45 backdrop-blur-[2px] transition-opacity md:hidden ${isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
      />

      <aside
        id="ricoz-sidebar"
        ref={panelRef}
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(19rem,86vw)] max-w-full flex-col border-r border-[#e2e5ea] bg-[#f5f6f8] text-[#64748b] shadow-2xl transition-transform duration-200 md:static md:w-72 md:translate-x-0 md:shadow-none dark:border-slate-700 dark:bg-[#101827] dark:text-slate-400 ${drawerState}`}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-[#e2e5ea] px-4 dark:border-slate-700 sm:h-20 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#d51d29] text-base font-black text-white shadow-lg shadow-red-200 sm:h-10 sm:w-10 sm:text-lg">
              R
            </div>
            {/* The brand never wraps or clips: it truncates instead. */}
            <span className="min-w-0 truncate text-lg font-black tracking-[-0.05em] text-[#0f1d3a] sm:text-xl dark:text-slate-100">
              Ricoz<span className="text-[#64748b] dark:text-slate-500">Contract</span>
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close navigation"
            className="ml-auto shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-white hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100 md:hidden"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* The link list scrolls independently so a long menu never pushes
            the footer off a short viewport. */}
        <nav className="flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4 sm:py-5">
          {links.map((link) => {
            const Icon = link.icon;

            return (
              <Link
                key={link.path}
                to={link.path}
                onClick={onClose}
                aria-current={link.path === activePath ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                  link.path === activePath
                    ? 'bg-white text-[#0f1d3a] shadow-[0_8px_24px_rgba(15,29,58,0.08)] dark:bg-[#1a2436] dark:text-white'
                    : 'text-[#64748b] hover:bg-white/70 hover:text-[#0f1d3a] dark:text-slate-400 dark:hover:bg-[#1a2436] dark:hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{link.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-[#e2e5ea] p-3 dark:border-slate-700 sm:p-4">
          <div className="rounded-2xl border border-[#f2cfd1] bg-[#fff0f0] p-4 text-xs text-[#64748b] dark:border-[#d51d29]/30 dark:bg-[#d51d29]/10 dark:text-slate-400">
            <div className="font-bold text-[#0f1d3a] dark:text-slate-100">
              {canManage(user?.role) ? 'Renewal desk' : 'Your commitments'}
            </div>
            <div className="mt-1 leading-5">
              {canManage(user?.role)
                ? 'Track every end date and renew before it lapses.'
                : 'Obligations and milestones assigned to you appear here.'}
            </div>
            {/* A shortcut to a page, not the page's own entry in the menu, so
                it stays out of the active state the list above owns. */}
            <Link
              to={canManage(user?.role) ? '/renewals' : '/obligations'}
              onClick={onClose}
              className="mt-3 inline-block font-bold text-[#d51d29] dark:text-[#ff8a90]"
            >
              {canManage(user?.role) ? 'Open renewals' : 'Open obligations'} →
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
