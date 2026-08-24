import { ApiCore, ApiError } from './core.js';



export class FilesApi extends ApiCore {
  /* ────────────────────────── files ────────────────────────── */

  /** #fix: 与服务端 multipart 上限保持一致(server app.ts fileSize=100MB)。
   *  超过此值走分片上传(upload-chunk/upload-complete)。 */
  static readonly MAX_SINGLE_UPLOAD_BYTES = 100 * 1024 * 1024;
  /** #fix: 分片大小(与服务端 UPLOAD_CHUNK_MAX_BYTES=32MB 上限兼容)。 */
  static readonly CHUNK_SIZE = 16 * 1024 * 1024;
  /** #fix: 分片总文件体积上限(与服务端 MAX_CHUNKED_UPLOAD_BYTES 对齐)。 */
  static readonly MAX_CHUNKED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

  async uploadFile(file: File, patientHash?: string): Promise<{ file_id: string; name: string; mime: string; size_bytes: number; dedup?: boolean }> {
    if (file.size > FilesApi.MAX_CHUNKED_UPLOAD_BYTES) {
      throw new ApiError(413, JSON.stringify({ error: `上传文件超过 ${FilesApi.MAX_CHUNKED_UPLOAD_BYTES / 1024 / 1024 / 1024}GB 上限,请压缩后再试 (file exceeds the upload limit)` }), '/api/v1/files/upload');
    }
    if (file.size > FilesApi.MAX_SINGLE_UPLOAD_BYTES) {
      return this.uploadChunked(file, patientHash);
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

  /** #fix: 大文件分片上传 — 逐段 POST upload-chunk,完成后 upload-complete
   *  由服务端合并 + 去重;失败时尽力 upload-abort 清理残留分片。 */
  private async uploadChunked(file: File, patientHash?: string): Promise<{ file_id: string; name: string; mime: string; size_bytes: number; dedup?: boolean }> {
    const uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const total = Math.ceil(file.size / FilesApi.CHUNK_SIZE);
    try {
      const h = this.headers();
      h.delete('Content-Type');
      for (let i = 0; i < total; i++) {
        const start = i * FilesApi.CHUNK_SIZE;
        const chunk = file.slice(start, start + FilesApi.CHUNK_SIZE);
        const form = new FormData();
        form.append('file', chunk, file.name);
        form.append('upload_id', uploadId);
        form.append('index', String(i + 1));
        form.append('total', String(total));
        const r = await fetch('/api/v1/files/upload-chunk', { method: 'POST', headers: h, body: form });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new ApiError(r.status, text || r.statusText, '/api/v1/files/upload-chunk');
        }
      }
      const done = await this.fetch('/api/v1/files/upload-complete', {
        method: 'POST',
        body: JSON.stringify({ upload_id: uploadId, filename: file.name, total, patient_hash: patientHash ?? null, mime: file.type || 'application/octet-stream' }),
      });
      return done as { file_id: string; name: string; mime: string; size_bytes: number; dedup?: boolean };
    } catch (err) {
      try {
        await this.fetch('/api/v1/files/upload-abort', { method: 'POST', body: JSON.stringify({ upload_id: uploadId }) });
      } catch { /* best-effort cleanup */ }
      throw err;
    }
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
