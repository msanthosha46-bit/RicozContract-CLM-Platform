import React, { useContext, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/AuthContext';
import Sidebar from './components/Layout/Sidebar';
import Topbar from './components/Layout/Topbar';

import Login from './pages/Login';
import Register from './pages/Register';
import LandingPage from './pages/LandingPage';
import Dashboard from './pages/Dashboard';
import ContractsList from './pages/ContractsList';
import CreateContract from './pages/CreateContract';
import ContractDetails from './pages/ContractDetails';
import EditContract from './pages/EditContract';
import ApprovalRequests from './pages/ApprovalRequests';
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="ricoz-shell flex min-h-screen bg-[#f3f5f8] font-sans text-slate-900">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 p-4 sm:p-5 md:p-8">{children}</main>
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
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<ProtectedLayout><Dashboard /></ProtectedLayout>} />
          <Route path="/contracts" element={<ProtectedLayout><ContractsList /></ProtectedLayout>} />
          <Route path="/contracts/create" element={<ProtectedLayout><CreateContract /></ProtectedLayout>} />
          <Route path="/contracts/:id" element={<ProtectedLayout><ContractDetails /></ProtectedLayout>} />
          <Route path="/contracts/:id/edit" element={<ProtectedLayout><EditContract /></ProtectedLayout>} />
          <Route
            path="/approvals"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={['Admin', 'Manager']}>
                  <ApprovalRequests />
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
                <RoleProtectedRoute allowedRoles={['Admin', 'Manager']}>
                  <RenewalManagement />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={['Admin', 'Manager']}>
                  <Reports />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/activity"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={['Admin', 'Manager']}>
                  <ActivityLog />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={['Admin']}>
                  <UserManagement />
                </RoleProtectedRoute>
              </ProtectedLayout>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedLayout>
                <RoleProtectedRoute allowedRoles={['Admin']}>
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
  );
}

export default App;