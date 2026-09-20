/**
 * #1041 — 「请AI处理」按钮（TDD，issue 用例表 6 条）。
 *
 * 复用现有 chat 驱动编辑链路：评论正文（编辑指令）+ anchorText 定位上下文 +
 * sectionId 组装成指令文本 → sendChatText（doc- 工具循环，模型调用 edit_document）
 * → doc_updated → diffReview → ProposalCard accept/reject（不做新 diff UI）。
 * diff 出现时线程追加 AI 回复（role:'ai'）；accept → 评论 PATCH resolved；
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

  /** 用例 3：用户 accept diff → 评论状态变为 resolved。 */
  test('接受 diff：评论自动 resolved', async () => {
    turnScripts.push({ body: `${BASE_BODY}\n补充：样本量 120。`, rev: 1, answer: '已补充' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ }));

    await waitFor(() => expect(apiMock.updateDocComment).toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved'));
    // 线程置为 resolved
    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('resolved'));
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
// #1060 — 评论↔审阅关联在并发/排队时序下误归属与卡死窗口（issue 用例表 4 条）。
// 关联改为「单评论单 turn + 指令指纹匹配」：冲刷/收口只消费「本 turn 实际
// 发出其指令」的评论；排队单槽被覆盖 / Stop 清空时经 store 事件清理登记，
// 被覆盖的评论可重试；按钮 loading 与 turn 真实边界对齐（入队即 resolve
// 不再提前收口）。
// ─────────────────────────────────────────────────────────────────────────
describe('#1060 评论关联并发/排队时序（issue 用例表 4 条）', () => {
  const C2 = () => makeComment({
    id: 'c2',
    anchor_text: PARA1,
    replies: [{ id: 'r2', role: 'user', text: '第二个评论的处理意见', created_at: 't0' }],
  });
  const btnFor = (id: string) => screen.getByTestId(`comment-ai-process-${id}`) as HTMLButtonElement;

  /** 用例 1（误归属）：评论 A 处理中登记评论 B，A 的 diff 先冲刷 → B 不被 A 的 diff 误 resolved。 */
  test('A 处理中登记 B：B 不被 A 的 diff 误关联，A 的审阅接受只 resolved A', async () => {
    apiMock.listDocComments.mockResolvedValue({ comments: [C1(), C2()] });
    turnScripts.push({ body: `${BASE_BODY}\nA 的修改。`, rev: 1, answer: 'A 完成' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();
    await screen.findByTestId('comment-thread-c2');

    // A 的 turn 运行中（流式 10ms 间隔）→ 立即点击 B（旧实现会登记 B 并误关联）
    fireEvent.click(btnFor('c1'));
    fireEvent.click(btnFor('c2'));

    // #1060 单评论单 turn：A 处理中 B 的登记被 ref 级守卫拒绝 — B 的指令不发出
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1);

    // A 的 diff 冲刷 → 审阅打开 → 接受
    const acceptBtn = await screen.findByRole('button', { name: /Keep AI's edit|保留 AI 的修改/ });
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.some((c) => c[1] === 'c1')).toBe(true));
    fireEvent.click(acceptBtn);

    // 只有 A 被 resolved；B 保持 open
    await waitFor(() => expect(apiMock.updateDocComment).toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved'));
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c2', 'resolved');
    await waitFor(() => expect(screen.getByTestId('comment-thread-c2').getAttribute('data-status')).toBe('open'));

    // B 未被处理过 — 重试可正常发起（不被 has() 死锁）
    turnScripts.push({ answer: 'B 完成' });
    fireEvent.click(btnFor('c2'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
    expect(apiMock.sendChatFull.mock.calls[1][0].text).toContain('第二个评论的处理意见');
  });

  /** 用例 2（覆盖清理）+ loading 对齐：排队中第二条消息覆盖第一条 → 被覆盖评论可重试。 */
  test('排队指令被后续消息覆盖：pending 态被清理、loading 不提前收口、可重试', async () => {
    // 挂起的第一轮普通 turn — 评论指令入队单槽后靠它验证覆盖清理。
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

    // 第二条普通消息覆盖排队单槽 → 旧指令被静默丢弃 → store 事件清理评论登记
    scriptQueue.push('quick');
    void useChatStore.getState().sendMessageQueued(SESSION, {
      text: '第二条覆盖消息', sessionId: SESSION, patientHash: null, skills: [], attachments: [], scene: 'document',
    });
    await waitFor(() => expect(btnFor('c1').disabled).toBe(false));

    // 解除挂起：第一轮结束 → 自动发送覆盖消息（第二轮）→ 结束
    releaseTurn();
    await waitFor(() => expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false));
    await act(async () => {});

    // 被覆盖的评论 A 可重试 — 重新登记并发送指令（不永久卡死）
    fireEvent.click(btnFor('c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(3));
    expect(apiMock.sendChatFull.mock.calls[2][0].text).toContain('这段需要补数据来源');
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

  /** 用例 4（回归）：正常单评论闭环 — 行为不变（diff → AI 回复 → accept → resolved）。 */
  test('正常单评论闭环回归：审阅、AI 回复、accept 自动 resolved', async () => {
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
    await waitFor(() => expect(apiMock.updateDocComment).toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved'));
    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('resolved'));
    // 线程 AI 回复内容来自 turn 最终答复（#1064 集成收口: 参数 (docId, commentId, text)）
    await waitFor(() => expect(apiMock.createDocCommentAiReply.mock.calls.some((c) => String(c[2]).includes('已在 Intro 节补充样本量'))).toBe(true));
  });
});
