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
import { useChatStore } from '@/stores/chat';
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
    yield { type: 'turn_complete' };
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
  apiMock.createDocCommentReply.mockImplementation(async (_docId: string, commentId: string, data: { role: string; text: string }) => ({
    id: `reply_${commentId}_${Date.now()}`,
    role: data.role,
    text: data.text,
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
    await waitFor(() => expect(apiMock.createDocCommentReply).toHaveBeenCalled());
    expect(apiMock.createDocCommentReply.mock.calls[0][2].role).toBe('ai');
    expect(apiMock.createDocCommentReply.mock.calls[0][2].text).toContain('已在 Intro 节补充样本量说明');
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
    await waitFor(() => expect(apiMock.createDocCommentReply).toHaveBeenCalled());

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
    await waitFor(() => expect(apiMock.createDocCommentReply).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Discard|放弃/ }));

    await waitFor(() => expect(screen.getByTestId('comment-thread-c1').getAttribute('data-status')).toBe('open'));
    expect(apiMock.updateDocComment).not.toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');

    // 重新触发 — 第二轮处理可再次发起（按钮未禁用）
    turnScripts.push({ body: `${BASE_BODY}\n第二轮修改。`, rev: 2, answer: '第二轮' });
    fireEvent.click(screen.getByTestId('comment-ai-process-c1'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(2));
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
    await waitFor(() => expect(apiMock.createDocCommentReply).toHaveBeenCalled());
    const reply = apiMock.createDocCommentReply.mock.calls[0][2];
    expect(reply.role).toBe('ai');
    // 候选建议可见（复用 anchor-diagnostics 的最近候选）
    expect(reply.text).toContain(PARA1.slice(0, 10));
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
    await waitFor(() => expect(apiMock.createDocCommentReply).toHaveBeenCalled());
    // turn 结束后仍是 1 次调用（无并发）
    await act(async () => {});
    expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1);
  });
});
