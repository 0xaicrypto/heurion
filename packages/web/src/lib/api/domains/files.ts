import { ApiCore, ApiError } from './core.js';



export class FilesApi extends ApiCore {
  /* ────────────────────────── files ────────────────────────── */

  /** #fix: 与服务端 multipart 上限保持一致(server app.ts fileSize=100MB)。 */
  static readonly MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

  async uploadFile(file: File, patientHash?: string): Promise<{ file_id: string; name: string; mime: string; size_bytes: number; dedup?: boolean }> {
    if (file.size > FilesApi.MAX_UPLOAD_BYTES) {
      throw new ApiError(413, JSON.stringify({ error: `上传文件超过 100MB 上限,请压缩后再试 (file exceeds the 100MB upload limit)` }), '/api/v1/files/upload');
    }
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
