import { ApiCore, ApiError } from './core.js';
import { parseSseStream } from '../../sse';
import { downloadBlob } from '../../download';
import type { PolishStreamChunk } from '@heurion/contracts';

/* ────────────────── #1040 文档评论(#1039 sidecar 旁路表,不进正文)────────────────── */

/** 线程回复条目 — 与 comments.router.ts serializeReply 对齐。 */
export interface DocCommentReplyWire { id: string; role: string; text: string; created_at: string }

/** 锚点定位诊断候选(#1039 anchor-diagnostics)。 */
export interface DocCommentAnchorCandidate { text: string; start: number; heading: string; similarity: number }

/** open 评论附带的锚点定位诊断 — located=false 时附最近候选。 */
export interface DocCommentAnchorWire { located: boolean; candidates?: DocCommentAnchorCandidate[] }

/** 评论线程 — 与 comments.router.ts serializeComment 对齐。 */
export interface DocCommentWire {
  id: string;
  doc_id: string;
  /** #1051: deck_slide 评论为 null（锚点目标是幻灯片页，见 target/slide_index）。 */
  section_id: string | null;
  /** #1051: 锚点目标判别 — 'section'（正文节，默认）| 'deck_slide'（幻灯片页）。 */
  target: string;
  /** #1051: deck_slide 锚点 — 1-based 页码（与 edit_deck 的 slide_index 同口径）。 */
  slide_index: number | null;
  /** #1051: deck_slide 锚点 — 0-based 内容块序（整页评论为 null）。 */
  block_index: number | null;
  anchor_text: string;
  status: string;
  created_by: string;
  created_at: string;
  resolved_at: string | null;
  /** #1091: deck 评论 pending-confirm 快照（写回前画布 deck JSON）— 仅
   *  target='deck_slide' 且服务端快照在场才携带（有则带，对齐服务端序列化）。 */
  deck_snapshot?: string | null;
  replies: DocCommentReplyWire[];
  /** 仅 open 评论携带 — 锚点定位诊断(漂移时附最近候选)。 */
  anchor?: DocCommentAnchorWire;
}


export class WritingApi extends ApiCore {
  /* ────────────────────────── writing ────────────────────────── */

  // #996/#1000: has_deck = 工作台 Slides tab 的文档标记。
  async listDocs(): Promise<{docs: Array<{id: string; title: string; updated_at: string; ref_count: number; has_deck?: boolean}>}> {
    return this.fetch('/api/v1/docs');
  }

  async createDoc(title: string, studyId?: string): Promise<{id: string; title: string; body: string; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
    return this.fetch('/api/v1/docs', { method: 'POST', body: JSON.stringify({ title, study_id: studyId }) });
  }

  // #996/#999: section_meta = 节级作者/可信度标签(缺失降级不携带,#1002 节卡片徽标数据源)。
  async getDoc(docId: string): Promise<{id: string; title: string; body: string; deck?: unknown; /** #989 Phase 3: 块投影 — 「编辑过程流式可见」的批次基线(缺失 null)。 */ block_projection?: import('@heurion/contracts').BlockProjection | null; /** #999: 节级作者/可信度标签 */ section_meta?: import('@heurion/contracts').SectionMetaMap; created_at: string; updated_at: string; study_id?: string | null; study_name?: string | null}> {
    return this.fetch(`/api/v1/docs/${docId}`);
  }

  // #383: research ↔ paper linkage.
  async createPaperFromStudy(studyId: string): Promise<{ doc_id: string; title: string; body: string }> {
    return this.fetch(`/api/v1/research/studies/${studyId}/paper`, { method: 'POST', body: JSON.stringify({}) });
  }

  async generateMethods(docId: string): Promise<{ methods: string }> {
    return this.fetch(`/api/v1/docs/${docId}/generate-methods`, { method: 'POST', body: JSON.stringify({}) });
  }

  // #996/#997: 响应携带写回后的新正文 + 同帧投影(#998 直接路由进统一提议卡);
  // #999: section_meta 随行。旧后端仅 {ok:true} — 前端按 body 缺省走 getDoc 兜底。
  async injectResults(docId: string, label: string, result: string): Promise<{ ok: boolean; body?: string; block_projection?: import('@heurion/contracts').BlockProjection | null; section_meta?: import('@heurion/contracts').SectionMetaMap; updated_at?: string | null }> {
    return this.fetch(`/api/v1/docs/${docId}/inject-results`, { method: 'POST', body: JSON.stringify({ label, result }) });
  }

