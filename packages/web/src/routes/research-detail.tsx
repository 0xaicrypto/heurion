import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarDays, Check, FlaskConical, Plus, Upload, X, FileText, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Patient } from '@/lib/types';

interface StudyDetail {
  study_id: string;
  display_name: string;
  status: string;
  short_code?: string;
  created_at: string;
  updated_at?: string;
  description?: string;
}

interface RosterEntry {
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  chief_complaint?: string;
  status: string;
  arm?: string;
  enrolled_at: string;
}

interface Screening {
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  status: string;
  criteria_results?: Array<{criterion: string; passed: boolean}>;
}

interface Observation {
  observation_id: string;
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  category: string;
  ae_grade?: number;
  is_dlt?: boolean;
  confirmed?: boolean;
  created_at: string;
}

interface Assessment {
  visit_id: string;
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  scheduled_at: string;
  status: string;
  completed_at?: string;
  // #11: recent check data (labs/imaging/notes) at the visit point.
  recent_entries?: Array<{type: string; title: string; date: string; content: string; status?: string}>;
}

interface SafetyStatus {
  triggered_rules: Array<{rule: string; description: string}>;
}

/* #919: getStudyProgress 响应形状 — 与 lib/api/domains/research.ts 的内联返回类型对齐（该处未导出命名类型）。 */
interface StudyProgress {
  study_id: string;
  study_name: string;
  enrollment: { total: number; by_arm: Record<string, number> };
  rules: { total: number; confirmed: number; pending: number; rejected: number };
  visits: { total: number; completed: number; by_visit: Record<string, { total: number; completed: number }> };
  safety: { dlt_count: number; unconfirmed: number };
  screenings: { eligible: number; ineligible: number; pending: number };
}

interface Enrollment {
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  chief_complaint?: string;
  status: string;
  arm?: string;
  enrolled_at: string;
}

type Tab = 'overview' | 'roster' | 'eligibility' | 'schedule' | 'safety' | 'protocol';

// #918: tab 文案入 i18n — labelKey 在渲染时经 t() 解析。
const TABS: { key: Tab; labelKey: string }[] = [
  { key: 'overview', labelKey: 'research.tabOverview' },
  { key: 'roster', labelKey: 'research.tabRoster' },
  { key: 'eligibility', labelKey: 'research.tabEligibility' },
  { key: 'schedule', labelKey: 'research.tabSchedule' },
  { key: 'safety', labelKey: 'research.tabSafety' },
  { key: 'protocol', labelKey: 'research.tabProtocol' },
];

