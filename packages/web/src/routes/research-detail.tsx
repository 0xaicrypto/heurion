import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Badge, Button, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { statusVariant } from '@/lib/status-variant';
import { cn } from '@/lib/utils';
import type { Patient } from '@/lib/types';
import { EnrollDialog } from './research-detail/enroll-dialog';
import { EligibilityTab } from './research-detail/eligibility';
import { OverviewTab, StudyProgressCard, StudySummaryCard } from './research-detail/overview';
import { ProtocolTab } from './research-detail/protocol';
import { RosterTab } from './research-detail/roster';
import { SafetyTab } from './research-detail/safety';
import { ScheduleTab } from './research-detail/schedule';
import { useStudyTabData } from './research-detail/use-study-tab-data';
import { TABS } from './research-detail/types';
import type { Enrollment, StudyDetail, Tab } from './research-detail/types';

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

  // unenroll
  const [unenrollingHash, setUnenrollingHash] = useState<string | null>(null);

  const {
    tabError,
    roster, rosterLoading, loadRoster,
    eligibility, eligLoading, loadEligibility,
    observations, safetyStatus, safetyLoading, loadSafety, confirmingObs, updateObsForm,
    assessments, scheduleLoading, loadSchedule,
  } = useStudyTabData(studyId, study, tab);

  // eligibility rescan
  const [rescanning, setRescanning] = useState(false);

  // safety confirm
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());

  // schedule complete
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  // enroll dialog
  const [showEnroll, setShowEnroll] = useState(false);
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
            <OverviewTab study={study} enrollments={enrollments} />
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
            <RosterTab
              roster={roster}
              loading={rosterLoading}
              unenrollingHash={unenrollingHash}
              onUnenroll={handleUnenroll}
              onOpenEnroll={openEnroll}
            />
          )}

          {tab === 'eligibility' && (
            <EligibilityTab
              eligibility={eligibility}
              loading={eligLoading}
              rescanning={rescanning}
              onRescan={handleRescan}
              onEnroll={handleEnroll}
            />
          )}

          {tab === 'schedule' && (
            <ScheduleTab
              assessments={assessments}
              loading={scheduleLoading}
              completingIds={completingIds}
              onComplete={handleCompleteAssessment}
            />
          )}

          {tab === 'safety' && (
            <SafetyTab
              observations={observations}
              safetyStatus={safetyStatus}
              loading={safetyLoading}
              confirmingObs={confirmingObs}
              confirmingIds={confirmingIds}
              onConfirm={handleConfirmObservation}
              onFormChange={updateObsForm}
            />
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

        <EnrollDialog
          open={showEnroll}
          patients={patients}
          patientsLoading={patientsLoading}
          enrollingHash={enrollingHash}
          onEnroll={handleEnroll}
          onClose={() => setShowEnroll(false)}
        />
      </div>
    </AppShell>
  );
}
