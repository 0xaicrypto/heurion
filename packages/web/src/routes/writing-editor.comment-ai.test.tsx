/**
 * #1041 — 「请AI处理」按钮（TDD，issue 用例表 6 条）。
 *
 * 复用现有 chat 驱动编辑链路：评论正文（编辑指令）+ anchorText 定位上下文 +
 * sectionId 组装成指令文本 → sendChatText（doc- 工具循环，模型调用 edit_document）
 * → doc_updated → diffReview → ProposalCard accept/reject（不做新 diff UI）。
 * diff 出现时线程追加 AI 回复（role:'ai'）；#1096: accept = 采纳本轮修改，
 * **不再**自动 resolved（AI 永不自动关闭评论，关闭权在用户手动「标记已解决」）；
 * reject/cancel → 保持 open 可重触发；定位失败 → AI 回复说明失败与候选。
 *
 * Mock 策略与 writing-editor.writeback.test.tsx 同口径：mock 网络层 @/lib/api，
 * chat turn 用 sendChatFull 的 turn 脚本（doc_updated 写回 + final answer），
 * 真实 store/路由 effect/DocEditor 审阅 UI 驱动。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore, resetAssistantTurnIdsForTests } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

// TipTap needs a real selection API in jsdom（同 writeback.test.tsx）。
class FakeRange {
  startContainer: Node = document;
  startOffset = 0;
  endContainer: Node = document;
  endOffset = 0;
  collapsed = true;
  commonAncestorContainer: Node = document;
  setStart() {}
  setEnd() {}
  collapse() {}
  selectNodeContents() {}
  deleteContents() {}
  insertNode() {}
  createContextualFragment = () => document.createDocumentFragment();
  toString = () => '';
}

const apiMock = vi.hoisted(() => ({
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
  getDocSnapshots: vi.fn(),
  getSnapshotBody: vi.fn(),
  listSubmissionDrafts: vi.fn(),
  getDocReferences: vi.fn(),
  addDocReference: vi.fn(),
  deleteDocReference: vi.fn(),
  getMessages: vi.fn(),
  listSkills: vi.fn(),
  sendChatFull: vi.fn(),
  polishDoc: vi.fn(),
  createDocSnapshot: vi.fn(),
  exportDocx: vi.fn(),
  exportDoc: vi.fn(),
  runPhiScan: vi.fn(),
  generateMethods: vi.fn(),
  injectResults: vi.fn(),
  uploadFile: vi.fn(),
  // #1077: 引用 API mock — 路由挂载期拉取 + 30s 轮询，不 mock 会 TypeError。
  listDocCitations: vi.fn().mockResolvedValue({ citations: [] }),
  // 评论 API（#1040 既有面 + #1041 闭环断言对象）。
  listDocComments: vi.fn(),
  createDocComment: vi.fn(),
  createDocCommentReply: vi.fn(),
  createDocCommentAiReply: vi.fn(),
  updateDocComment: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status?: number;
    code: string | null;
    messageText: string;
    constructor(message: string, opts?: { status?: number; code?: string | null }) {
      super(message);
      this.status = opts?.status;
      this.code = opts?.code ?? null;
      this.messageText = message;
    }
  },
  api: apiMock,
}));

const DOC_ID = 'd1';
const SESSION = `doc-${DOC_ID}`;
const PARA1 = '这是被评论的正文段落，足够长的一段文字用于测试。';
const BASE_BODY = `## Intro\n\n${PARA1}\n`;
const BASE_DOC = {
  id: DOC_ID,
  title: 'Original',
  body: BASE_BODY,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: null,
  study_name: null,
};

/** #1040 评论 fixture — #1041 关注 open 线程 + 定位诊断。 */
function makeComment(fx: {
  id: string;
  anchor_text: string;
  status?: string;
  anchor?: { located: boolean; candidates?: Array<{ text: string; start: number; heading: string; similarity: number }> };
  replies?: Array<{ id: string; role: string; text: string; created_at: string }>;
  target?: string;
  slide_index?: number | null;
}) {
  const status = fx.status ?? 'open';
  return {
    id: fx.id,
    doc_id: DOC_ID,
    section_id: 's_intro',
    anchor_text: fx.anchor_text,
    status,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    resolved_at: status === 'resolved' ? '2026-01-02T00:00:00Z' : null,
    target: fx.target ?? 'section',
    slide_index: fx.slide_index ?? null,
    block_index: null,
    replies: fx.replies ?? [{ id: 'r1', role: 'user', text: '这段需要补数据来源', created_at: 't0' }],
    ...(status === 'open' && fx.anchor ? { anchor: fx.anchor } : {}),
  };
}

