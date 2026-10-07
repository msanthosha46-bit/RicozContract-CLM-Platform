import React, { useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ADMIN_ROLES, MANAGER_ROLES } from './utils/roles';
import Sidebar from './components/Layout/Sidebar';
import Topbar from './components/Layout/Topbar';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import LandingPage from './pages/LandingPage';
import Dashboard from './pages/Dashboard';
import ContractsList from './pages/ContractsList';
import CreateContract from './pages/CreateContract';
import ContractDetails from './pages/ContractDetails';
import EditContract from './pages/EditContract';
import ApprovalRequests from './pages/ApprovalRequests';
import AmendmentQueue from './pages/AmendmentQueue';
import Obligations from './pages/Obligations';
import Milestones from './pages/Milestones';
import RenewalManagement from './pages/RenewalManagement';
import Reports from './pages/Reports';
import ActivityLog from './pages/ActivityLog';
import UserManagement from './pages/UserManagement';
import Settings from './pages/Settings';
import Profile from './pages/Profile';

const ProtectedLayout = ({ children }) => {
  const { user } = useContext(AuthContext);
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // A tap on a link navigates, but the drawer state lives here, so it has to
  // be released on the navigation itself â€” otherwise a phone that navigates
  // with the keyboard or a redirect comes back with the drawer still open.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="ricoz-shell flex min-h-screen bg-[#f3f5f8] font-sans text-slate-900">
      <a href="#ricoz-main" className="ricoz-skip-link">Skip to main content</a>
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <main id="ricoz-main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none sm:p-5 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
};

const RoleProtectedRoute = ({ allowedRoles, children }) => {
  const { user } = useContext(AuthContext);

  if (!user) return <Navigate to="/login" replace />;
  if (!allowedRoles.includes(user.role)) return <Navigate to="/dashboard" replace />;

  return children;
};

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/dashboard" element={<ProtectedLayout><Dashboard /></ProtectedLayout>} />
          <Route path="/contracts" element={<ProtectedLayout><ContractsList /></ProtectedLayout>} />
          <Route path="/contracts/create" element={<ProtectedLayout><CreateContract /></ProtectedLayout>} />
          <Route path="/contracts/:id" element={<ProtectedLayout><ContractDetails /></ProtectedLayout>} />
          <Route path="/contracts/:id/edit" element={<ProtectedLayout><EditContract /></ProtectedLayout>} />
          <Route
            path="/approvals"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={MANAGER_ROLES}>
                  <ApprovalRequests />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/amendments"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={MANAGER_ROLES}>
                  <AmendmentQueue />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route path="/obligations" element={<ProtectedLayout><Obligations /></ProtectedLayout>} />
          <Route path="/milestones" element={<ProtectedLayout><Milestones /></ProtectedLayout>} />
          <Route
            path="/renewals"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={MANAGER_ROLES}>
                  <RenewalManagement />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={MANAGER_ROLES}>
                  <Reports />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/activity"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={MANAGER_ROLES}>
                  <ActivityLog />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={ADMIN_ROLES}>
                  <UserManagement />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={ADMIN_ROLES}>
                  <Settings />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route path="/profile" element={<ProtectedLayout><Profile /></ProtectedLayout>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;