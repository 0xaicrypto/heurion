import { ApiCore } from './core.js';


export class CalendarApi extends ApiCore {
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

  /** 服务端 documents.router POST /references 响应 — 上传即草稿含 imported_body。 */
  async addDocReference(docId: string, data: {kind: string; content: string; source_patient_hash?: string; label?: string; reference_id?: string}): Promise<{
    reference_id: string;
    kind: string;
    content: string;
    label: string;
    source_patient_hash: string;
    created_at: string;
    /** 自动导入后的正文(空文档 + 文件类参考时,否则 null)。 */
    imported_body: string | null;
    imported: boolean;
    /** #777: pptx 走后台解析,前端据 started 轮询刷新。 */
    pptx_parse: { started: boolean; reason?: string } | null;
    /** #930: 幂等登记 — false 表示命中去重(未新建),文件库选择器据此刷新。 */
    created: boolean;
  }> {
    return this.fetch(`/api/v1/docs/${docId}/references`, { method: 'POST', body: JSON.stringify(data) });
  }

  /** #711: 删除文档参考材料(移除 AI 上下文输入)。 */
  async deleteDocReference(docId: string, referenceId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}/references/${referenceId}`, { method: 'DELETE' });
  }

  /* ────────── #1007: 会话级引用(主 chat 与写作编辑器共用) ────────── */

  async getSessionReferences(sessionId: string): Promise<{references: Array<{reference_id: string; session_reference_id: string; kind: string; label: string; content: string; source_ref: string | null; source: string; created_at: string}>}> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references`);
  }

  async addSessionReference(sessionId: string, data: {kind: string; content: string; label?: string; source_ref?: string; source_patient_hash?: string; reference_id?: string}): Promise<{
    reference_id: string;
    kind: string;
    content: string;
    label: string;
    source_ref: string | null;
    source: string;
    created_at: string;
    /** 与 doc 端点对齐的可选字段 — 会话端点不触发空文档导入,恒为空。 */
    imported?: boolean;
    imported_body?: string | null;
  }> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references`, { method: 'POST', body: JSON.stringify(data) });
  }

  async deleteSessionReference(sessionId: string, referenceId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references/${referenceId}`, { method: 'DELETE' });
  }

  /* ────────── #1010: 引用材料池（选择器隐式排序） ────────── */

  async getReferencePool(params: {sort: 'recent' | 'frequent' | 'relevant'; context?: string; limit?: number}): Promise<{items: Array<{
    reference_id: string;
    kind: string;
    label: string;
    content: string;
    source_ref: string | null;
    created_at: string;
    usage: {
      session_count: number;
      last_used_at: string | null;
      last_session_id: string | null;
      last_session_title: string | null;
    };
    score: number;
  }>}> {
    const qs = new URLSearchParams({ sort: params.sort });
    if (params.context) qs.set('context', params.context);
    if (params.limit) qs.set('limit', String(params.limit));
    return this.fetch(`/api/v1/references?${qs.toString()}`);
  }

  /* ────────── #1009/#1012: 建议态引用（pending 建议的展示与采纳/忽略） ────────── */

  async getSessionSuggestions(sessionId: string): Promise<{suggestions: Array<{
    id: string;
    sessionId: string;
    referenceId: string;
    reason: string;
    suggestedAt: string;
    status: string;
    reference: { id: string; kind: string; label: string; snapshot: string; sourceRef: string | null };
  }>}> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references/suggestions`);
  }

  /** #1008: 开局检测 — 打开会话时用标题/近期消息关键词命中未引用材料。 */
  async scanSessionSuggestions(sessionId: string, context: string): Promise<{suggestions: Array<{
    id: string;
    sessionId: string;
    referenceId: string;
    reason: string;
    suggestedAt: string;
    status: string;
    reference: { id: string; kind: string; label: string; snapshot: string; sourceRef: string | null };
  }>}> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references/suggestions/scan`, {
      method: 'POST',
      body: JSON.stringify({ context }),
    });
  }

  async resolveSessionSuggestion(sessionId: string, suggestionId: string, accept: boolean): Promise<{ok: boolean; reference_id?: string}> {
    return this.fetch(`/api/v1/sessions/${sessionId}/references/suggestions/${suggestionId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
  }

}
