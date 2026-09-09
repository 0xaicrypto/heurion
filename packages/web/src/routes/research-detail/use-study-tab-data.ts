import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Assessment, Observation, RosterEntry, SafetyStatus, Screening, StudyDetail, Tab } from './types';

const toTabErrorMessage = (err: unknown) => (err instanceof ApiError ? err.messageText : String(err));

/**
 * #921: loadRoster/loadEligibility/loadSafety/loadSchedule 四个几乎同构的 loader
 * 收敛为一个 hook — 加载/错误/重试编排集中;响应形状保持 P1 类型
 * (getStudyProgress 已由 StudyProgress 收口,本页各 tab 响应同型使用)。
 */
export function useStudyTabData(studyId: string | undefined, study: StudyDetail | null, tab: Tab) {
  // #710: 各 tab 数据加载失败 — 区分“没有数据”与“加载失败”。
  const [tabError, setTabError] = useState<string | null>(null);

  // roster
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);

  // eligibility
  const [eligibility, setEligibility] = useState<{screenings: Screening[]} | null>(null);
  const [eligLoading, setEligLoading] = useState(false);

  // safety
  const [observations, setObservations] = useState<Observation[]>([]);
  const [safetyStatus, setSafetyStatus] = useState<SafetyStatus | null>(null);
  const [safetyLoading, setSafetyLoading] = useState(false);
  const [confirmingObs, setConfirmingObs] = useState<Record<string, { aeGrade?: number; isDlt?: boolean }>>({});

  // schedule
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);

  const loadRoster = useCallback(() => {
    if (!studyId) return;
    setRosterLoading(true);
    setTabError(null);
    api.getStudyRoster(studyId)
      .then(setRoster)
      .catch((err) => setTabError(toTabErrorMessage(err)))
      .finally(() => setRosterLoading(false));
  }, [studyId]);

  const loadEligibility = useCallback(() => {
    if (!studyId) return;
    setEligLoading(true);
    setTabError(null);
    api.getStudyEligibility(studyId)
      .then(setEligibility)
      .catch((err) => setTabError(toTabErrorMessage(err)))
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
      .catch((err) => setTabError(toTabErrorMessage(err)))
      .finally(() => setSafetyLoading(false));
  }, [studyId]);

  const loadSchedule = useCallback(() => {
    if (!studyId) return;
    setScheduleLoading(true);
    setTabError(null);
    api.getStudyAssessments(studyId)
      .then(setAssessments)
      .catch((err) => setTabError(toTabErrorMessage(err)))
      .finally(() => setScheduleLoading(false));
  }, [studyId]);

  useEffect(() => {
    if (!study) return;
    if (tab === 'roster') loadRoster();
    else if (tab === 'eligibility') loadEligibility();
    else if (tab === 'safety') loadSafety();
    else if (tab === 'schedule') loadSchedule();
  }, [tab, study, loadRoster, loadEligibility, loadSafety, loadSchedule]);

  const updateObsForm = (obsId: string, field: 'aeGrade' | 'isDlt', value: number | boolean) => {
    setConfirmingObs((prev) => ({
      ...prev,
      [obsId]: { ...prev[obsId], [field]: value },
    }));
  };

  return {
    tabError,
    roster, rosterLoading, loadRoster,
    eligibility, eligLoading, loadEligibility,
    observations, safetyStatus, safetyLoading, loadSafety,
    confirmingObs, updateObsForm,
    assessments, scheduleLoading, loadSchedule,
  };
}
