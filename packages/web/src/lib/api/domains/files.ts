import { ApiCore, ApiError } from './core.js';



export class FilesApi extends ApiCore {
  /* ────────────────────────── files ────────────────────────── */

  async uploadFile(file: File, patientHash?: string): Promise<{ file_id: string; name: string; mime: string; size_bytes: number }> {
    const form = new FormData();
    form.append('file', file);
    if (patientHash) form.append('patient_hash', patientHash);
    const h = this.headers();
    h.delete('Content-Type');
    const r = await fetch('/api/v1/files/upload', { method: 'POST', headers: h, body: form });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new ApiError(r.status, text || r.statusText, '/api/v1/files/upload');
    }
    return r.json();
  }

  /** #462: extracted from labs.tsx raw fetch — auth header handled centrally. */
  async getFileContent(fileId: string): Promise<Record<string, unknown>> {
    return this.fetch<Record<string, unknown>>(`/api/v1/files/${fileId}/content`);
  }

  /** #402-followup: generated-chart library (Reactome + bioscene + charts). */
  async listGeneratedCharts(): Promise<{charts: Array<{file_id: string; url: string; title: string; tool: string; mode: string; size_bytes: number; created_at: string; pathway_id?: string}>}> {
    return this.fetch('/api/v1/files/generated');
  }

  async deleteGeneratedChart(fileId: string): Promise<{deleted: boolean}> {
    return this.fetch(`/api/v1/files/generated/${fileId}`, { method: 'DELETE' });
  }

}
