import React, { lazy, Suspense, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ADMIN_ROLES, MANAGER_ROLES } from './utils/roles';
import Sidebar from './components/Layout/Sidebar';
import Topbar from './components/Layout/Topbar';

const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ContractsList = lazy(() => import('./pages/ContractsList'));
const CreateContract = lazy(() => import('./pages/CreateContract'));
const ContractDetails = lazy(() => import('./pages/ContractDetails'));
const EditContract = lazy(() => import('./pages/EditContract'));
const ApprovalRequests = lazy(() => import('./pages/ApprovalRequests'));
const AmendmentQueue = lazy(() => import('./pages/AmendmentQueue'));
const Obligations = lazy(() => import('./pages/Obligations'));
const Milestones = lazy(() => import('./pages/Milestones'));
const RenewalManagement = lazy(() => import('./pages/RenewalManagement'));
const Reports = lazy(() => import('./pages/Reports'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const Settings = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));

const PageLoadingFallback = () => (
  <main className="flex min-h-screen items-center justify-center bg-[#f3f5f8] p-6 text-slate-700 dark:bg-[#0b1220] dark:text-slate-200">
    <p role="status" aria-live="polite">Loading page...</p>
  </main>
);

class RouteErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f3f5f8] p-6 text-center text-slate-700 dark:bg-[#0b1220] dark:text-slate-200">
          <p role="alert">This page could not be loaded. Please reload and try again.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-[#d51d29] px-4 py-2 font-semibold text-white"
          >
            Reload page
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}

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
        <RouteErrorBoundary>
        <Suspense fallback={<PageLoadingFallback />}>
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
        </Suspense>
        </RouteErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;