export function ResearchDetailPage() {
  const { t } = useTranslation();
  const { studyId } = useParams<{ studyId: string }>();
  const navigate = useNavigate();
  const [study, setStudy] = useState<StudyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    // #719: tab 状态用 URL query 持久化 — 刷新/深链不丢当前 tab。
    const p = new URLSearchParams(window.location.search).get('tab');
    return (p === 'roster' || p === 'eligibility' || p === 'schedule' || p === 'safety' || p === 'protocol') ? p as Tab : 'overview';
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (tab === 'overview') params.delete('tab');
    else params.set('tab', tab);
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [tab]);

  // overview
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);

  // roster
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);

  // eligibility
  const [eligibility, setEligibility] = useState<{screenings: Screening[]} | null>(null);
  const [eligLoading, setEligLoading] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  // safety
  const [observations, setObservations] = useState<Observation[]>([]);
  const [safetyStatus, setSafetyStatus] = useState<SafetyStatus | null>(null);
  const [safetyLoading, setSafetyLoading] = useState(false);
  const [confirmingObs, setConfirmingObs] = useState<Record<string, { aeGrade?: number; isDlt?: boolean }>>({});
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());

  // schedule
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  // unenroll
  const [unenrollingHash, setUnenrollingHash] = useState<string | null>(null);

  // #710: 各 tab 数据加载失败 — 区分"没有数据"与"加载失败"。
  const [tabError, setTabError] = useState<string | null>(null);

  // enroll dialog
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollQuery, setEnrollQuery] = useState('');
  const [paperCreating, setPaperCreating] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [enrollingHash, setEnrollingHash] = useState<string | null>(null);

  useEffect(() => {
    if (!studyId) return;
    setLoading(true);
    setError(null);
    api.getStudy(studyId)
      .then(setStudy)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [studyId]);

  useEffect(() => {
    if (!studyId || !study) return;
    api.getStudyEnrollments(studyId)
      .then(setEnrollments)
      .catch(() => {});
  }, [studyId, study]);

  const loadRoster = useCallback(() => {
    if (!studyId) return;
    setRosterLoading(true);
    setTabError(null);
    api.getStudyRoster(studyId)
      .then(setRoster)
      .catch((err) => setTabError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setRosterLoading(false));
  }, [studyId]);

  const loadEligibility = useCallback(() => {
    if (!studyId) return;
    setEligLoading(true);
    setTabError(null);
    api.getStudyEligibility(studyId)
      .then(setEligibility)
      .catch((err) => setTabError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setEligLoading(false));
  }, [studyId]);

  const loadSafety = useCallback(() => {
    if (!studyId) return;
    setSafetyLoading(true);
    setTabError(null);
    Promise.all([
      api.getStudyObservations(studyId),
      api.getSafetyStatus(studyId),
    ])
      .then(([obs, status]) => {
        setObservations(obs);
        setSafetyStatus(status);
        const init: Record<string, { aeGrade?: number; isDlt?: boolean }> = {};
        obs.forEach((o) => {
          if (!o.confirmed) {
            init[o.observation_id] = { aeGrade: o.ae_grade, isDlt: o.is_dlt };
          }
        });
        setConfirmingObs(init);
      })
      .catch((err) => setTabError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setSafetyLoading(false));
  }, [studyId]);

  const loadSchedule = useCallback(() => {
    if (!studyId) return;
    setScheduleLoading(true);
    setTabError(null);
    api.getStudyAssessments(studyId)
      .then(setAssessments)
      .catch((err) => setTabError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setScheduleLoading(false));
  }, [studyId]);

  useEffect(() => {
    if (!study) return;
    if (tab === 'roster') loadRoster();
    else if (tab === 'eligibility') loadEligibility();
    else if (tab === 'safety') loadSafety();
    else if (tab === 'schedule') loadSchedule();
  }, [tab, study, loadRoster, loadEligibility, loadSafety, loadSchedule]);

  const createPaper = async () => {
    if (!studyId) return;
    setPaperCreating(true);
    setError(null);
    try {
      const paper = await api.createPaperFromStudy(studyId);
      navigate(`/app/writing/${paper.doc_id}`);
    } catch (err) {
      // #710: 写论文失败此前静默吞掉 — 主流程最后一环失败必须可见。
      setPaperCreating(false);
      setError(err instanceof ApiError ? t('research.paperFailedDetail', '写论文失败：{{msg}}', { msg: err.messageText }) : t('research.paperFailed', '写论文失败，请稍后重试'));
    }
  };

  const openEnroll = async () => {
    if (!studyId) return;
    setShowEnroll(true);
    setPatientsLoading(true);
    try {
      const list = await api.listPatients();
      setPatients(list);
    } catch {
      setPatients([]);
    } finally {
      setPatientsLoading(false);
    }
  };

  const handleEnroll = async (patientHash: string, arm?: string) => {
    if (!studyId) return;
    setEnrollingHash(patientHash);
    try {
      await api.enrollPatient(studyId, patientHash, arm);
      setShowEnroll(false);
      loadRoster();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setEnrollingHash(null);
    }
  };

  const handleRescan = async () => {
    if (!studyId) return;
    setRescanning(true);
    setError(null);
    try {
      // 服务端 rescan 为同步执行(创建 pending screenings),完成后直接刷新。
      await api.rescanEligibility(studyId);
      loadEligibility();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRescanning(false);
    }
  };

  const handleUnenroll = async (patientHash: string) => {
    if (!studyId) return;
    // #710: 破坏性操作 — 科研入组记录删除需二次确认。
    if (!window.confirm(t('research.unenrollConfirm', '确定将该患者移出本研究的入组名单吗？此操作不可撤销。'))) return;
    setUnenrollingHash(patientHash);
    try {
      await api.unenrollPatient(studyId, patientHash);
      loadRoster();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setUnenrollingHash(null);
    }
  };

  const handleConfirmObservation = async (obsId: string) => {
    if (!studyId) return;
    const vals = confirmingObs[obsId];
    const next = new Set(confirmingIds);
    next.add(obsId);
    setConfirmingIds(next);
    try {
      await api.confirmObservation(studyId, obsId, vals?.aeGrade, vals?.isDlt);
      loadSafety();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      const after = new Set(confirmingIds);
      after.delete(obsId);
      setConfirmingIds(after);
    }
  };

  const updateObsForm = (obsId: string, field: 'aeGrade' | 'isDlt', value: number | boolean) => {
    setConfirmingObs((prev) => ({
      ...prev,
      [obsId]: { ...prev[obsId], [field]: value },
    }));
  };

  const handleCompleteAssessment = async (visitId: string) => {
    if (!studyId) return;
    const next = new Set(completingIds);
    next.add(visitId);
    setCompletingIds(next);
    try {
      await api.completeAssessment(studyId, visitId);
      loadSchedule();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      const after = new Set(completingIds);
      after.delete(visitId);
      setCompletingIds(after);
    }
  };

  // TODO(#922): 本映射已收敛到 lib/status-variant(research.tsx/medical-records.tsx/
  // knowledge.tsx 已换用)— 本页与该实现 key 完全一致,留待下一 wave 换 import
  // (本 wave 跳过 research-detail.tsx,避免与并行改动冲突)。
  const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'error' => {
    switch (s.toLowerCase()) {
      case 'completed': return 'success';
      case 'in_progress':
      case 'running': return 'warning';
      case 'failed':
      case 'error': return 'error';
      default: return 'default';
    }
  };

  const aeGradeColor = (grade?: number) => {
    if (!grade) return 'text-text-secondary';
    return grade >= 3 ? 'text-error' : 'text-warning';
  };

  if (loading) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6 gap-3">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="p-6 space-y-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (error && !study) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
              <ArrowLeft size={16} className="mr-1" /> {t('common.back', '返回')}
            </Button>
          </div>
          <div className="p-6">
            <Alert variant="error">{error}</Alert>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!study) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
              <ArrowLeft size={16} className="mr-1" /> {t('common.back', '返回')}
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="text-text-tertiary">{t('research.studyNotFound', '未找到该研究')}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/app/research')}>
            <ArrowLeft size={16} />
          </Button>
          <h1 className="font-semibold text-text-primary">{study.display_name}</h1>
          <Badge variant={statusVariant(study.status)}>{study.status}</Badge>
          {/* #383: 研究 → 论文 */}
          <Button size="sm" className="ml-auto" onClick={createPaper} isLoading={paperCreating}>
            <FileText size={14} className="mr-1" /> {t('research.writePaper', '写论文')}
          </Button>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-border px-3 sm:px-6">
          {TABS.map(({ key, labelKey }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                tab === key
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>

        <main className="flex-1 p-6">
          {error && (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          )}

          {tab === 'overview' && (
            <div className="max-w-2xl space-y-4">
              <Card className="p-6 space-y-3">
                <div>
                  <div className="text-xs text-text-tertiary">{t('research.studyId', '研究 ID')}</div>
                  <div className="font-mono text-sm text-text-secondary">{study.study_id}</div>
                </div>
                {study.short_code && (
                  <div>
                    <div className="text-xs text-text-tertiary">{t('research.shortCode', '短编号')}</div>
                    <div className="text-sm text-text-primary">{study.short_code}</div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-text-tertiary">{t('research.created', '创建时间')}</div>
                  <div className="text-sm text-text-primary">{new Date(study.created_at).toLocaleDateString()}</div>
                </div>
                {study.updated_at && (
                  <div>
                    <div className="text-xs text-text-tertiary">{t('research.updated', '更新时间')}</div>
                    <div className="text-sm text-text-primary">{new Date(study.updated_at).toLocaleDateString()}</div>
                  </div>
                )}
                {study.description && (
                  <div>
                    <div className="text-xs text-text-tertiary">{t('research.description', '描述')}</div>
                    <div className="text-sm text-text-primary">{study.description}</div>
                  </div>
                )}
              </Card>

              <Card className="p-6">
                <h3 className="mb-3 text-sm font-semibold text-text-secondary">{t('research.recentActivity', '近期动态')}</h3>
                {enrollments.length === 0 ? (
                  <p className="text-sm text-text-tertiary">{t('research.noEnrollments', '暂无入组记录')}</p>
                ) : (
                  <div className="space-y-2">
                    {enrollments.slice(0, 10).map((e, i) => (
                      <div key={`${e.patient_hash}-${i}`} className="flex items-center justify-between text-sm">
                        <span className="text-text-secondary">
                          {e.name || e.initials || e.patient_hash.slice(0, 12)}
                          {e.age_value != null || e.sex ? (
                            <span className="ml-2 text-xs text-text-tertiary">
                              {e.age_value != null ? `${e.age_value}y` : ''}
                              {e.age_value != null && e.sex ? ' / ' : ''}
                              {e.sex || ''}
                            </span>
                          ) : null}
                        </span>
                        <Badge variant={e.status === 'active' ? 'success' : 'default'}>{e.status}</Badge>
                        <span className="text-text-tertiary">{new Date(e.enrolled_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}

          {tabError && (
            <div className="max-w-3xl">
              <Alert variant="error">
                <div className="flex items-center justify-between gap-2">
                  <span>{tabError}</span>
                  <Button size="sm" variant="ghost" onClick={() => {
                    if (tab === 'roster') loadRoster();
                    else if (tab === 'eligibility') loadEligibility();
                    else if (tab === 'safety') loadSafety();
                    else if (tab === 'schedule') loadSchedule();
                  }}>{t('common.retry', '重试')}</Button>
                </div>
              </Alert>
            </div>
          )}

          {tab === 'roster' && (
            <div className="max-w-3xl space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-secondary">{t('research.tabRoster', '入组名单')}</h2>
                <Button size="sm" onClick={openEnroll}>
                  <Plus size={14} className="mr-1" /> {t('research.enrollPatient', '入组患者')}
                </Button>
              </div>
              {rosterLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full rounded-xl" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ) : roster.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
                  <FlaskConical size={36} className="mb-3 text-text-tertiary" />
                  <p className="text-text-tertiary">{t('research.noPatientsEnrolled', '暂无入组患者')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface">
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.status', '状态')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.arm', '分组')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.enrolledAt', '入组时间')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {roster.map((r) => (
                        // #724: 行点击跳回患者详情(科研↔患者双向桥)。
                        <tr
                          key={r.patient_hash}
                          onClick={() => navigate(`/app/patients/${r.patient_hash}`)}
                          className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-elevated"
                        >
                          <td className="px-4 py-2 text-text-primary">
                            <span className="underline decoration-dotted underline-offset-2">{r.name || r.initials || '—'}</span>
                          </td>
                          <td className="px-4 py-2 font-mono text-text-secondary">
                            {r.patient_hash.slice(0, 16)}...
                          </td>
                          <td className="px-4 py-2 text-text-secondary">
                            {r.age_value != null ? `${r.age_value}y` : '—'}
                            {r.age_value != null && r.sex ? ' / ' : ''}
                            {r.sex || ''}
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant={r.status === 'active' ? 'success' : 'default'}>{r.status}</Badge>
                          </td>
                          <td className="px-4 py-2 text-text-secondary">{r.arm || '—'}</td>
                          <td className="px-4 py-2 text-text-tertiary">{new Date(r.enrolled_at).toLocaleDateString()}</td>
                          <td className="px-4 py-2">
                            <button
                              className="rounded p-1 text-text-tertiary hover:bg-error/10 hover:text-error transition-colors"
                              onClick={(e) => { e.stopPropagation(); handleUnenroll(r.patient_hash); }}
                              disabled={unenrollingHash === r.patient_hash}
                              title={t('research.unenrollTitle', '移出研究')}
                            >
                              <X size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'eligibility' && (
            <div className="max-w-3xl space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-secondary">{t('research.eligibilityScreenings', '资格筛查记录')}</h2>
                <Button size="sm" onClick={handleRescan} isLoading={rescanning} disabled={rescanning}>
                  {t('research.rescan', '重新筛查')}
                </Button>
              </div>
              {eligLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ) : !eligibility || eligibility.screenings.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
                  <FlaskConical size={36} className="mb-3 text-text-tertiary" />
                  <p className="text-text-tertiary">{t('research.noEligibilityData', '暂无筛查数据')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                    {eligibility.screenings.map((s, i) => (
                      <Card key={`${s.patient_hash}-${i}`} className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          {/* #724: 点击跳回患者详情。 */}
                          <button onClick={() => navigate(`/app/patients/${s.patient_hash}`)} className="text-left">
                            <p className="text-sm font-medium text-text-primary hover:underline">{s.name || s.initials || s.patient_hash.slice(0, 12)}</p>
                            <p className="text-xs text-text-tertiary">
                              ID: {s.patient_hash.slice(0, 16)}...
                              {s.age_value != null || s.sex ? ' · ' : ''}
                              {s.age_value != null ? `${s.age_value}y` : ''}
                              {s.age_value != null && s.sex ? ' / ' : ''}
                              {s.sex || ''}
                            </p>
                          </button>
                          <div className="flex items-center gap-2">
                            <Badge variant={s.status === 'eligible' ? 'success' : s.status === 'ineligible' ? 'error' : 'default'}>
                              {s.status}
                            </Badge>
                            {/* #719: eligible 患者直达入组(预选),不必回 Roster 滚动找人。 */}
                            {s.status === 'eligible' && (
                              <Button size="sm" variant="secondary" onClick={() => handleEnroll(s.patient_hash)}>
                                {t('research.enroll', '入组')}
                              </Button>
                            )}
                          </div>
                        </div>
                      {s.criteria_results && s.criteria_results.length > 0 && (
                        <div className="space-y-1 mt-2">
                          {s.criteria_results.map((c, j) => (
                            <div key={j} className="flex items-center gap-2 text-xs">
                              <span className={c.passed ? 'text-success' : 'text-error'}>
                                {c.passed ? '\u2713' : '\u2717'}
                              </span>
                              <span className="text-text-secondary">{c.criterion}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'schedule' && (
            <div className="max-w-3xl space-y-4">
              <h2 className="text-sm font-semibold text-text-secondary">{t('research.scheduledAssessments', '随访评估')}</h2>
              {scheduleLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full rounded-xl" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ) : assessments.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
                  <CalendarDays size={36} className="mb-3 text-text-tertiary" />
                  <p className="text-text-tertiary">{t('research.noScheduledAssessments', '暂无随访计划')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface">
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.date', '日期')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.status', '状态')}</th>
                        <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {assessments.map((a) => (
                        <tr key={a.visit_id} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 text-text-primary">{new Date(a.scheduled_at).toLocaleString()}</td>
                          <td className="px-4 py-2 text-text-primary">{a.name || a.initials || '—'}</td>
                          <td className="px-4 py-2 font-mono text-text-secondary">{a.patient_hash.slice(0, 16)}...</td>
                          <td className="px-4 py-2 text-text-secondary">
                            {a.age_value != null ? `${a.age_value}y` : '—'}
                            {a.age_value != null && a.sex ? ' / ' : ''}
                            {a.sex || ''}
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant={a.status === 'completed' ? 'success' : a.status === 'pending' ? 'warning' : 'default'}>
                              {a.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2">
                            {a.recent_entries && a.recent_entries.length > 0 ? (
                              <details className="max-w-[260px]">
                                <summary className="cursor-pointer text-xs text-accent">{t('research.visitEntries', '检查数据')} ({a.recent_entries.length})</summary>
                                <ul className="mt-1 space-y-1">
                                  {a.recent_entries.map((e, i) => (
                                    <li key={i} className="text-[11px] text-text-secondary">
                                      <span className="rounded border border-border px-1 text-[9px] text-text-tertiary">{e.type}</span>{' '}
                                      <span className="font-medium">{e.title}</span>
                                      <span className="text-text-tertiary"> · {e.date ? new Date(e.date).toLocaleDateString() : ''}</span>
                                      <div className="line-clamp-2 text-text-tertiary">{e.content}</div>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : (
                              <span className="text-xs text-text-tertiary">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            {a.status !== 'completed' && (
                              <Button
                                size="sm"
                                onClick={() => handleCompleteAssessment(a.visit_id)}
                                isLoading={completingIds.has(a.visit_id)}
                                disabled={completingIds.has(a.visit_id)}
                              >
                                {t('research.complete', '完成')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === 'safety' && (
            <div className="max-w-3xl space-y-4">
              <h2 className="text-sm font-semibold text-text-secondary">{t('research.tabSafety', '安全性')}</h2>

              {safetyLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ) : (
                <>
                  {safetyStatus && safetyStatus.triggered_rules.length > 0 && (
                    <Card className="p-4">
                      <h3 className="mb-2 text-sm font-medium text-text-primary">{t('research.stopRulesTriggered', '已触发停止规则')}</h3>
                      <div className="space-y-2">
                        {safetyStatus.triggered_rules.map((r, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            <Badge variant="error">{r.rule}</Badge>
                            <span className="text-text-secondary">{r.description}</span>
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}

                  {observations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-xl border border-border py-12 text-center">
                      <FlaskConical size={36} className="mb-3 text-text-tertiary" />
                      <p className="text-text-tertiary">{t('research.noObservations', '暂无安全性记录')}</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-surface">
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patient', '患者')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.patientId', '患者 ID')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.basicInfo', '基本信息')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.category', '类别')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.aeGrade', 'AE 等级')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.dltHeader', 'DLT')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary">{t('research.date', '日期')}</th>
                              <th className="px-4 py-2 text-left font-medium text-text-secondary"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {observations.map((o) => (
                              <tr key={o.observation_id} className="border-b border-border last:border-0">
                                <td className="px-4 py-2 text-text-primary">{o.name || o.initials || '—'}</td>
                                <td className="px-4 py-2 font-mono text-text-secondary">{o.patient_hash.slice(0, 16)}...</td>
                                <td className="px-4 py-2 text-text-secondary">
                                  {o.age_value != null ? `${o.age_value}y` : '—'}
                                  {o.age_value != null && o.sex ? ' / ' : ''}
                                  {o.sex || ''}
                                </td>
                                <td className="px-4 py-2 text-text-secondary">{o.category}</td>
                              <td className={cn('px-4 py-2 font-medium', aeGradeColor(o.ae_grade))}>
                                {o.confirmed ? (
                                  o.ae_grade ?? '—'
                                ) : (
                                  <select
                                    className="rounded border border-border bg-surface px-2 py-1 text-sm"
                                    value={confirmingObs[o.observation_id]?.aeGrade ?? ''}
                                    onChange={(e) => updateObsForm(o.observation_id, 'aeGrade', e.target.value ? Number(e.target.value) : undefined as unknown as number)}
                                  >
                                    <option value="">—</option>
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    <option value="3">3</option>
                                    <option value="4">4</option>
                                    <option value="5">5</option>
                                  </select>
                                )}
                              </td>
                              <td className="px-4 py-2">
                                {o.confirmed ? (
                                  o.is_dlt ? <Badge variant="error">DLT</Badge> : '—'
                                ) : (
                                  <input
                                    type="checkbox"
                                    checked={!!confirmingObs[o.observation_id]?.isDlt}
                                    onChange={(e) => updateObsForm(o.observation_id, 'isDlt', e.target.checked)}
                                    className="h-4 w-4"
                                  />
                                )}
                              </td>
                              <td className="px-4 py-2 text-text-tertiary">{new Date(o.created_at).toLocaleDateString()}</td>
                              <td className="px-4 py-2">
                                {o.confirmed ? (
                                  <span className="inline-flex items-center gap-1 text-success text-xs">
                                    <Check size={14} /> {t('research.confirmed', '已确认')}
                                  </span>
                                ) : (
                                  <Button
                                    size="sm"
                                    onClick={() => handleConfirmObservation(o.observation_id)}
                                    isLoading={confirmingIds.has(o.observation_id)}
                                    disabled={confirmingIds.has(o.observation_id)}
                                  >
                                    {t('research.confirm', '确认')}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'overview' && studyId && (
            <div className="max-w-2xl space-y-4">
              <StudyProgressCard studyId={studyId} />
              <StudySummaryCard studyId={studyId} />
            </div>
          )}

          {tab === 'protocol' && studyId && (
            <ProtocolTab studyId={studyId} />
          )}
        </main>

        {showEnroll && (
          // TODO(#922): 待换 components/ui/Modal.tsx(本 wave 跳过 research-detail.tsx;
          // 原行为:无 backdrop 点击关闭、无 Esc、bg-black/30、max-w-md)。
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated p-6 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('research.enrollPatient', '入组患者')}</h2>
              {patientsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full rounded-xl" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              ) : patients.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-text-tertiary">{t('research.noPatientsAvailable', '没有可入组的患者')}</p>
                </div>
              ) : (
                <>
                  {/* #719: 患者多时入组弹窗需可搜索。 */}
                  <Input
                    value={enrollQuery}
                    onChange={(e) => setEnrollQuery(e.target.value)}
                    placeholder={t('research.searchPatientPlaceholder', '搜索患者（姓名/缩写/ID）…')}
                    className="mb-2"
                  />
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    {patients.filter((p) => {
                      const q = enrollQuery.trim().toLowerCase();
                      if (!q) return true;
                      return (p.name || '').toLowerCase().includes(q)
                        || (p.initials || '').toLowerCase().includes(q)
                        || p.patient_hash.toLowerCase().includes(q);
                    }).map((p) => (
                    <div
                      key={p.patient_hash}
                      className="flex items-center justify-between rounded-lg border border-border p-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {p.name || p.initials || '—'}
                        </p>
                        <p className="text-xs text-text-tertiary">
                          ID: {p.patient_hash.slice(0, 16)}...
                          {p.age_value != null || p.sex ? ' · ' : ''}
                          {p.age_value != null ? `${p.age_value}y` : ''}
                          {p.age_value != null && p.sex ? ' / ' : ''}
                          {p.sex || ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleEnroll(p.patient_hash)}
                        disabled={enrollingHash === p.patient_hash}
                        isLoading={enrollingHash === p.patient_hash}
                      >
                        {t('research.enroll', '入组')}
                      </Button>
                    </div>
                  ))}
                  </div>
                  {enrollQuery.trim() && patients.filter((p) => {
                    const q = enrollQuery.trim().toLowerCase();
                    return (p.name || '').toLowerCase().includes(q)
                      || (p.initials || '').toLowerCase().includes(q)
                      || p.patient_hash.toLowerCase().includes(q);
                  }).length === 0 && (
                    <p className="py-4 text-center text-xs text-text-tertiary">{t('research.noPatientMatch', '没有匹配的患者')}</p>
                  )}
                </>
              )}
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" onClick={() => setShowEnroll(false)}>{t('common.cancel', '取消')}</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ProtocolTab({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Array<{ id: string; category: string; rule: string; confirmed: boolean }>>([])
  const [status, setStatus] = useState({ total: 0, confirmed: 0, pending: 0 })
  const [loading, setLoading] = useState(true)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadRules = useCallback(() => {
    setLoading(true)
    api.getProtocolRules(studyId)
      .then((data) => { setRules(data.rules); setStatus(data.status) })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false))
  }, [studyId])

  useEffect(() => { loadRules() }, [loadRules])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (fileRef.current) fileRef.current.value = ''
    setUploading(true)
    setError(null)
    try {
      const res = await api.importProtocolFile(studyId, file)
      setRules(res.rules)
      setStatus(res.status)
      setLastFile(res.file_name)
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err))
    } finally {
      setUploading(false)
    }
  }

  const handleImport = async () => {
    if (!importText.trim()) return
    setImporting(true)
    setError(null)
    try {
      await api.importProtocol(studyId, importText)
      await api.extractRules(studyId, importText)
      setImportText('')
      loadRules()
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err))
    } finally {
      setImporting(false)
    }
  }

  const handleConfirm = async (ruleId: string) => {
    try {
      await api.confirmRule(studyId, ruleId)
      loadRules()
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err))
    }
  }
  const handleReject = async (ruleId: string) => {
    try {
      // #462: auth handled centrally by the api layer (was raw fetch + manual Bearer).
      await api.deleteProtocolRule(studyId, ruleId);
      loadRules()
    } catch {
      setError(t('research.rejectRuleFailed', '拒绝规则失败'))
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-xl border border-border bg-surface-elevated p-4">
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('research.importProtocol', '导入方案')}</h3>
        <textarea value={importText} onChange={e => setImportText(e.target.value)}
          placeholder={t('research.protocolPlaceholder', '在此粘贴方案文本，或在下方上传文件（.txt、.md、.csv、.pdf、.docx）')}
          className="mb-2 min-h-[120px] w-full rounded-lg border border-border bg-surface p-2 text-xs text-text-primary"
          rows={5} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleImport} isLoading={importing} disabled={!importText.trim()}>
            {t('research.importExtract', '导入并提取规则')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} isLoading={uploading} disabled={uploading}>
            <Upload size={14} className="mr-1" /> {t('research.uploadProtocolFile', '上传方案文件')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.csv,.pdf,.docx"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
        {lastFile && (
          <p className="mt-2 text-xs text-text-tertiary">{t('research.lastUploaded', '最近上传：{{name}}', { name: lastFile })}</p>
        )}
        {error && (
          <div className="mt-2">
            <Alert variant="error">{error}</Alert>
          </div>
        )}
      </div>

      {loading ? <Skeleton className="h-32 w-full rounded-xl" /> : (
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">{t('research.extractedRules', '已提取规则')}</h3>
            <span className="text-xs text-text-tertiary">{t('research.rulesProgress', '已确认 {{confirmed}}/{{total}} · 待确认 {{pending}}', { confirmed: status.confirmed, total: status.total, pending: status.pending })}</span>
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-text-tertiary">{t('research.noRulesHint', '先导入方案文本，再提取规则')}</p>
          ) : (
            <div className="space-y-2">
              {rules.map(r => (
                <div key={r.id} className={`flex items-start gap-3 rounded-lg p-2 ${r.confirmed ? 'bg-green-50/10' : 'bg-surface'}`}>
                  <Badge variant={r.category === 'inclusion' ? 'success' : r.category === 'exclusion' ? 'error' : r.category === 'safety' ? 'warning' : 'default'}>
                    {r.category}
                  </Badge>
                  <span className="flex-1 text-xs text-text-primary">{r.rule}</span>
                  {r.confirmed ? (
                    <span className="text-xs text-green-500">✓</span>
                  ) : (
                    <div className="flex gap-1">
                      <button onClick={() => handleConfirm(r.id)} className="rounded px-2 py-0.5 text-xs text-green-500 hover:bg-green-50/10">✓</button>
                      <button onClick={() => handleReject(r.id)} className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-50/10">✗</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* #12: AI research-progress summary for citations / internal reporting. */
function StudySummaryCard({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<{ facts: string[]; summary: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.getStudySummary(studyId));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="max-w-2xl p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary">{t('research.summary', 'AI 研究进展摘要')}</h3>
        <Button size="sm" onClick={generate} isLoading={loading}>
          <Sparkles size={14} className="mr-1" />
          {t('research.generateSummary', '生成摘要')}
        </Button>
      </div>
      {error && <p className="mt-3 text-xs text-error">{error}</p>}
      {summary && (
        <div className="mt-4 space-y-3">
          <p className="rounded-lg border border-border bg-surface-elevated p-3 text-sm leading-relaxed text-text-primary">
            {summary.summary}
          </p>
          <details className="rounded-lg border border-border bg-surface p-3">
            <summary className="cursor-pointer text-xs text-text-tertiary">{t('research.summaryFacts', '依据事实')}</summary>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-text-secondary">
              {summary.facts.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </details>
        </div>
      )}
    </Card>
  );
}

/* #10: structured study-progress overview (enrollment/rules/visits/safety). */
function StudyProgressCard({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  // #919: 响应按 StudyProgress 形状收口 — 不再是裸 any。
  const [data, setData] = useState<StudyProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getStudyProgress(studyId)
      .then(setData)
      .catch(err => setError(err instanceof ApiError ? err.messageText : String(err)));
  }, [studyId]);

  if (error) return <Card className="p-6"><p className="text-xs text-error">{error}</p></Card>;
  if (!data) return <Card className="p-6"><Skeleton className="h-24 w-full rounded-lg" /></Card>;

  // #919: 服务端返回部分字段缺失时不崩 — 读取处全部走默认值防护。
  const enrollment = data.enrollment ?? { total: 0, by_arm: {} as Record<string, number> };
  const rules = data.rules ?? { total: 0, confirmed: 0, pending: 0, rejected: 0 };
  const visitsAgg = data.visits ?? { total: 0, completed: 0, by_visit: {} as Record<string, { total: number; completed: number }> };
  const screenings = data.screenings ?? { eligible: 0, ineligible: 0, pending: 0 };
  const safety = data.safety ?? { dlt_count: 0, unconfirmed: 0 };
  // #919: Object.entries 的入参给 ?? {} 兜底。
  const arms = Object.entries(enrollment.by_arm ?? {});
  const visits = Object.entries(visitsAgg.by_visit ?? {});

  return (
    <Card className="p-6">
      <h3 className="mb-3 text-sm font-semibold text-text-secondary">{t('research.progress', '研究进展')}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{enrollment.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.enrolled', '入组患者')}</div>
          {arms.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[10px] text-text-tertiary">
              {arms.map(([arm, n]) => <div key={String(arm)}>{String(arm)}: {String(n)}</div>)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{rules.confirmed ?? 0}/{rules.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.rulesConfirmed', '规则已确认')}</div>
          {(rules.pending ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{rules.pending} {t('research.pending', '待确认')}</div>}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{visitsAgg.completed ?? 0}/{visitsAgg.total ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.visits', '随访完成')}</div>
          {visits.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[10px] text-text-tertiary">
              {visits.slice(0, 4).map(([v, s]) => { const st = s as {completed: number; total: number}; return <div key={String(v)}>{String(v)}: {st.completed ?? 0}/{st.total ?? 0}</div>; })}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{screenings.eligible ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.eligible', '符合入组')}</div>
          {(screenings.pending ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{screenings.pending} {t('research.pending', '待确认')}</div>}
        </div>
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="text-2xl font-semibold text-text-primary">{safety.dlt_count ?? 0}</div>
          <div className="text-xs text-text-tertiary">{t('research.dlt', '确认 DLT')}</div>
          {(safety.unconfirmed ?? 0) > 0 && <div className="mt-1 text-[10px] text-warning">{safety.unconfirmed} {t('research.unconfirmed', '未确认')}</div>}
        </div>
      </div>
    </Card>
  );
}
