import { KnowledgeApi } from './knowledge.js';


export class CalendarApi extends KnowledgeApi {
  /* ────────────────────────── calendar ────────────────────────── */

  getCalendarExportUrl(): string {
    return `/api/v1/calendar/export.ics`;
  }

  getCalendarSubscribeUrl(): string {
    return `/api/v1/calendar/subscribe-url`;
  }

  /* ────────────────────────── feedback ────────────────────────── */

  async getDocReferences(docId: string): Promise<{references: Array<{reference_id: string; kind: string; label: string; content: string; source_patient_hash: string; created_at: string}>}> {
    return this.fetch(`/api/v1/docs/${docId}/references`);
  }

  async addDocReference(docId: string, data: {kind: string; content: string; source_patient_hash?: string; label?: string}): Promise<{reference_id: string}> {
    return this.fetch(`/api/v1/docs/${docId}/references`, { method: 'POST', body: JSON.stringify(data) });
  }

}