  async deleteDoc(docId: string): Promise<{ deleted: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}`, { method: 'DELETE' });
  }

  /** #995: 批量删除 — 归属内联(where userId),子表 Cascade。 */
  async batchDeleteDocs(ids: string[]): Promise<{ deleted: number; requested: number }> {
    return this.fetch('/api/v1/docs/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
  }

  // #773: deck 为可编辑资产（deck 视图编辑保存路径）；undefined = 不触碰。
  // review 复核#8a: 响应携带服务端最新 block_projection — 前端据此同步本地
  // 投影（手动保存后「AI 正在编辑哪个节」的批次基线不再过期）。
  async updateDoc(docId: string, data: {title: string; body: string; deck?: unknown; /** #882: 客户端最后同步的服务端正文指纹 — 不匹配 → 409 stale_base */ base_sha?: string; /** #882: 显式覆盖(冲突横幅「保留我的版本」) */ force?: boolean}): Promise<{id: string; title: string; body: string; deck?: unknown; /** 服务端最新块投影(缺失 null) */ block_projection?: import('@heurion/contracts').BlockProjection | null; /** #999: 节级作者/可信度标签(缺失不携带) */ section_meta?: import('@heurion/contracts').SectionMetaMap; updated_at: string; unchanged?: boolean}> {
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

  // #1040: 评论列表(含 replies;#1064 诊断懒计算 — with_anchor=1 才返回锚点定位诊断)。
  async listDocComments(docId: string, query: { section_id?: string; status?: 'open' | 'resolved'; with_anchor?: boolean } = {}): Promise<{ comments: DocCommentWire[] }> {
    const qs = new URLSearchParams();
    if (query.section_id) qs.set('section_id', query.section_id);
    if (query.status) qs.set('status', query.status);
    if (query.with_anchor) qs.set('with_anchor', '1');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.fetch(`/api/v1/docs/${docId}/comments${suffix}`);
  }

  // #1040: 创建评论(选区文字作 anchorText,首条内容落线程)。
  // #1051: target='deck_slide' 时 section_id 省略、slide_index 必填（1-based）。
  async createDocComment(docId: string, data: { section_id?: string; anchor_text: string; text: string; target?: 'section' | 'deck_slide'; slide_index?: number; block_index?: number }): Promise<DocCommentWire> {
    return this.fetch(`/api/v1/docs/${docId}/comments`, { method: 'POST', body: JSON.stringify(data) });
  }

  // #1040: 追加回复(role 缺省 user;#1064 role 收口 — 'ai' 不可自封,走专用入口)。
  async createDocCommentReply(docId: string, commentId: string, data: { role?: 'user'; text: string }): Promise<DocCommentReplyWire> {
    return this.fetch(`/api/v1/docs/${docId}/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify(data) });
  }

  // #1064 集成收口(#1041 消费): AI 回复专用入口 — 服务端固定 role:'ai'。
  // #1072-2 契约: body 必须携带 turn_id = 该用户该文档 doc_chat_messages 里
  // 真实存在的 assistant 消息 id（伪造/跨文档/跨用户/user 消息 → 403；缺失
  // → 400）。web 侧取数路径：SSE turn_complete.assistant_event_idx → chat
  // store latestAssistantTurnId() → 调用方传入；缺省时不带（调用方应先拦截，
  // 见 comments-ai hook 的「无 id 不调用」分支）。
  async createDocCommentAiReply(docId: string, commentId: string, text: string, turnId?: string): Promise<DocCommentReplyWire> {
    return this.fetch(`/api/v1/docs/${docId}/comments/${commentId}/ai-replies`, { method: 'POST', body: JSON.stringify({ text, ...(turnId ? { turn_id: turnId } : {}) }) });
  }

  // #1040: 切换 status(open/resolved)。#1091: PATCH 扩展 deck_snapshot —
  // string = 落库快照（服务端校验 ≤1MB + JSON 可解析），null = 清除（确认/
  // 撤销成功后清恢复点），undefined = 不触碰；status 可选（仅快照 PATCH
  // 不触碰 status/resolvedAt，线程保持 open 原状）。
  async updateDocComment(docId: string, commentId: string, status?: 'open' | 'resolved', opts?: { deck_snapshot?: string | null }): Promise<DocCommentWire> {
    return this.fetch(`/api/v1/docs/${docId}/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(status !== undefined ? { status } : {}),
        ...(opts && opts.deck_snapshot !== undefined ? { deck_snapshot: opts.deck_snapshot } : {}),
      }),
    });
  }

  // #1083: 正式参考文献（DocCitation）— 结构化引用列表（唯一事实源）。
  async listDocCitations(docId: string): Promise<{ citations: DocCitationWire[] }> {
    return this.fetch(`/api/v1/docs/${docId}/citations`);
  }

  // #1081: 悬挂引用诊断 — 正文 [cite:id] 找不到对应记录的清单（供可视化提示）。
  async listDanglingCitations(docId: string): Promise<{ dangling: Array<{ id: string; occurrences: number }>; citations: DocCitationWire[] }> {
    return this.fetch(`/api/v1/docs/${docId}/citations/dangling`);
  }

  // #1081: 「删除该引用」— 移除 DocCitation 记录；正文标记由 AI 编辑链路移除。
  async deleteDocCitation(docId: string, citationId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/v1/docs/${docId}/citations/${citationId}`, { method: 'DELETE' });
  }
}

export interface DocCitationWire {
  id: string;
  doc_id?: string;
  doi: string;
  pmid?: string | null;
  title: string;
  authors: string[];
  journal?: string | null;
  year?: number | null;
  url?: string | null;
  source: string;
  created_at?: string;
}