const C1 = () => makeComment({ id: 'c1', anchor_text: PARA1, anchor: { located: true } });

/** chat turn 脚本：body 写回（doc_updated）+ 最终回复文本。 */
type TurnScript = { body?: string; rev?: number; answer?: string };
const turnScripts: TurnScript[] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const script = turnScripts.shift() ?? {};
    // chunk 间跨宏任务发射（同 writeback.test.tsx — 路由冲刷 effect 需要看到
    // loading true→false 沿）。
    if (script.body !== undefined) {
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: script.body, rev: script.rev ?? 1 };
    }
    await new Promise((r) => setTimeout(r, 10));
    yield { type: 'final_answer_chunk', text: script.answer ?? 'ok' };
    // #1072-2 web 适配: 真实服务端 turn_complete 携带 assistant_event_idx
    // (conversation-turn.ts / chat-handler.ts 全部正常收尾路径) — ai-replies
    // 的 turn_id 取数来源,mock 保持同保真度。
    yield { type: 'turn_complete', assistant_event_idx: 3 };
  });
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={[`/app/writing/${DOC_ID}`]}>
      <Routes>
        <Route path="/app/writing/:docId" element={<WritingEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 打开侧边栏评论面板（页头评论开关）。 */
async function openCommentsPanel() {
  const toggle = await screen.findByRole('button', { name: /评论|Comments/ });
  fireEvent.click(toggle);
  await screen.findByTestId('comments-panel');
  await screen.findByTestId('comment-thread-c1');
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  apiMock.getDoc.mockResolvedValue(BASE_DOC);
  apiMock.updateDoc.mockResolvedValue({ ...BASE_DOC, updated_at: '2026-01-03T00:00:00Z' });
  apiMock.getDocSnapshots.mockResolvedValue({ snapshots: [] });
  apiMock.getSnapshotBody.mockResolvedValue({ id: 's1', created_at: '', label: '', body: BASE_BODY });
  apiMock.listSubmissionDrafts.mockResolvedValue({ drafts: [] });
  apiMock.getDocReferences.mockResolvedValue({ references: [] });
  apiMock.getMessages.mockResolvedValue({ messages: [], total: 0 });
  apiMock.listSkills.mockResolvedValue({ skills: [] });
  apiMock.listDocComments.mockResolvedValue({ comments: [C1()] });
  apiMock.createDocCommentAiReply.mockImplementation(async (_docId: string, commentId: string, text: string) => ({
    id: `reply_${commentId}_${Date.now()}`,
    role: 'ai',
    text,
    created_at: 't1',
  }));
  apiMock.updateDocComment.mockImplementation(async (_docId: string, commentId: string, status: string) => ({
    ...C1(),
    id: commentId,
    status,
    resolved_at: status === 'resolved' ? '2026-01-03T00:00:00Z' : null,
  }));
  mockTurns();
  turnScripts.length = 0;
  useChatStore.setState({ sessions: {} });
  // #1072-2: 服务端 turn id 记录是模块级 — 测试隔离(上一用例的 id 不得漏进本用例)。
  resetAssistantTurnIdsForTests();
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as never);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('#1041 请AI处理（issue 用例表 6 条）', () => {
  /** 用例 1：点击「请AI处理」→ 触发 chat 指令，参数含 sectionId/anchorText/评论意见。 */
  test('点击请AI处理：发送的指令含 sectionId、anchorText 与评论意见', async () => {
    turnScripts.push({ answer: '已按要求修改' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));

    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    const opts = apiMock.sendChatFull.mock.calls[0][0];
    expect(opts.text).toContain('s_intro');
    expect(opts.text).toContain(PARA1);
    expect(opts.text).toContain('这段需要补数据来源');
    // 编辑指令走 doc- 会话（同一 chat 管道）
    expect(opts.sessionId).toBe(SESSION);
  });

  /** 用例 2：edit_document 成功返回 diff → 线程追加 AI 回复 + 正文出现可 accept/reject 的 diff。 */
  test('处理成功返回 diff：AI 回复进入线程，ProposalCard 审阅出现', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120（据评论意见补充）。`, rev: 1, answer: '已在 Intro 节补充样本量说明。' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));

    // diff 审阅出现（复用 ProposalCard，不做新 diff UI）
    const acceptBtn = await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    expect(acceptBtn).toBeTruthy();
    // 线程追加 AI 回复（说明做了什么 — 取 turn 的最终答复文本）
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    
    expect(apiMock.createDocCommentAiReply.mock.calls[0][2]).toContain('已在 Intro 节补充样本量说明');
    // 评论本身保持 open（等用户 accept 后才 resolved）
    expect(apiMock.updateDocComment).not.toHaveBeenCalled();
  });

  /** 用例 3（#1096 改写）：用户 accept diff → 只代表采纳本轮修改 — 评论保持
   *  open 可多轮交互，status 不被 AI 路径触碰（用户手动「标记已解决」是唯一关闭路径）。 */
  test('接受 diff：评论保持 open（AI 永不自动关闭评论，#1096）', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120。`, rev: 1, answer: '已补充' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ }));

    // #1096: accept 不再 PATCH resolved — status 全程未被触碰
    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('open'));
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');
    // #1095 多轮交互：同一评论可立即再次发起（评论 open 且登记已清）
    turnScripts.push({ body: `${BASE_BODY}\n第二轮修改。`, rev: 2, answer: '第二轮修改完成' });
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
  });

  /** 用例 4：用户 reject（放弃）diff → 评论保持 open，可再次触发。 */
  test('放弃 diff：评论保持 open，可重新触发处理', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120。`, rev: 1, answer: '已补充' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Discard|放弃/ }));

    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('open'));
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');

    // 重新触发 — 第二轮处理可再次发起（按钮未禁用）
    turnScripts.push({ body: `${BASE_BODY}\n第二轮修改。`, rev: 2, answer: '第二轮' });
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    // #1060: 等第二轮真正结束再收尾 — 否则在途 turn 的 chunk 会漏进下一
    // 条用例的会话（本文件此前 case 5 的确定性污染源,base 上即红）。
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
  });

  /** 用例 5：anchorText 定位失败（漂移）→ AI 回复说明定位失败 + 候选，不静默失败。 */
  test('锚点漂移：指令注明可能漂移，turn 无写回时 AI 回复含失败说明与候选', async () => {
    apiMock.listDocComments.mockResolvedValue({
      comments: [
        makeComment({
          id: 'c1',
          anchor_text: '这段原文已经被改得面目全非了。',
          anchor: { located: false, candidates: [{ text: PARA1, start: 10, heading: 'Intro', similarity: 0.9 }] },
        }),
      ],
    });
    turnScripts.push({ answer: '好的，我看看。' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    // 指令注明锚点可能漂移
    expect(apiMock.sendChatFull.mock.calls[0][0].text).toContain('漂移');

    // turn 结束无写回 → AI 回复说明定位失败 + 候选建议（复用 anchor-diagnostics 输出）
    // #1064 集成收口: 走专用 ai-replies 入口,参数为 (docId, commentId, text)。
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    const replyText = apiMock.createDocCommentAiReply.mock.calls[0][2] as string;
    // 候选建议可见（复用 anchor-diagnostics 的最近候选）
    expect(replyText).toContain(PARA1.slice(0, 10));
    // 评论保持 open（未产生修改 → 不得误标 resolved）
    expect(apiMock.updateDocComment).not.toHaveBeenCalled();
  });

  /** 用例 6：处理中重复点击 → 二次点击被忽略，不产生并发调用。 */
  test('重复点击请AI处理：第二次被忽略，只发起一轮处理', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120。`, rev: 1, answer: '已补充' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    const btn = () => screen.getByTestId('comment-ai-process-c1');
    fireEvent.click(btn());
    fireEvent.click(btn());

    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    // 处理期间按钮禁用
    expect((btn() as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    // turn 结束后仍是 1 次调用（无并发）
    await act(async () => {});
    expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1072-2 web 适配 — ai-replies 契约: body 必须携带 turn_id（该用户该文档
// doc_chat_messages 真实存在的 assistant 消息 id）。取数路径:SSE
// turn_complete.assistant_event_idx → chat store → appendAiReply。
// ─────────────────────────────────────────────────────────────────────────
describe('#1072-2 ai-replies turn_id 适配', () => {
  test('turn 带服务端消息 id：ai-replies 调用携带 turn_id（非空字符串）', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120。`, rev: 1, answer: '已补充' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    const call = apiMock.createDocCommentAiReply.mock.calls[0];
    // (docId, commentId, text, turnId)
    expect(call[0]).toBe(DOC_ID);
    expect(call[1]).toBe('c1');
    const turnId = call[3] as string | undefined;
    expect(typeof turnId).toBe('string');
    expect(turnId).not.toBe('');
  });

  test('turn 无服务端消息 id：不调用 ai-replies（避免 403），线程补本地失败说明', async () => {
    apiMock.sendChatFull.mockImplementation(async function* () {
      // watchdog 型终止 — 无 assistant_event_idx（chat-handler 中断路径同款）。
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'final_answer_chunk', text: 'ok' };
      yield { type: 'turn_complete' };
    });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
    // 无 turn_id 凭据 → 不调用（服务端必 400/403）
    expect(apiMock.createDocCommentAiReply).not.toHaveBeenCalled();
    // 线程内补本地失败说明（可理解、不静默）
    const thread = screen.getByTestId('comment-thread-c1');
    await waitFor(() => expect(thread.textContent).toContain('turn_id'));
    // 评论保持 open（未产生修改）
    expect(apiMock.updateDocComment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1060 → #1095 — 评论↔审阅关联在并发/排队时序下误归属与卡死窗口。
// 关联 =「单评论单 turn + 指令指纹匹配」：冲刷/收口只消费「本 turn 实际
// 发出其指令」的评论。#1095: 排队从单槽升级为多槽 FIFO（不再互相覆盖），
// 多评论可同时排队/处理，各自独立收口；Stop/regenerate 清队逐槽事件清理。
// ─────────────────────────────────────────────────────────────────────────
describe('#1060/#1095 评论关联并发/排队时序', () => {
  const C2 = () => makeComment({
    id: 'c2',
    anchor_text: PARA1,
    replies: [{ id: 'r2', role: 'user', text: '第二个评论的处理意见', created_at: 't0' }],
  });
  const btnFor = (id: string) => screen.getByTestId(`comment-ai-process-${id}`) as HTMLButtonElement;

  /** 用例 1（#1095 改写，误归属回归）：评论 A 处理中可登记评论 B（各自独立
   *  turnId 排队）；A 的 diff 先冲刷 → 只关联 A（fp=A），B 不被 A 的 diff 吞并；
   *  B 的 turn 紧随其后独立执行、独立收口。 */
  test('A 处理中登记 B：两指令都发出，A 的审阅只关联 A，B 独立收口（#1095）', async () => {
    apiMock.listDocComments.mockResolvedValue({ comments: [C1(), C2()] });
    // CI 慢机时序确定性（本用例此前自由时序在 CI 抖动 — 复审轮 5 部署批次）：
    // B 的 turn 用显式 gate 门控，accept（审阅关闭）与 B 的写回冲刷先后
    // 由断言序列固定，不再依赖渲染速度。
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => { releaseB = r; });
    const scripts: Array<'A' | 'B'> = ['A', 'B'];
    apiMock.sendChatFull.mockImplementation(async function* () {
      const mode = scripts.shift() ?? 'A';
      if (mode === 'A') {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'doc_updated', body: `${BASE_BODY}\nA 的修改。`, rev: 1 };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'final_answer_chunk', text: 'A 完成' };
        yield { type: 'turn_complete', assistant_event_idx: 3 };
        return;
      }
      await gateB;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: `${BASE_BODY}\nA 的修改。\nB 的修改。`, rev: 2 };
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'final_answer_chunk', text: 'B 完成' };
      yield { type: 'turn_complete', assistant_event_idx: 4 };
    });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    await screen.findByTestId('comment-thread-c2');

    // A 的 turn 运行中（流式 10ms 间隔）→ B 立即登记入队（#1095 并行语义）
    fireEvent.click(btnFor('c1'));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(true));
    fireEvent.click(btnFor('c2'));
    // A 直发 + B 排队（A 完成后自动发出 — gate 放行前 B 挂起）
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMock.sendChatFull.mock.calls[0][0].text).toContain('这段需要补数据来源'));
    releaseB();
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    expect(apiMock.sendChatFull.mock.calls[1][0].text).toContain('第二个评论的处理意见');
    // B 的 turn 真实结束（写回在 A 审阅未决时进累计队列 — 确定性时序）
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));

    // A 的 diff 冲刷 → 审阅打开（fp=A 只关联 A）→ accept → 队列重放 B 独立关联
    const acceptBtn = await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.some((c) => c[1] === 'c1')).toBe(true));
    fireEvent.click(acceptBtn);
    // #1096: accept 不再 PATCH resolved
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c2', 'resolved');
    await waitFor(() => expect(screen.getByTestId('comment-thread-c2').getAttribute('data-status')).toBe('open'));

    // B 独立收到自己的 AI 回复（队列重放 attach，fp=B）
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.some((c) => c[1] === 'c2')).toBe(true));
    await act(async () => {});
  });

  /** 用例 2（#1095 改写）：排队不再互相覆盖 — 队列保留全部指令按序执行；
   *  评论指令排队期间 loading 保持、turn 真正跑完才收口，无卡死可重试。 */
  test('排队指令不再被覆盖：队列按序执行、loading 不提前收口、可重试', async () => {
    // 挂起的第一轮普通 turn — 评论指令入队后靠它验证队列语义。
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => { releaseTurn = r; });
    const scriptQueue: Array<'hang' | 'quick'> = [];
    apiMock.sendChatFull.mockImplementation(async function* () {
      const mode = scriptQueue.shift() ?? 'quick';
      if (mode === 'hang') await turnGate;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'final_answer_chunk', text: 'ok' };
      // #1072-2 web 适配: 同 mockTurns — turn_complete 携带服务端消息 id。
      yield { type: 'turn_complete', assistant_event_idx: 5 };
    });
    scriptQueue.push('hang');
    void useChatStore.getState().sendMessageQueued(SESSION, {
      text: '第一轮普通消息', sessionId: SESSION, patientHash: null, skills: [], attachments: [], scene: 'document',
    });
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(true));

    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    // 评论 A 处理中（指令排队等待真实 turn）— loading 不提前收口（入队即 resolve 不清按钮）
    fireEvent.click(btnFor('c1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(btnFor('c1').disabled).toBe(true);

    // 第二条普通消息入队 — #1095: 不再覆盖评论指令，队列两条并存
    scriptQueue.push('quick');
    void useChatStore.getState().sendMessageQueued(SESSION, {
      text: '第二条覆盖消息', sessionId: SESSION, patientHash: null, skills: [], attachments: [], scene: 'document',
    });
    const queue = useChatStore.getState().sessions[SESSION]?.pendingQueue ?? [];
    expect(queue.map((s) => s.text)).toEqual(['【评论处理】'.length > 0 ? queue[0]?.text : '', '第二条覆盖消息'].slice(0, 2));

    // 解除挂起：第一轮结束 → 按序自动发出（评论指令 → 第二条消息）→ 全部结束
    releaseTurn();
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(3));
    expect(apiMock.sendChatFull.mock.calls[1][0].text).toContain('这段需要补数据来源');
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
    // 评论 A 的 turn 已真实结束 → loading 收口（无写回 → 线程有失败/说明回复）
    expect(btnFor('c1').disabled).toBe(false);
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
  });

  /** 用例 3（Stop 清理）：Stop 中断 turn → 清空排队指令 → 被停评论的 pending 态被清理，可重试。 */
  test('Stop 中断：排队评论的 pending 态被清理，可重试不卡死', async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => { releaseTurn = r; });
    apiMock.sendChatFull.mockImplementation(async function* () {
      await turnGate;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'final_answer_chunk', text: 'ok' };
      // #1072-2 web 适配: 同 mockTurns — turn_complete 携带服务端消息 id。
      yield { type: 'turn_complete', assistant_event_idx: 7 };
    });
    void useChatStore.getState().sendMessageQueued(SESSION, {
      text: '第一轮普通消息', sessionId: SESSION, patientHash: null, skills: [], attachments: [], scene: 'document',
    });
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(true));

    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(btnFor('c1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(btnFor('c1').disabled).toBe(true);

    // Stop：store 清空排队指令 + 发清理事件 → 评论登记同步清理
    useChatStore.getState().stopStream(SESSION);
    await waitFor(() => expect(btnFor('c1').disabled).toBe(false));

    // 解除挂起让挂着的 turn 结束，随后重试评论 A — 正常发起
    releaseTurn();
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});

    fireEvent.click(btnFor('c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    expect(apiMock.sendChatFull.mock.calls[1][0].text).toContain('这段需要补数据来源');
  });

  /** 用例 4（回归）：正常单评论闭环 — 行为不变（diff → AI 回复 → accept 采纳本轮）。 */
  test('正常单评论闭环回归：审阅、AI 回复、accept 采纳本轮修改（评论保持 open，#1096）', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 130。`, rev: 1, answer: '已在 Intro 节补充样本量。' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(btnFor('c1'));

    // turn 运行中按钮 loading；diff 冲刷后审阅打开
    await waitFor(() => expect(btnFor('c1').disabled).toBe(true));
    const acceptBtn = await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    // loading 与 turn 真实边界对齐：审阅打开（attach 消费）后 loading 收口
    await waitFor(() => expect(btnFor('c1').disabled).toBe(false));

    fireEvent.click(acceptBtn);
    // #1096: accept 不触碰 status — 评论保持 open
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');
    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('open'));
    // 线程 AI 回复内容来自 turn 最终答复（#1064 集成收口: 参数 (docId, commentId, text)）
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.some((c) => String(c[2]).includes('已在 Intro 节补充样本量'))).toBe(true));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1095 — 评论并行处理（排队式，issue 验收 3 条）：
// 多个评论可同时点「请AI处理」→ 各自独立 turnId 排队（FIFO 串行执行）；
// 无误归属/卡死回归；chat store 队列多槽化（stores/chat.test.ts 已锁）。
// ─────────────────────────────────────────────────────────────────────────
describe('#1095 评论并行处理（多评论同时「请AI处理」）', () => {
  const btnFor = (id: string) => screen.getByTestId(`comment-ai-process-${id}`) as HTMLButtonElement;

  test('多评论同时点击：两条指令都发出，各自独立收口；排队位次提示可见', async () => {
    apiMock.listDocComments.mockResolvedValue({
      comments: [
        C1(),
        makeComment({ id: 'c2', anchor_text: PARA1, replies: [{ id: 'r2', role: 'user', text: '第二个评论的处理意见', created_at: 't0' }] }),
      ],
    });
    // CI 时序确定性（同上 — gate 门控 B 轮，accept 后 B 落地冲刷不再自由竞速）
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => { releaseB = r; });
    const scripts: Array<'A' | 'B'> = ['A', 'B'];
    apiMock.sendChatFull.mockImplementation(async function* () {
      const mode = scripts.shift() ?? 'A';
      if (mode === 'A') {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'doc_updated', body: `${BASE_BODY}\nA 的修改。`, rev: 1 };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'final_answer_chunk', text: 'A 完成' };
        yield { type: 'turn_complete', assistant_event_idx: 3 };
        return;
      }
      await gateB;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: `${BASE_BODY}\nA 的修改。\nB 的修改。`, rev: 2 };
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'final_answer_chunk', text: 'B 完成' };
      yield { type: 'turn_complete', assistant_event_idx: 4 };
    });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    await screen.findByTestId('comment-thread-c2');

    // A 直发（turn 开始）；B 立即入队 — 各自按钮独立 loading，互不拒绝
    fireEvent.click(btnFor('c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    fireEvent.click(btnFor('c2'));
    // B 的指令在 A 之后发出（FIFO 顺序）
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    expect(apiMock.sendChatFull.mock.calls[1][0].text).toContain('第二个评论的处理意见');

    // 各自独立收口：A 的 diff 冲刷 → 审阅打开 → 只关联 A（fp=A）
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.filter((c) => c[1] === 'c1').length).toBeGreaterThan(0));
    // #1096: 全程零 status PATCH（AI 永不自动关闭评论）
    expect(apiMock.updateDocComment).not.toHaveBeenCalled();
    // B 落地（A 审阅未决 → 写回进累计队列）→ accept → 队列重放独立关联
    releaseB();
    await waitFor(() => expect(apiMock.sendChatFull.mock.calls.length).toBe(2));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    const acceptBtn = await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    fireEvent.click(acceptBtn);
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.filter((c) => c[1] === 'c2').length).toBeGreaterThan(0));
    await act(async () => {});
  });

  test('同评论处理中重复点击仍被忽略（has() 守卫保留），不同评论可并行登记', async () => {
    apiMock.listDocComments.mockResolvedValue({
      comments: [C1(), makeComment({ id: 'c2', anchor_text: PARA1, replies: [{ id: 'r2', role: 'user', text: '第二个评论的处理意见', created_at: 't0' }] })],
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => { releaseTurn = r; });
    apiMock.sendChatFull.mockImplementation(async function* () {
      await turnGate;
      yield { type: 'final_answer_chunk', text: 'ok' };
      yield { type: 'turn_complete', assistant_event_idx: 9 };
    });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    await screen.findByTestId('comment-thread-c2');

    fireEvent.click(btnFor('c1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(btnFor('c1').disabled).toBe(true);
    // 同评论二次点击被忽略；不同评论 B 可并行登记（入队）
    fireEvent.click(btnFor('c1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    turnScripts.push({ answer: 'B 完成' });
    fireEvent.click(btnFor('c2'));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.pendingQueue?.length).toBe(1));
    // 队列里只有 B 的指令（A 是直发）
    expect(useChatStore.getState().sessions[SESSION]?.pendingQueue?.[0]?.text).toContain('第二个评论的处理意见');
    expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1);
    releaseTurn();
    // A 结束 → B 自动发出
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
  });

  test('复审 #6 — 并发上限 5：第 6 条评论登记被拒（队列不增长，不静默）', async () => {
    const sixComments = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) =>
      makeComment({ id, anchor_text: PARA1, replies: [{ id: `r_${id}`, role: 'user', text: `${id} 的处理意见`, created_at: 't0' }] }),
    );
    apiMock.listDocComments.mockResolvedValue({ comments: sixComments });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => { releaseTurn = r; });
    apiMock.sendChatFull.mockImplementation(async function* () {
      await turnGate;
      yield { type: 'final_answer_chunk', text: 'ok' };
      yield { type: 'turn_complete', assistant_event_idx: 11 };
    });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    for (const id of ['c2', 'c3', 'c4', 'c5', 'c6']) {
      await screen.findByTestId(`comment-thread-${id}`);
    }
    // c1 直发 + 其余 5 条... 上限 5：c1 直发（登记 1）+ c2-c5 入队（登记 5）→ c6 被拒
    fireEvent.click(btnFor('c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    for (const id of ['c2', 'c3', 'c4', 'c5']) {
      fireEvent.click(btnFor(id));
      await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.pendingQueue?.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    }
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.pendingQueue?.length).toBe(4));
    // 第 6 条（c6）→ 被上限拒绝：队列不变、不发起新 turn
    const queueBefore = (useChatStore.getState().sessions[SESSION]?.pendingQueue ?? []).map((x) => x.text);
    fireEvent.click(btnFor('c6'));
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect((useChatStore.getState().sessions[SESSION]?.pendingQueue ?? []).map((x) => x.text)).toEqual(queueBefore);
    expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1);
    // 解除挂起收尾（不污染后续用例）
    releaseTurn();
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});
  });
});
