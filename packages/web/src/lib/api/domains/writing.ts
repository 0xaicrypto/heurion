import { ApiCore, ApiError } from './core.js';
import { parseSseStream } from '../../sse';
import { downloadBlob } from '../../download';
import type { PolishStreamChunk } from '@heurion/contracts';


export class WritingApi extends ApiCore {
  /* ────────────────────────── writing ────────────────────────── */

  async listDocs(): Promise<{docs: Array<{id: string; title: string; updated_at: string; ref_count: number}>}> {
    return this.fetch('/api/v1/docs');
  }

  async createDoc(title: string, studyId?: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
    return this.fetch('/api/v1/docs', { method: 'POST', body: JSON.stringify({ title, study_id: studyId }) });
  }

  async getDoc(docId: string): Promise<{id: string; title: string; body: string; deck?: unknown; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
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

  // #773: deck 为可编辑资产（deck 视图编辑保存路径）；undefined = 不触碰。
  async updateDoc(docId: string, data: {title: string; body: string; deck?: unknown; /** #882: 客户端最后同步的服务端正文指纹 — 不匹配 → 409 stale_base */ base_sha?: string; /** #882: 显式覆盖(冲突横幅「保留我的版本」) */ force?: boolean}): Promise<{id: string; title: string; body: string; deck?: unknown; updated_at: string; unchanged?: boolean}> {
    return this.fetch(`/api/v1/docs/${docId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async getDocSnapshots(docId: string): Promise<{snapshots: Array<{snapshot_id: string; created_at: string; body_preview: string; label?: string}>}> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots`);
  }

  /** #764: deprecated — restore 改走 getSnapshotBody + diff 审阅 + updateDoc。 */
  async restoreSnapshot(docId: string, snapshotId: string): Promise<{id: string; body: string}> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots/${snapshotId}/restore`, { method: 'POST' });
  }

  /** #764: 快照全文 — Restore 流程先取全文与当前版本 diff 审阅。 */
  async getSnapshotBody(docId: string, snapshotId: string): Promise<{id: string; created_at: string; label: string; body: string}> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots/${snapshotId}`);
  }

  async runPhiScan(docId: string): Promise<{findings: Array<{start: number; end: number; text: string; suggestion: string}>}> {
    return this.fetch(`/api/v1/docs/${docId}/phi-scan`, { method: 'POST' });
  }

  /**
   * 导出文档为 docx/pdf（#fix: 原仅 docx,且 chat 的"导出 PDF"按钮误调本
   * 方法 — 现按 format 走真实格式）。
   */
  async exportDoc(docId: string, format: 'docx' | 'pdf', title?: string): Promise<{path: string; size_bytes: number}> {
    const r = await fetch(`/api/v1/docs/${docId}/export?format=${format}`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ''), '/export');
    const blob = await r.blob();
    // #653: 下载触发收敛 lib/download.downloadBlob。
    const filename = `${(title || 'document').replace(/[^a-z0-9\u4e00-\u9fa5_-]/gi, '_')}.${format}`;
    downloadBlob(blob, filename);
    return { path: filename, size_bytes: blob.size };
  }

  async exportDocx(docId: string, title?: string): Promise<{docx_path: string; size_bytes: number}> {
    const res = await this.exportDoc(docId, 'docx', title);
    return { docx_path: res.path, size_bytes: res.size_bytes };
  }

  // #797: 契约类型化 — PolishStreamChunk 来自 @heurion/contracts(此前
  // wire 形状手写在本文件,与服务端人肉对齐)。
  async *polishDoc(docId: string, selection: string, instruction?: string, signal?: AbortSignal): AsyncIterable<PolishStreamChunk> {
    const r = await fetch(`/api/v1/docs/${docId}/polish`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ selection, instruction }),
      // #752-ux: 气泡「取消」按钮 — 中断即断流,不再干等模型跑完。
      signal,
    });
    if (!r.ok || !r.body) throw new ApiError(r.status, await r.text().catch(() => ''), '/polish');
    // #457: single SSE parser.
    yield* parseSseStream<PolishStreamChunk>(r);
  }

  /**
   * #870: 气泡 apply 补版本快照 — 与聊天 edit_document 的 'AI edit'
   * 快照对齐(撤销/审计一致)。调用方 fire-and-forget,失败不阻塞编辑。
   * #907: 可选 base_sha — 与 #882 PUT 保存同一指纹语义(客户端基于的
   * 服务端正文字符串哈希),服务端与文档当前 body 指纹不匹配 → 409
   * stale_base(另一窗口/AI 在此期间更新过文档)。
   */
  async createDocSnapshot(docId: string, body: string, label = 'AI polish', base_sha?: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}/snapshots`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body, label, ...(base_sha ? { base_sha } : {}) }),
    });
  }
}
