import { ApiCore } from './core.js';
import type { AgentState, ApprovalRequest, AuditLogEntry, BrainStats, ChatSession, IngestionJob, MemoryHealthResponse, TimelineEvent } from '../../types';

export class BrainApi extends ApiCore {
  /* ────────────────────────── approvals / audit (Brain 2.0) ────────────────────────── */

  async listPendingApprovals(filters?: { targetType?: string }): Promise<{ requests: ApprovalRequest[] }> {
    const qs = filters?.targetType ? `?targetType=${encodeURIComponent(filters.targetType)}` : '';
    return this.fetch(`/api/v1/approvals/pending${qs}`);
  }

  async confirmApproval(id: string): Promise<ApprovalRequest> {
    return this.fetch(`/api/v1/approvals/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
  }

  async rejectApproval(id: string, reason: string): Promise<ApprovalRequest> {
    return this.fetch(`/api/v1/approvals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async listAuditLogs(filters?: { targetType?: string; targetId?: string; actor?: string }): Promise<{ logs: AuditLogEntry[] }> {
    const params = new URLSearchParams();
    if (filters?.targetType) params.set('targetType', filters.targetType);
    if (filters?.targetId) params.set('targetId', filters.targetId);
    if (filters?.actor) params.set('actor', filters.actor);
    const qs = params.toString();
    return this.fetch(`/api/v1/audit${qs ? `?${qs}` : ''}`);
  }

  /* ────────────────────────── ingestion jobs (Brain 2.0) ────────────────────────── */

  async listIngestionJobs(patientHash?: string, filters?: { status?: IngestionJob['status'] }): Promise<{ jobs: IngestionJob[] }> {
    const params = new URLSearchParams();
    if (patientHash) params.set('patient_hash', patientHash);
    if (filters?.status) params.set('status', filters.status);
    const qs = params.toString();
    return this.fetch(`/api/v1/ingestion/jobs${qs ? `?${qs}` : ''}`);
  }

  async getIngestionJobStatus(jobId: string): Promise<IngestionJob> {
    return this.fetch(`/api/v1/ingestion/jobs/${encodeURIComponent(jobId)}`);
  }

  /* ────────────────────────── brain overview (Brain 2.0) ────────────────────────── */

  async getMemoryHealth(): Promise<MemoryHealthResponse> {
    return this.fetch<MemoryHealthResponse>('/api/v1/memory/health');
  }

  async getBrainStats(): Promise<BrainStats> {
    return this.fetch('/api/v1/brain/stats');
  }

  /** #200: manually add a memory — lands in the pending review queue. */
  // #298: skill capture — draft/refine/confirm from a conversation.
  async captureSkill(conversation: string, sessionId?: string): Promise<{ draft_id: string; name: string; description: string; steps: string[]; prompt: string }> {
    return this.fetch('/api/v1/skills/capture', { method: 'POST', body: JSON.stringify({ conversation, session_id: sessionId }) });
  }

  async refineSkill(draftId: string, instruction: string): Promise<{ name: string; description: string; steps: string[]; prompt: string }> {
    return this.fetch(`/api/v1/skills/capture/${draftId}/refine`, { method: 'POST', body: JSON.stringify({ instruction }) });
  }

  async confirmSkill(draftId: string): Promise<{ status: string }> {
    return this.fetch(`/api/v1/skills/capture/${draftId}/confirm`, { method: 'POST', body: JSON.stringify({}) });
  }

  async proposeMemory(data: { content: string; category?: string; importance?: number; patientHash?: string }): Promise<{ status: 'pending' | 'rejected'; id: string; reason?: string }> {
    return this.fetch('/api/v1/memorization/propose', {
      method: 'POST',
      body: JSON.stringify({
        content: data.content,
        category: data.category,
        importance: data.importance,
        patient_hash: data.patientHash,
      }),
    });
  }

  async getEmbeddingStatus(): Promise<{ok: boolean; url: string; model?: string; dimensions?: number | null; device?: string; quantized?: boolean; dtype?: string | null}> {
    return this.fetch('/api/v1/settings/embedding');
  }

  async archivePatient(hash: string): Promise<{ patient_hash: string; archived_at: string }> {
    return this.fetch(`/api/v1/dicom/patients/${hash}/archive`, { method: 'POST' });
  }

  async getPatientStudies(patientHash: string): Promise<Array<{study_id: string; modality: string; body_part?: string; series_count: number; created_at: string}>> {
    return this.fetch(`/api/v1/dicom/patients/${patientHash}/studies`);
  }

  async getDicomStudy(studyId: string): Promise<{study_id: string; modality: string; body_part?: string; series_count: number; slice_count?: number; created_at: string; series?: Array<{series_uid: string; series_description?: string; slice_count: number}>}> {
    return this.fetch(`/api/v1/dicom/studies/${studyId}`);
  }

  async getUploads(patientHash?: string, limit = 100): Promise<Array<{file_id: string; name: string; mime: string; size_bytes: number; created_at: string; patient_hash?: string; dicom_status?: string; dicom_study_id?: string}>> {
    const q = patientHash ? `?patient_hash=${patientHash}&limit=${limit}` : `?limit=${limit}`;
    return this.fetch(`/api/v1/files/uploads${q}`);
  }

  async triggerQuickScan(studyId: string, patientHash?: string): Promise<{job_id: string; status: string}> {
    return this.fetch(`/api/v1/dicom/studies/${studyId}/quick-scan`, {
      method: 'POST',
      body: JSON.stringify({ patient_hash: patientHash ?? null }),
    });
  }

  /* ────────────────────────── report ────────────────────────── */

  async generateReport(data: {patient_hash: string; patient_label?: string; patient_sex?: string; patient_age_group?: string; clinical_info?: string; impression?: string; recommendation?: string}): Promise<{path: string; bytes: number; created_at: number; patient_hash: string; locale: string}> {
    return this.fetch('/api/v1/report/pdf', { method: 'POST', body: JSON.stringify(data) });
  }

  downloadReportUrl(patientHash: string): string {
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    return `${base}/api/v1/report/pdf/${patientHash}`;
  }

  /* ────────────────────────── sessions ────────────────────────── */

  async listSessions(includeArchived = false, scope?: string): Promise<{ sessions: ChatSession[] }> {
    const qs = scope ? `&scope=${encodeURIComponent(scope)}` : '';
    return this.fetch<{ sessions: ChatSession[] }>(`/api/v1/sessions?include_archived=${includeArchived}${qs}`);
  }

  async createSession(title: string, opts?: { scope?: string; patientHash?: string }): Promise<ChatSession> {
    return this.fetch<ChatSession>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, scope: opts?.scope, patient_hash: opts?.patientHash }),
    });
  }

  async closeSession(sessionId: string): Promise<{ id: string; status: string; closed_at?: string }> {
    return this.fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST' });
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.fetch<void>(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' });
  }

  /* ────────────────────────── agent state ────────────────────────── */

  async getAgentState(limit?: number): Promise<AgentState> {
    const q = limit ? `?limit=${limit}` : '';
    return this.fetch<AgentState>('/api/v1/agent/state' + q);
  }

  async getTimeline(limit = 20): Promise<{ items: TimelineEvent[] }> {
    return this.fetch<{ items: TimelineEvent[] }>(`/api/v1/agent/timeline?limit=${limit}`);
  }

  async getActivity(limit = 20): Promise<{ items: TimelineEvent[] }> {
    return this.fetch<{ items: TimelineEvent[] }>(`/api/v1/agent/activity?limit=${limit}`);
  }

}
