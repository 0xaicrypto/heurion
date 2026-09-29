import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { ErrorBoundary, RouteBoundary } from '@/components/ErrorBoundary';
// #1145: 代码分割 — 只有营销/登录入口急加载（首屏不需要业务依赖）。
// 入口包曾 3.1MB（静态 import 30+ 页面,连带 cytoscape/katex/tiptap 进
// 首屏）；业务路由一律 React.lazy,按访问按需拉 chunk。
import { LandingPage } from '@/routes/landing';
import { LoginPage } from '@/routes/login';

const ChatPage = lazy(() => import('@/routes/chat').then((m) => ({ default: m.ChatPage })));
const TodayPage = lazy(() => import('@/routes/today').then((m) => ({ default: m.TodayPage })));
const MemoryKnowledgePage = lazy(() => import('@/routes/memory-knowledge').then((m) => ({ default: m.MemoryKnowledgePage })));
const PatientsLayout = lazy(() => import('@/routes/patients').then((m) => ({ default: m.PatientsLayout })));
const PatientSummaryPage = lazy(() => import('@/routes/patients').then((m) => ({ default: m.PatientSummaryPage })));
const PatientChatPage = lazy(() => import('@/routes/patients').then((m) => ({ default: m.PatientChatPage })));
const ImagingPage = lazy(() => import('@/routes/imaging').then((m) => ({ default: m.ImagingPage })));
const LabsPage = lazy(() => import('@/routes/labs').then((m) => ({ default: m.LabsPage })));
const MemoryGraphPage = lazy(() => import('@/routes/memory-graph').then((m) => ({ default: m.MemoryGraphPage })));
const MemoryGraphVizPage = lazy(() => import('@/routes/memory-graph-viz').then((m) => ({ default: m.MemoryGraphVizPage })));
const MemoryPage = lazy(() => import('@/routes/memory').then((m) => ({ default: m.MemoryPage })));
const SidecarPage = lazy(() => import('@/routes/sidecar').then((m) => ({ default: m.SidecarPage })));
const KnowledgeLandingPage = lazy(() => import('@/routes/knowledge-landing').then((m) => ({ default: m.KnowledgeLandingPage })));
const SecurityPage = lazy(() => import('@/routes/security').then((m) => ({ default: m.SecurityPage })));
const ReportPage = lazy(() => import('@/routes/report-page').then((m) => ({ default: m.ReportPage })));
const MedicalRecordsPage = lazy(() => import('@/routes/medical-records').then((m) => ({ default: m.MedicalRecordsPage })));
const ViewerPage = lazy(() => import('@/routes/viewer').then((m) => ({ default: m.ViewerPage })));
const SettingsPage = lazy(() => import('@/routes/settings').then((m) => ({ default: m.SettingsPage })));
const AdminUsersPage = lazy(() => import('@/routes/admin/users').then((m) => ({ default: m.AdminUsersPage })));
const AdminMetricsPage = lazy(() => import('@/routes/admin/metrics').then((m) => ({ default: m.AdminMetricsPage })));
const ResearchPage = lazy(() => import('@/routes/research').then((m) => ({ default: m.ResearchPage })));
const ResearchDetailPage = lazy(() => import('@/routes/research-detail').then((m) => ({ default: m.ResearchDetailPage })));
const WritingPage = lazy(() => import('@/routes/writing').then((m) => ({ default: m.WritingPage })));
const WritingEditorPage = lazy(() => import('@/routes/writing-editor').then((m) => ({ default: m.WritingEditorPage })));
const SkillsPage = lazy(() => import('@/routes/skills').then((m) => ({ default: m.SkillsPage })));
const FilesPage = lazy(() => import('@/routes/files').then((m) => ({ default: m.FilesPage })));
const SchedulePage = lazy(() => import('@/routes/schedule').then((m) => ({ default: m.SchedulePage })));
const ExportPage = lazy(() => import('@/routes/export-data').then((m) => ({ default: m.ExportPage })));
const PluginsPage = lazy(() => import('@/routes/plugins').then((m) => ({ default: m.PluginsPage })));
const PluginSettingsPage = lazy(() => import('@/routes/plugin-settings').then((m) => ({ default: m.PluginSettingsPage })));

import { useAuthStore } from '@/stores/auth';
import { PluginUIProvider } from '@/components/plugins/PluginUIRegistry';

/** #1145: 懒加载路由的轻量占位（无文案 — 首屏不依赖 i18n 初始化时序）。 */
function RouteFallback() {
  return (
    <div data-testid="route-loading" className="flex h-screen w-full items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
    </div>
  );
}

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
          <Suspense fallback={<RouteFallback />}>
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
          <Route
            path="/app/admin/metrics"
            element={
              <RequireAuth>
                <RequireRole role="admin">
                  <AdminMetricsPage />
                </RequireRole>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
          </Suspense>
        </PluginUIProvider>
      </ErrorBoundary>
    </>
  );
}
