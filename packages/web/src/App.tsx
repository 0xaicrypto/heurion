import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChatPage } from '@/routes/chat';
import { LandingPage } from '@/routes/landing';
import { LoginPage } from '@/routes/login';
import { TodayPage } from '@/routes/today';
import { MemoryKnowledgePage } from '@/routes/memory-knowledge';
import { PatientsLayout, PatientSummaryPage, PatientChatPage } from '@/routes/patients';
import { ImagingPage } from '@/routes/imaging';
import { LabsPage } from '@/routes/labs';
import { MemoryGraphPage } from '@/routes/memory-graph';
import { MemoryGraphVizPage } from '@/routes/memory-graph-viz';
import { MemoryPage } from '@/routes/memory';
import { SidecarPage } from '@/routes/sidecar';
import { KnowledgeLandingPage } from '@/routes/knowledge-landing';
import { SecurityPage } from '@/routes/security';

import { ReportPage } from '@/routes/report-page';
import { MedicalRecordsPage } from '@/routes/medical-records';
import { ViewerPage } from '@/routes/viewer';
import { SettingsPage } from '@/routes/settings';
import { AdminUsersPage } from '@/routes/admin/users';
import { ResearchPage } from '@/routes/research';

import { ResearchDetailPage } from '@/routes/research-detail';
import { WritingPage } from '@/routes/writing';
import { WritingEditorPage } from '@/routes/writing-editor';
import { SkillsPage } from '@/routes/skills';
import { FilesPage } from '@/routes/files';
import { SchedulePage } from '@/routes/schedule';
import { ExportPage } from '@/routes/export-data';
import { PluginsPage } from '@/routes/plugins';
import { PluginSettingsPage } from '@/routes/plugin-settings';


import { useAuthStore } from '@/stores/auth';
import { PluginUIProvider } from '@/components/plugins/PluginUIRegistry';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function AuthEvents() {
  const navigate = useNavigate();

  useEffect(() => {
    // #460: api.logout() already clears the auth store — no separate clearSession.
    const handler = () => {
      api.logout();
      navigate('/login', { replace: true });
    };
    window.addEventListener('nexus:auth-expired', handler);
    return () => window.removeEventListener('nexus:auth-expired', handler);
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <>
      <AuthEvents />
      <ErrorBoundary>
        <PluginUIProvider>
          <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/sidecar" element={<SidecarPage />} />
          <Route path="/knowledge" element={<KnowledgeLandingPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <Navigate to="/app/today" replace />
              </RequireAuth>
            }
          />
          <Route
            path="/app/today"
            element={
              <RequireAuth>
                <TodayPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/memory"
            element={
              <RequireAuth>
                <MemoryKnowledgePage />
              </RequireAuth>
            }
          />
          {/* #230: legacy URLs redirect into the unified view */}
          <Route
            path="/app/brain"
            element={<Navigate to="/app/memory" replace />}
          />
          <Route
            path="/app/knowledge"
            element={<Navigate to="/app/memory?tab=knowledge" replace />}
          />
          <Route
            path="/app/chat"
            element={
              <RequireAuth>
                <ChatPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/patients"
            element={
              <RequireAuth>
                <PatientsLayout />
              </RequireAuth>
            }
          >
            <Route index element={<PatientSummaryPage />} />
            <Route path=":hash" element={<PatientSummaryPage />} />
            <Route path=":hash/chat" element={<PatientChatPage />} />
            <Route path=":hash/imaging" element={<ImagingPage />} />
            <Route path=":hash/labs" element={<LabsPage />} />
            <Route path=":hash/memory" element={<MemoryGraphPage />} />
            <Route path=":hash/report" element={<ReportPage />} />
            <Route path=":hash/records" element={<MedicalRecordsPage />} />
          </Route>
          <Route
            path="/app/viewer/:studyId"
            element={
              <RequireAuth>
                <ViewerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/research"
            element={
              <RequireAuth>
                <ResearchPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/submission"
            element={
              <RequireAuth>
                <Navigate to="/app/writing?tab=submission" replace />
              </RequireAuth>
            }
          />
          <Route
            path="/app/research/:studyId"
            element={
              <RequireAuth>
                <ResearchDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/writing"
            element={
              <RequireAuth>
                <WritingPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/writing/:docId"
            element={
              <RequireAuth>
                <WritingEditorPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/skills"
            element={
              <RequireAuth>
                <SkillsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/plugins"
            element={
              <RequireAuth>
                <PluginsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/plugins/:namespace/:name/settings"
            element={
              <RequireAuth>
                <PluginSettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/logs"
            element={
              <RequireAuth>
                <Navigate to="/app/settings?tab=logs" replace />
              </RequireAuth>
            }
          />
          <Route
            path="/app/audit"
            element={
              <RequireAuth>
                <Navigate to="/app/settings?tab=audit" replace />
              </RequireAuth>
            }
          />

          <Route
            path="/app/memory-graph"
            element={
              <RequireAuth>
                <MemoryGraphVizPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/files"
            element={
              <RequireAuth>
                <FilesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/schedule"
            element={
              <RequireAuth>
                <SchedulePage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/export"
            element={
              <RequireAuth>
                <ExportPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/admin/users"
            element={
              <RequireAuth>
                <AdminUsersPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </PluginUIProvider>
      </ErrorBoundary>
    </>
  );
}
