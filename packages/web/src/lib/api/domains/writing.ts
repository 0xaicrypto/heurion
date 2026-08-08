import { SkillsApi } from './skills.js';


import { ApiError } from './core.js';

export class WritingApi extends SkillsApi {
  /* ────────────────────────── writing ────────────────────────── */

  async listDocs(): Promise<{docs: Array<{id: string; title: string; updated_at: string; ref_count: number}>}> {
    return this.fetch('/api/v1/docs');
  }

  async createDoc(title: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string}> {
    return this.fetch('/api/v1/docs', { method: 'POST', body: JSON.stringify({ title }) });
  }

  async getDoc(docId: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string}> {
    return this.fetch(`/api/v1/docs/${docId}`);
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
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) {
              try { yield JSON.parse(line.slice(6)); } catch { /* ignore */ }
            }
          }
        }
      }
    } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
  }

  async *sendDocChat(docId: string, message: string, skills?: string[]): AsyncIterable<{type: string; text?: string; reply?: string; doc_body?: string; message?: string}> {
    const body: Record<string, unknown> = { message };
    if (skills?.length) body.skills = skills;
    const r = await fetch(`/api/v1/docs/${docId}/chat`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) throw new ApiError(r.status, await r.text().catch(() => ''), '/doc/chat');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) {
              try { yield JSON.parse(line.slice(6)); } catch { /* ignore */ }
            }
          }
        }
      }
    } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
  }

}
