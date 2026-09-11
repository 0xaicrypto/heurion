import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { ErrorBoundary, RouteBoundary } from '@/components/ErrorBoundary';
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
  // #919: 每个 /app/* 路由段包一层轻量 ErrorBoundary — 单页崩溃不再拖垮
  // 整个应用（根级边界保持不变），切路由自动复位。
  return <RouteBoundary>{children}</RouteBoundary>;
}

/**
 * #979 — 文档编辑器随 docId 重建。切换文档时 key 变化触发重挂载，写状态
 * （diffReview/saveConflict/appliedDocBody/审阅队列/PHI/导出态）天然清零 —
 * 根治「切换文档 reset 清单持续漂移」的串染问题（历史上 #902/#903 修过
 * 一批，reset 清单后来新增状态未跟上：A 文档未处理的 diff/冲突横幅可能
 * 残留渲染在 B 文档上，点「接受」会把 A 的合并内容写进 B）。路由层
 * key 一次性根治，组件内另有双保险 effect（writing-editor.tsx）。
 */
function WritingEditorRoute() {
  const { docId } = useParams<{ docId: string }>();
  return <WritingEditorPage key={docId ?? 'none'} />;
}

/** #716 — 仅管理员可访问（侧边栏隐藏只是视觉层，路由必须有真实守卫）。 */
function RequireRole({ role, children }: { role: 'admin'; children: React.ReactNode }) {
  const { role: userRole } = useAuthStore();
  const location = useLocation();
  if (userRole !== role) {
    return <Navigate to="/app/today" state={{ from: location }} replace />;
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
                <WritingEditorRoute />
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
                <RequireRole role="admin">
                  <AdminUsersPage />
                </RequireRole>
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
