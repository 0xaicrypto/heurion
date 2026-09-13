import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Brain, CalendarClock, Cpu, Download, FileText, FlaskConical, FolderOpen, Gauge, Globe, LayoutDashboard, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Puzzle, Settings, Shield, Users, X, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/lib/api';
import { Avatar, IconButton } from '@/components/ui';
import { ThemeMenu } from '@/components/ThemeMenu';
import { StatusDot } from '@/components/ui/StatusDot';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ReactNode;
  admin?: boolean;
  /** #713: 激活态需额外匹配的 query 参数（同 pathname 的项互斥，如 /app/writing vs ?tab=library）. */
  activeQuery?: string;
  /** #713: 命中该 query 时不高亮（与 activeQuery 互斥语义）. */
  inactiveQuery?: string;
  /** §11.5 (#221): workflow grouping — 概览/对话/患者工作区/记忆与知识/工具与设置. */
  section?: 'overview' | 'conversation' | 'patients' | 'memory' | 'tools';
}

const NAV_SECTIONS: Array<{ key: NavItem['section']; labelKey: string }> = [
  { key: 'overview', labelKey: 'nav.sectionOverview' },
  { key: 'conversation', labelKey: 'nav.sectionConversation' },
  { key: 'patients', labelKey: 'nav.sectionPatients' },
  { key: 'memory', labelKey: 'nav.sectionMemory' },
  { key: 'tools', labelKey: 'nav.sectionTools' },
];

const navItems: NavItem[] = [
  { to: '/app/today', labelKey: 'nav.today', icon: <LayoutDashboard size={18} />, section: 'overview' },
  { to: '/app/chat', labelKey: 'nav.chat', icon: <MessageSquare size={18} />, section: 'conversation' },
  { to: '/app/patients', labelKey: 'nav.patients', icon: <Users size={18} />, section: 'patients' },
  { to: '/app/research', labelKey: 'nav.research', icon: <FlaskConical size={18} />, section: 'patients' },
  { to: '/app/writing', labelKey: 'nav.writing', icon: <FileText size={18} />, section: 'patients', inactiveQuery: '?tab=library' },
  { to: '/app/memory', labelKey: 'nav.memoryKnowledge', icon: <Brain size={18} />, section: 'memory' },
  { to: '/app/skills', labelKey: 'nav.skills', icon: <Cpu size={18} />, section: 'tools' },
  // #481-followup: chart library entry — writing workbench library tab.
  { to: '/app/writing?tab=library', labelKey: 'nav.chartLibrary', icon: <BarChart3 size={18} />, section: 'tools', activeQuery: '?tab=library' },
  { to: '/app/plugins', labelKey: 'nav.plugins', icon: <Puzzle size={18} />, section: 'tools' },
  { to: '/app/files', labelKey: 'nav.files', icon: <FolderOpen size={18} />, section: 'tools' },
  { to: '/app/schedule', labelKey: 'nav.schedule', icon: <CalendarClock size={18} />, section: 'tools' },
  { to: '/app/export', labelKey: 'nav.export', icon: <Download size={18} />, section: 'tools' },
  { to: '/app/settings', labelKey: 'nav.settings', icon: <Settings size={18} />, section: 'tools' },
  { to: '/app/admin/users', labelKey: 'nav.admin', icon: <Shield size={18} />, admin: true, section: 'tools' },
  { to: '/app/admin/metrics', labelKey: 'nav.adminMetrics', icon: <Gauge size={18} />, admin: true, section: 'tools' },
];

