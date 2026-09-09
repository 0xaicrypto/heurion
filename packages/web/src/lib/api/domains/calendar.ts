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
  async addDocReference(docId: string, data: {kind: string; content: string; source_patient_hash?: string; label?: string}): Promise<{
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
  }> {
    return this.fetch(`/api/v1/docs/${docId}/references`, { method: 'POST', body: JSON.stringify(data) });
  }

  /** #711: 删除文档参考材料(移除 AI 上下文输入)。 */
  async deleteDocReference(docId: string, referenceId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}/references/${referenceId}`, { method: 'DELETE' });
  }

}
