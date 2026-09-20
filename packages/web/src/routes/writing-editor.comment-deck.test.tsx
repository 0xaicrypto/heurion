/**
 * #1051 — Comments 能力扩展到 deck slide（TDD，issue 用例表 5 条，web 侧）。
 *
 * 锚点判别联合：target 'section' | 'deck_slide'（slideIndex 1-based 与
 * edit_deck 同口径）。「请AI处理」对 deck 评论路由到 edit_deck 指令；
 * deck 写回直接落画布（#773 无 diff 审阅）→ 成功即 AI 回复 + 自动 resolved。
 * Mock 策略与 writing-editor.comment-ai.test.tsx 同口径（mock @/lib/api +
 * sendChatFull turn 脚本）。
 */
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

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
const BASE_BODY = '## Intro\n\n正文。\n';
const DECK = {
  title: '研究 deck',
  slides: [
    { title: '背景页', content: [{ type: 'paragraph', text: '研究背景要点。', style: 'bullet' }] },
    { title: '方法页', content: [{ type: 'paragraph', text: '120 例前瞻队列。', style: 'bullet' }] },
  ],
};
const BASE_DOC = {
  id: DOC_ID,
  title: 'Original',
  body: BASE_BODY,
  deck: DECK,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: null,
  study_name: null,
};

function makeComment(fx: {
  id: string;
  anchor_text: string;
  status?: string;
  target?: string;
  slide_index?: number | null;
  anchor?: { located: boolean; candidates?: Array<{ text: string; start: number; heading: string; similarity: number }> };
  replies?: Array<{ id: string; role: string; text: string; created_at: string }>;
}) {
  const status = fx.status ?? 'open';
  return {
    id: fx.id,
    doc_id: DOC_ID,
    section_id: fx.target === 'deck_slide' ? null : 's_intro',
    anchor_text: fx.anchor_text,
    status,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    resolved_at: status === 'resolved' ? '2026-01-02T00:00:00Z' : null,
    target: fx.target ?? 'section',
    slide_index: fx.slide_index ?? null,
    block_index: null,
    replies: fx.replies ?? [{ id: 'r1', role: 'user', text: '这页要补随访时长', created_at: 't0' }],
    ...(status === 'open' && fx.anchor ? { anchor: fx.anchor } : {}),
  };
}

const DECK_COMMENT = () => makeComment({ id: 'cdeck', anchor_text: '方法页', target: 'deck_slide', slide_index: 2, anchor: { located: true } });
const SECTION_COMMENT = () => makeComment({ id: 'csec', anchor_text: '正文。', anchor: { located: true } });

type TurnScript = { body?: string; rev?: number; deck?: unknown; answer?: string };
const turnScripts: TurnScript[] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const script = turnScripts.shift() ?? {};
    if (script.body !== undefined || script.deck !== undefined) {
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: script.body ?? BASE_BODY, rev: script.rev ?? 1, ...(script.deck !== undefined ? { deck: script.deck } : {}) };
    }
    await new Promise((r) => setTimeout(r, 10));
    yield { type: 'final_answer_chunk', text: script.answer ?? 'ok' };
    // #1072-2 web 适配: 真实服务端 turn_complete 携带 assistant_event_idx —
    // ai-replies 的 turn_id 取数来源,mock 保持同保真度。
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

async function openCommentsPanel() {
  // aria-label 精确匹配页头开关 — deck 卡片的「评论」入口按钮同名但无 aria-label。
  await waitFor(() => {
    const toggle = [...screen.getAllByRole('button')].find((b) => b.getAttribute('aria-label') === '评论');
    expect(toggle).toBeTruthy();
  });
  const toggle = [...screen.getAllByRole('button')].find((b) => b.getAttribute('aria-label') === '评论')!;
  fireEvent.click(toggle);
  await screen.findByTestId('comments-panel');
}

