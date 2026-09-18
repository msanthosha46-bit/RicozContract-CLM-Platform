import React, { useContext } from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, FileText, CheckSquare, Clock, Flag,
  BarChart3, Users, Settings, ShieldCheck, FilePlus, User, Activity
} from 'lucide-react';
import { AuthContext } from '../../context/AuthContext';

const Sidebar = () => {
  const { user } = useContext(AuthContext);

  const links = [
    { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Contracts', path: '/contracts', icon: FileText, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Create Contract', path: '/contracts/create', icon: FilePlus, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Approval Requests', path: '/approvals', icon: ShieldCheck, roles: ['Admin', 'Manager'] },
    { name: 'Obligations', path: '/obligations', icon: CheckSquare, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Milestones', path: '/milestones', icon: Flag, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Renewals', path: '/renewals', icon: Clock, roles: ['Admin', 'Manager'] },
    { name: 'Reports', path: '/reports', icon: BarChart3, roles: ['Admin', 'Manager'] },
    { name: 'Activity Log', path: '/activity', icon: Activity, roles: ['Admin', 'Manager'] },
    { name: 'User Management', path: '/users', icon: Users, roles: ['Admin'] },
    { name: 'Profile', path: '/profile', icon: User, roles: ['Admin', 'Manager', 'Employee'] },
    { name: 'Settings', path: '/settings', icon: Settings, roles: ['Admin'] },
  ];

  return (
    <aside className="w-72 bg-[#f5f6f8] text-[#64748b] flex flex-col min-h-screen border-r border-[#e2e5ea]">
      <div className="flex h-20 items-center px-6 border-b border-[#e2e5ea]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#d51d29] text-lg font-black text-white shadow-lg shadow-red-200">
            R
          </div>
          <div className="text-xl font-black tracking-[-0.05em] text-[#0f1d3a]">
            Ricoz<span className="text-[#64748b]">Invoice</span>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-4 py-6 space-y-1.5">
        {links.filter(l => l.roles.includes(user?.role)).map((link) => {
          const Icon = link.icon;

          return (
            <NavLink
              key={link.path}
              to={link.path}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-white text-[#0f1d3a] shadow-[0_8px_24px_rgba(15,29,58,0.08)]'
                    : 'text-[#64748b] hover:bg-white/70 hover:text-[#0f1d3a]'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {link.name}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-[#e2e5ea] p-4">
        <div className="rounded-2xl border border-[#f2cfd1] bg-[#fff0f0] p-4 text-xs text-[#64748b]">
          <div className="font-bold text-[#0f1d3a]">Make room for growth</div>
          <div className="mt-1 leading-5">Keep your contract work calm as business picks up.</div>
          <div className="mt-3 font-bold text-[#d51d29]">Explore plans ↗</div>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;