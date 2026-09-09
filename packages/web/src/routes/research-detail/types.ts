/* #919: getStudyProgress 响应形状 — 与 lib/api/domains/research.ts 的内联返回类型对齐（该处未导出命名类型）。 */
export interface StudyProgress {
  study_id: string;
  study_name: string;
  enrollment: { total: number; by_arm: Record<string, number> };
  rules: { total: number; confirmed: number; pending: number; rejected: number };
  visits: { total: number; completed: number; by_visit: Record<string, { total: number; completed: number }> };
  safety: { dlt_count: number; unconfirmed: number };
  screenings: { eligible: number; ineligible: number; pending: number };
}

export interface StudyDetail {
  study_id: string;
  display_name: string;
  status: string;
  short_code?: string;
  created_at: string;
  updated_at?: string;
  description?: string;
}

export interface RosterEntry {
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

/** getStudyEnrollments 响应与 RosterEntry 字段逐一相同 — 保留各自 API 语义命名。 */
export type Enrollment = RosterEntry;

export interface Screening {
  patient_hash: string;
  patient_id: string;
  name?: string;
  initials?: string;
  age_value?: number;
  sex?: string;
  status: string;
  criteria_results?: Array<{criterion: string; passed: boolean}>;
}

export interface Observation {
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

export interface Assessment {
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

export interface SafetyStatus {
  triggered_rules: Array<{rule: string; description: string}>;
}

export type Tab = 'overview' | 'roster' | 'eligibility' | 'schedule' | 'safety' | 'protocol';

// #918: tab 文案入 i18n — labelKey 在渲染时经 t() 解析。
export const TABS: { key: Tab; labelKey: string }[] = [
  { key: 'overview', labelKey: 'research.tabOverview' },
  { key: 'roster', labelKey: 'research.tabRoster' },
  { key: 'eligibility', labelKey: 'research.tabEligibility' },
  { key: 'schedule', labelKey: 'research.tabSchedule' },
  { key: 'safety', labelKey: 'research.tabSafety' },
  { key: 'protocol', labelKey: 'research.tabProtocol' },
];