function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = i18n.language;

  return (
    <div className="relative">
      <IconButton
        aria-label={t('common.language')}
        title={t('common.language')}
        onClick={() => setOpen((v) => !v)}
      >
        <Globe size={18} />
      </IconButton>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 w-32 rounded-lg border border-border bg-surface-elevated p-1 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {[
            { code: 'zh-CN', label: '中文' },
            { code: 'en', label: 'English' },
          ].map((l) => (
            <button
              key={l.code}
              onClick={() => {
                i18n.changeLanguage(l.code);
                setOpen(false);
              }}
              className={cn(
                'w-full rounded-md px-3 py-2 text-left text-sm text-text-primary hover:bg-surface',
                current === l.code && 'bg-surface',
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { displayName, role } = useAuthStore();
  const navigate = useNavigate();

  // #460: api.logout() clears BOTH the zustand store and legacy keys.
  const logout = () => {
    api.logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Avatar name={displayName || 'User'} />
      <div className="flex-1 min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">{displayName || 'User'}</span>
        {role === 'admin' && (
          <span className="text-xs text-accent font-medium">Administrator</span>
        )}
      </div>
      <IconButton onClick={logout} aria-label={t('common.logout')} title={t('common.logout')}>
        <LogOut size={18} />
      </IconButton>
    </div>
  );
}

/** #996/#1000: 图标栏形态的用户块 — 头像 + 登出，无文字。 */
function CompactUserMenu() {
  const { t } = useTranslation();
  const { displayName, role } = useAuthStore();
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center gap-0.5 py-1">
      <span title={`${displayName || 'User'}${role === 'admin' ? ' · Administrator' : ''}`}>
        <Avatar name={displayName || 'User'} />
      </span>
      <IconButton
        onClick={() => { api.logout(); navigate('/login', { replace: true }); }}
        aria-label={t('common.logout')}
        title={t('common.logout')}
        className="!h-7 !w-7"
      >
        <LogOut size={14} />
      </IconButton>
    </div>
  );
}

function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { role } = useAuthStore();
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  // #996/#1000: 图标化 rail 模式（设计稿口径 — 图标 + 悬停 tooltip）。
  // 桌面(lg+)生效，偏好持久化；移动端抽屉不受影响。
  const [railMode, setRailMode] = useState(() => {
    try { return localStorage.getItem('nexus.nav.rail') === '1'; } catch { return false; }
  });
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const fn = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const rail = railMode && isDesktop;
  const toggleRail = () => {
    setRailMode((v) => {
      const next = !v;
      try { localStorage.setItem('nexus.nav.rail', next ? '1' : '0'); } catch { /* 私隐模式忽略 */ }
      return next;
    });
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      setSidebarWidth(Math.min(400, Math.max(180, e.clientX)));
    };
    const handleMouseUp = () => setIsResizing(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const visibleItems = navItems.filter((item) => !item.admin || role === 'admin');

  // #764-nav: 「工具与设置」组默认折叠 — 低频管理页不再占据侧栏视觉
  const [toolsOpen, setToolsOpen] = useState(false);
  const search = location.search;

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        ref={sidebarRef}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-surface transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          rail && 'items-center',
        )}
        style={{ width: rail ? 64 : `min(${sidebarWidth}px, 85vw)` }}
      >
        <header className={cn('flex h-14 shrink-0 items-center border-b border-border', rail ? 'justify-center px-0' : 'gap-2 px-4')}>
          <img src="/heurion-icon.svg" alt="" className="h-7 w-7 dark:hidden" />
          <img src="/heurion-icon-dark.svg" alt="" className="hidden h-7 w-7 dark:block" />
          {!rail && (
            <Link to="/app/today" className="flex-1 text-lg font-bold text-text-primary">
              {t('appName')}
            </Link>
          )}
          <IconButton
            className="lg:hidden"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </IconButton>
          {!rail && (
            <IconButton
              className="hidden lg:inline-flex"
              onClick={toggleRail}
              aria-label={t('nav.collapseRail', '收起为图标栏')}
              title={t('nav.collapseRail', '收起为图标栏')}
            >
              <PanelLeftClose size={18} />
            </IconButton>
          )}
        </header>

        {rail && (
          /* #996/#1000: 图标栏展开/收回开关（收起态置于图标栏顶部下方）。 */
          <button
            type="button"
            onClick={toggleRail}
            aria-label={t('nav.expandRail', '展开侧栏')}
            title={t('nav.expandRail', '展开侧栏')}
            className="mt-1.5 rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
          >
            <PanelLeftOpen size={18} />
          </button>
        )}

        <nav aria-label="Main navigation" className={cn('flex-1 overflow-y-auto py-3', rail ? 'w-full px-1.5' : 'px-3')}>
          {/* §11.5 (#221): workflow-grouped navigation */}
          {NAV_SECTIONS.map((section) => {
            const items = visibleItems.filter((i) => i.section === section.key);
            if (items.length === 0) return null;

            // #996/#1000: 图标栏形态 — 仅图标 + title tooltip，组间加分隔。
            if (rail) {
              return (
                <div key={section.key} className="mb-2 border-b border-border/60 pb-2 last:border-none">
                  {items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={onClose}
                      title={t(item.labelKey)}
                      aria-label={t(item.labelKey)}
                      className={({ isActive }) =>
                        cn(
                          'relative mx-auto flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                          isActive && !item.inactiveQuery && (!item.activeQuery || search.includes(item.activeQuery))
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {item.icon}
                          {isActive && !item.inactiveQuery && (!item.activeQuery || search.includes(item.activeQuery)) && <StatusDot tone="active" className="absolute right-1 top-1 !h-1.5 !w-1.5" />}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              );
            }

            // #764-nav: 工具与设置组可折叠(当前路由在该组内时自动展开)
            const isTools = section.key === 'tools';
            const toolsActive = items.some((i) => search.includes(new URL(i.to, 'http://x').search));
            const collapsed = isTools && !toolsOpen && !toolsActive;
            return (
              <div key={section.key} className="mb-3">
                {isTools ? (
                  <button
                    onClick={() => setToolsOpen((v) => !v)}
                    aria-expanded={toolsOpen || toolsActive}
                    className="flex w-full items-center justify-between px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary hover:text-text-primary"
                  >
                    {t(section.labelKey)}
                    <ChevronDown size={12} className={cn('transition-transform', (toolsOpen || toolsActive) && 'rotate-180')} />
                  </button>
                ) : (
                  <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    {t(section.labelKey)}
                  </p>
                )}
                {!collapsed && (
                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        onClick={onClose}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                            // #713: 同 pathname 的导航项按 query 互斥高亮
                            isActive && !item.inactiveQuery && (!item.activeQuery || search.includes(item.activeQuery))
                              ? 'bg-accent/10 text-accent'
                              : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {item.icon}
                            {t(item.labelKey)}
                            {/* §11.4 (#221): the logo's lit dot marks the current page */}
                            {isActive && !item.inactiveQuery && (!item.activeQuery || search.includes(item.activeQuery)) && <StatusDot tone="active" className="ml-auto" />}
                          </>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
                )}
              </div>
            );
          })}
        </nav>

        <div className={cn('shrink-0 border-t border-border', rail ? 'flex w-full flex-col items-center gap-1 p-1.5' : 'p-2')}>
          {rail ? (
            <>
              <ThemeMenu />
              <LanguageMenu />
              <CompactUserMenu />
            </>
          ) : (
            <>
              <div className="mb-2 flex gap-1 px-1">
                <ThemeMenu />
                <LanguageMenu />
              </div>
              <UserMenu />
            </>
          )}
        </div>

        {!rail && (
          <div
            className="absolute right-0 top-0 z-10 hidden h-full cursor-col-resize transition-colors lg:block"
            style={{ width: 6, background: 'hsl(var(--border))', opacity: 0.3 }}
            onMouseDown={(e) => { e.preventDefault(); setIsResizing(true); }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.3'; }}
          />
        )}
      </aside>
    </>
  );
}

export function AppShell({ children, rail, breadcrumb }: { children: React.ReactNode; rail?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(320);
  const [isRailResizing, setIsRailResizing] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isRailResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setRailWidth(Math.min(500, Math.max(240, newWidth)));
    };
    const handleMouseUp = () => setIsRailResizing(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isRailResizing]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-4 lg:hidden">
          <IconButton onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </IconButton>
          <img src="/heurion-icon.png" alt="" className="h-6 w-6 rounded-md" />
          <span className="font-semibold text-text-primary">{t('appName')}</span>
        </header>

        {breadcrumb && (
          <nav className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-sm text-text-secondary lg:px-6">
            {breadcrumb}
          </nav>
        )}

        <div className="flex flex-1 overflow-hidden">
          <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
          {rail && (
            <div className="hidden md:flex">
              <div
                className="hidden shrink-0 cursor-col-resize transition-colors z-10 lg:block"
                style={{ width: 6, background: 'hsl(var(--border))', opacity: 0.3 }}
                onMouseDown={(e) => { e.preventDefault(); setIsRailResizing(true); }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.3'; }}
              />
              <aside className="border-l border-border bg-surface" style={{ width: railWidth }}>{rail}</aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
