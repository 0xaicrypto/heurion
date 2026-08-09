import { AdminApi } from './admin.js';


import { ApiError } from './core.js';

export class ResearchApi extends AdminApi {
  /* ────────────────────────── research ────────────────────────── */

  async listStudies(): Promise<Array<{study_id: string; display_name: string; status: string; short_code?: string; study_type?: 'clinical' | 'basic'; created_at: string}>> {
    return this.fetch('/api/v1/research/studies');
  }

  async createStudy(data: {display_name: string; short_code: string; study_type?: 'clinical' | 'basic'}): Promise<{study_id: string; display_name: string; status: string}> {
    return this.fetch('/api/v1/research/studies', { method: 'POST', body: JSON.stringify(data) });
  }

  async getStudy(studyId: string): Promise<{study_id: string; display_name: string; status: string; short_code?: string; created_at: string; updated_at?: string; description?: string}> {
    return this.fetch(`/api/v1/research/studies/${studyId}`);
  }

  /* ────────────────────────── research detail ────────────────────────── */

  async getStudyRoster(studyId: string): Promise<Array<{
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
  }>> {
    return this.fetch(`/api/v1/research/studies/${studyId}/roster`);
  }

  async getStudyEligibility(studyId: string): Promise<{screenings: Array<{
    patient_hash: string;
    patient_id: string;
    name?: string;
    initials?: string;
    age_value?: number;
    sex?: string;
    status: string;
    criteria_results?: Array<{criterion: string; passed: boolean}>;
  }>}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/eligibility`);
  }

  async getStudyObservations(studyId: string): Promise<Array<{
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
  }>> {
    return this.fetch(`/api/v1/research/studies/${studyId}/observations`);
  }

  async getStudyEnrollments(studyId: string): Promise<Array<{
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
  }>> {
    return this.fetch(`/api/v1/research/studies/${studyId}/enrollments`);
  }

  async enrollPatient(studyId: string, patientHash: string, arm?: string): Promise<{
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
  }> {
    return this.fetch(`/api/v1/research/studies/${studyId}/enrollments`, { method: 'POST', body: JSON.stringify({ patient_hash: patientHash, arm }) });
  }

  async getSafetyStatus(studyId: string): Promise<{triggered_rules: Array<{rule: string; description: string}>}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/safety/stop-rule-status`);
  }

  async rescanEligibility(studyId: string): Promise<{job_id: string; status: string}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/eligibility/rescan`, { method: 'POST' });
  }

  async unenrollPatient(studyId: string, patientHash: string): Promise<{ok: boolean}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/enrollments/${patientHash}`, { method: 'DELETE' });
  }

  async confirmObservation(studyId: string, obsId: string, aeGrade?: number, isDlt?: boolean): Promise<{ok: boolean}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/observations/${obsId}/confirm`, { method: 'POST', body: JSON.stringify({ ae_grade: aeGrade, is_dlt: isDlt }) });
  }

  async getStudyAssessments(studyId: string): Promise<Array<{
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
  }>> {
    return this.fetch(`/api/v1/research/studies/${studyId}/assessments`);
  }

  async completeAssessment(studyId: string, visitId: string, notes?: string): Promise<{ok: boolean}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/assessments/${visitId}/complete`, { method: 'POST', body: JSON.stringify({ notes }) });
  }

  async importProtocol(studyId: string, text: string): Promise<{study_id: string; protocol: string}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/import-protocol`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  async extractRules(studyId: string, text: string): Promise<{study_id: string; rules: Array<{category: string; rule: string}>; status: {total: number; confirmed: number}}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/extract-rules`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  async confirmRule(studyId: string, ruleId: string): Promise<{rule: {id: string; confirmed: boolean}}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/protocol-rules/${ruleId}/confirm`, { method: 'POST' });
  }

  async getProtocolRules(studyId: string): Promise<{rules: Array<{id: string; category: string; rule: string; confirmed: boolean}>; status: {total: number; confirmed: number; pending: number; rejected: number}}> {
    return this.fetch(`/api/v1/research/studies/${studyId}/protocol-rules`);
  }

  async importProtocolFile(studyId: string, file: File): Promise<{
    study_id: string;
    file_id: string;
    file_name: string;
    text_length: number;
    rules: Array<{id: string; category: string; rule: string; confirmed: boolean}>;
    status: {total: number; confirmed: number; pending: number; rejected: number};
  }> {
    const form = new FormData();
    form.append('file', file);
    const h = this.headers();
    h.delete('Content-Type');
    const path = `/api/v1/research/studies/${encodeURIComponent(studyId)}/protocol-file`;
    const r = await fetch(path, { method: 'POST', headers: h, body: form });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new ApiError(r.status, text || r.statusText, path);
    }
    return r.json();
  }

}