/** 切到幻灯片视图（页头 SegmentedControl — role=tab）。 */
async function switchToDeckView() {
  const tab = await screen.findByRole('tab', { name: /幻灯片|Slides/ });
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByTestId('deck-comment-entry-1')).toBeTruthy());
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
  apiMock.listDocComments.mockResolvedValue({ comments: [DECK_COMMENT()] });
  apiMock.createDocComment.mockImplementation(async (_docId: string, data: { anchor_text: string; text: string; target?: string; slide_index?: number }) =>
    makeComment({
      id: 'cnew',
      anchor_text: data.anchor_text,
      target: data.target,
      slide_index: data.slide_index,
      replies: [{ id: 'rn', role: 'user', text: data.text, created_at: 't0' }],
    }));
  apiMock.createDocCommentReply.mockImplementation(async (_docId: string, commentId: string, data: { role: string; text: string }) => ({
    id: `reply_${commentId}_${Date.now()}`,
    role: data.role,
    text: data.text,
    created_at: 't1',
  }));
  // #1064 集成收口: AI 回复走专用 ai-replies 入口（参数 (docId, commentId, text)）。
  apiMock.createDocCommentAiReply.mockImplementation(async (_docId: string, commentId: string, text: string) => ({
    id: `aireply_${commentId}_${Date.now()}`,
    role: 'ai',
    text,
    created_at: 't1',
  }));
  apiMock.updateDocComment.mockImplementation(async (_docId: string, commentId: string, status: string) => ({
    ...DECK_COMMENT(),
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

describe('#1051 deck slide 评论（issue 用例表 5 条）', () => {
  /** 用例 1：在 deck 某 slide 上发起评论 → DocComment 带 target/slideIndex/anchorText。 */
  test('deck slide 发起评论：创建请求带 target=deck_slide + 1-based slideIndex + anchorText', async () => {
    renderEditor();
    await screen.findByDisplayValue('Original');
    await switchToDeckView();

    // 第 2 张卡（slideIndex0=1）的「添加评论」
    fireEvent.click(screen.getByTestId('deck-comment-entry-1'));
    const input = await screen.findByTestId('comment-input');
    expect((screen.getByTestId('comment-anchor-preview')).textContent).toContain('方法页');
    fireEvent.change(input, { target: { value: '这页要补随访时长' } });
    fireEvent.click(screen.getByTestId('comment-submit'));

    await waitFor(() => expect(apiMock.createDocComment).toHaveBeenCalledTimes(1));
    const [, payload] = apiMock.createDocComment.mock.calls[0];
    expect(payload.target).toBe('deck_slide');
    expect(payload.slide_index).toBe(2);
    expect(payload.anchor_text).toBe('方法页');
    expect(payload.text).toBe('这页要补随访时长');
  });

  /** 用例 2：deck 视图渲染该评论 — slide 卡片高亮/徽标 + 侧边栏区分正文/deck 来源。 */
  test('渲染区分来源：slide 卡片出现评论高亮，线程列表展示来源徽标', async () => {
    apiMock.listDocComments.mockResolvedValue({ comments: [SECTION_COMMENT(), DECK_COMMENT()] });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await switchToDeckView();

    // deck 视图：slide 2 卡片出现评论高亮标记（联动入口）
    const badge = screen.getByTestId('deck-slide-comments-1');
    expect(badge.getAttribute('data-comment-id')).toBe('cdeck');
    // 点击 → 侧边栏定位/展开线程（联动）
    fireEvent.click(badge);
    await screen.findByTestId('comments-panel');
    const deckThread = screen.getByTestId('comment-thread-cdeck');
    expect(deckThread.getAttribute('data-active')).toBe('true');

    // 侧边栏同时展示正文评论与 deck 评论，来源可区分（deck 徽标）
    expect(screen.getByTestId('comment-thread-csec')).toBeTruthy();
    const deckTag = screen.getByTestId('comment-source-deck');
    expect(deckTag.textContent).toContain('幻灯片');
    // 正文线程无 deck 徽标
    expect(screen.getByTestId('comment-thread-csec').querySelector('[data-testid="comment-source-deck"]')).toBeNull();
  });

  /** 用例 3：对 deck 评论点「请AI处理」→ 指令路由到 edit_deck（含 slide 定位）。 */
  test('请AI处理路由到 deck 编辑：指令含 edit_deck 与 slide_index 定位', async () => {
    turnScripts.push({ deck: { ...DECK, slides: [...DECK.slides] }, answer: '已修改' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-cdeck'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    const opts = apiMock.sendChatFull.mock.calls[0][0];
    expect(opts.text).toContain('edit_deck');
    expect(opts.text).toContain('2');
    expect(opts.text).toContain('方法页');
    expect(opts.text).toContain('这页要补随访时长');
    // 不得误路由到正文编辑指令
    expect(opts.text).not.toContain('edit_document');
  });

  /** 用例 4：AI 处理成功 → AI 回复 + deck slide 更新；deck 写回直接落画布 → 评论 resolved。 */
  test('处理成功：AI 回复入线程，deck 更新并自动 resolved', async () => {
    const nextDeck = {
      ...DECK,
      slides: DECK.slides.map((s, i) => (i === 1 ? { ...s, content: [{ type: 'paragraph', text: '120 例前瞻队列，随访 5 年。', style: 'bullet' }] } : s)),
    };
    turnScripts.push({ deck: nextDeck, answer: '已在第 2 页补充随访时长。' });
    renderEditor();
    await screen.findByDisplayValue('Original');
    await openCommentsPanel();

    fireEvent.click(screen.getByTestId('comment-ai-process-cdeck'));
    // AI 回复入线程（#1064 集成收口：专用 ai-replies 入口，参数 (docId, commentId, text)）
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    expect(apiMock.createDocCommentAiReply.mock.calls[0][2]).toContain('随访');
    // deck 写回直接落画布（#773 无 diff 审阅）→ 评论自动 resolved
    await waitFor(() => expect(apiMock.updateDocComment).toHaveBeenCalledWith(DOC_ID, 'cdeck', 'resolved'));
    // deck 视图呈现更新后的 slide 内容
    await switchToDeckView();
    await waitFor(() => {
      const cards = screen.getAllByRole('textbox');
      expect(cards.some((el) => (el as HTMLInputElement).value.includes('随访 5 年'))).toBe(true);
    });
  });

  /** 用例 5：slide 内容锚点漂移（slide 删除/大改）→ 诊断展示，不崩溃。 */
  test('slide 锚点漂移：待重新定位徽标 + 失败 AI 回复含诊断，不崩溃', async () => {
    apiMock.listDocComments.mockResolvedValue({
      comments: [
        makeComment({
          id: 'cdeck',
          anchor_text: '这页已经被删掉了。',
          target: 'deck_slide',
          slide_index: 9,
          anchor: { located: false },
        }),
      ],
    });
    turnScripts.push({ answer: '好的，我看看。' });
    renderEditor();
    await screen.findByDisplayValue('Original');

    // deck 视图渲染不崩溃（越界 slide_index 的高亮安全跳过）
    await switchToDeckView();
    expect(screen.queryByTestId('deck-slide-comments-1')).toBeNull();

    await openCommentsPanel();
    // 面板：漂移徽标（诊断可见，不静默）
    expect(screen.getByTestId('comment-anchor-drifted')).toBeTruthy();

    // 「请AI处理」→ turn 无写回 → AI 回复说明定位失败（含页码），评论保持 open
    fireEvent.click(screen.getByTestId('comment-ai-process-cdeck'));
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalled());
    const replyText = apiMock.createDocCommentAiReply.mock.calls[0][2] as string;
    expect(replyText).toContain('9');
    expect(apiMock.updateDocComment).not.toHaveBeenCalled();
    await act(async () => {});
  });
});
