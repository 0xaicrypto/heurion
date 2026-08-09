import { ApiCore, ApiError } from './core.js';
import { parseSseStream } from '../../sse';


export class WritingApi extends ApiCore {
  /* ────────────────────────── writing ────────────────────────── */

  async listDocs(): Promise<{docs: Array<{id: string; title: string; updated_at: string; ref_count: number}>}> {
    return this.fetch('/api/v1/docs');
  }

  async createDoc(title: string, studyId?: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
    return this.fetch('/api/v1/docs', { method: 'POST', body: JSON.stringify({ title, study_id: studyId }) });
  }

  async getDoc(docId: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
    return this.fetch(`/api/v1/docs/${docId}`);
  }

  // #383: research ↔ paper linkage.
  async createPaperFromStudy(studyId: string): Promise<{ doc_id: string; title: string; body: string }> {
    return this.fetch(`/api/v1/research/studies/${studyId}/paper`, { method: 'POST', body: JSON.stringify({}) });
  }

  async generateMethods(docId: string): Promise<{ methods: string }> {
    return this.fetch(`/api/v1/docs/${docId}/generate-methods`, { method: 'POST', body: JSON.stringify({}) });
  }

  async injectResults(docId: string, label: string, result: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}/inject-results`, { method: 'POST', body: JSON.stringify({ label, result }) });
  }

  async deleteDoc(docId: string): Promise<{ deleted: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}`, { method: 'DELETE' });
  }

  async updateDoc(docId: string, data: {title: string; body: string}): Promise<{id: string; title: string; body: string; updated_at: string}> {
    return this.fetch(`/api/v1/docs/${docId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async getDocSnapshots(docId: string): Promise<{snapshots: Array<{snapshot_id: string; created_at: string; body_preview: string}>}> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots`);
  }

  async restoreSnapshot(docId: string, snapshotId: string): Promise<{id: string; body: string}> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots/${snapshotId}/restore`, { method: 'POST' });
  }

  async runPhiScan(docId: string): Promise<{findings: Array<{start: number; end: number; text: string; suggestion: string}>}> {
    return this.fetch(`/api/v1/docs/${docId}/phi-scan`, { method: 'POST' });
  }

  async exportDocx(docId: string, title?: string): Promise<{docx_path: string; size_bytes: number}> {
    const r = await fetch(`/api/v1/docs/${docId}/export`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ''), '/export');
    const blob = await r.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'document').replace(/[^a-z0-9\u4e00-\u9fa5_-]/gi, '_')}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    return { docx_path: a.download, size_bytes: blob.size };
  }

  async *polishDoc(docId: string, selection: string, instruction?: string): AsyncIterable<{text: string; done?: boolean}> {
    const r = await fetch(`/api/v1/docs/${docId}/polish`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selection, instruction }),
    });
    if (!r.ok || !r.body) throw new ApiError(r.status, await r.text().catch(() => ''), '/polish');
    // #457: single SSE parser.
    yield* parseSseStream<{text: string; done?: boolean}>(r);
  }

}
