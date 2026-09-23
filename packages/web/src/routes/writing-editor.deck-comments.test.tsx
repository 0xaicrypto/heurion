/**
 * #1051/#1112/#1113 — deck slide 评论（卡片流退役后的画布形态，web 侧）。
 *
 * 覆盖：
 * - 创建入口：画布头部「添加幻灯片评论」→ target='deck_slide' + 1-based
 *   slide_index + anchorText（卡片流按钮退役后的迁移入口）；
 * - 「请AI处理」路由到 edit_deck_bytes 指令（含 slide_index 定位）；
 * - turn 收口按工件版本变化判定成败（#1113：edit_deck_bytes 写回实时落地
 *   画布 + 整轮撤销；旧 #1088 每评论快照/确认按钮机制退役）。
 *
 * Mock 策略与 writing-editor.comment-ai.test.tsx 同口径（mock @/lib/api +
 * sendChatFull turn 脚本）。
 */
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// 画布依赖的可视化 viewer 在 jsdom 无意义 — stub 掉（本套件只测评论链路）。
vi.mock('pptx-react-viewer', () => ({ PowerPointViewer: () => null }));

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
  listDocCitations: vi.fn().mockResolvedValue({ citations: [] }),
  listDocComments: vi.fn(),
  createDocComment: vi.fn(),
  createDocCommentReply: vi.fn(),
  createDocCommentAiReply: vi.fn(),
  updateDocComment: vi.fn(),
  getDeckArtifact: vi.fn(),
  putDeckArtifact: vi.fn(),
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
const BASE_BODY = '## Intro\n\n正文。';
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

type TurnScript = { deckVersion?: string; answer?: string };
const turnScripts: TurnScript[] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const script = turnScripts.shift() ?? {};
    await new Promise((r) => setTimeout(r, 10));
    yield {
      type: 'doc_updated',
      body: BASE_BODY,
      rev: 1,
      ...(script.deckVersion ? { deck: DECK, deck_version: script.deckVersion, deck_artifact_id: script.deckVersion } : {}),
    };
    await new Promise((r) => setTimeout(r, 10));
    yield { type: 'final_answer_chunk', text: script.answer ?? 'ok' };
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
  await waitFor(() => {
    const toggle = [...screen.getAllByRole('button')].find((b) => b.getAttribute('aria-label') === '评论');
    expect(toggle).toBeTruthy();
  });
  const toggle = [...screen.getAllByRole('button')].find((b) => b.getAttribute('aria-label') === '评论')!;
  fireEvent.click(toggle);
  await screen.findByTestId('comments-panel');
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
  apiMock.createDocCommentAiReply.mockImplementation(async (_docId: string, commentId: string, text: string) => ({
    id: `aireply_${commentId}_${Date.now()}`,
    role: 'ai',
    text,
    created_at: 't1',
  }));
  apiMock.updateDocComment.mockImplementation(async (_docId: string, commentId: string, status?: string) => ({
    ...DECK_COMMENT(),
    id: commentId,
    status,
    resolved_at: status === 'resolved' ? '2026-01-03T00:00:00Z' : null,
  }));
  // 画布装载：无工件 → missing 态（本套件只测页头评论链路，不渲染 viewer）。
  apiMock.getDeckArtifact.mockRejectedValue(Object.assign(new Error('no artifact'), { status: 404 }));
  mockTurns();
  turnScripts.length = 0;
  useChatStore.setState({ sessions: {} });
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as never);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** 切到幻灯片视图（页头 SegmentedControl — role=tab）。 */
async function switchToDeckView() {
  const tab = await screen.findByRole('tab', { name: /幻灯片|Slides/ });
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByTestId('deck-rich-edit-root')).toBeTruthy());
}

describe('#1051/#1112 deck slide 评论（画布形态）', () => {
  test('画布头部「添加幻灯片评论」→ 创建请求带 target=deck_slide + 1-based slide_index', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('2');
    renderEditor();
    await switchToDeckView();

    fireEvent.click(screen.getByTestId('deck-add-comment'));
    // 页码 → 打开既有评论弹窗（anchorText 自动为「第 2 页」）→ 输入意见提交。
    const input = await screen.findByTestId('comment-input');
    fireEvent.change(input, { target: { value: '这页要补随访时长' } });
    fireEvent.click(screen.getByTestId('comment-submit'));
    await waitFor(() => expect(apiMock.createDocComment).toHaveBeenCalledTimes(1));
    const [, payload] = apiMock.createDocComment.mock.calls[0];
    expect(payload).toMatchObject({ target: 'deck_slide', slide_index: 2, anchor_text: '第 2 页' });
    promptSpy.mockRestore();
  });

  test('deck 评论「请AI处理」→ 指令含 edit_deck_bytes 与 1-based 页码定位', async () => {
    renderEditor();
    await openCommentsPanel();
    const btn = await screen.findByTestId('comment-ai-process-cdeck');
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    const [opts] = apiMock.sendChatFull.mock.calls[0];
    expect(opts.text).toContain('edit_deck_bytes');
    expect(opts.text).toContain('第 2 页');
    expect(opts.text).toContain('方法页');
  });

  test('#1113 收口：工件版本变化 = 成功 AI 回复（撤销由画布整轮撤销承接）', async () => {
    turnScripts.push({ deckVersion: 'deck-v2' });
    renderEditor();
    await openCommentsPanel();
    fireEvent.click(await screen.findByTestId('comment-ai-process-cdeck'));
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [, , text] = apiMock.createDocCommentAiReply.mock.calls[0];
    // 成功路径不得是失败说明（落后一步的 (version) 收口会走 commentFailReply）。
    expect(text).not.toContain('未能自动处理');
    // 不再有每评论确认/撤销按钮（#1088 机制退役）。
    expect(screen.queryByTestId('comment-deck-confirm-cdeck')).not.toBeInTheDocument();
  });

  test('#1113 收口：版本未变化 = 失败说明（评论保持 open 可重试）', async () => {
    turnScripts.push({ answer: '本轮没有修改' });
    renderEditor();
    await openCommentsPanel();
    fireEvent.click(await screen.findByTestId('comment-ai-process-cdeck'));
    await waitFor(() => expect(apiMock.createDocCommentAiReply).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [, , text] = apiMock.createDocCommentAiReply.mock.calls[0];
    expect(text).toContain('未能自动处理');
  });

  test('#review-2 正文保存不携带本地 deck 镜像（画布保存不被旧投影覆盖）', { timeout: 10_000 }, async () => {
    renderEditor();
    const title = await screen.findByPlaceholderText('Document title');
    fireEvent.change(title, { target: { value: 'New title' } });
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalled(), { timeout: 8000 });
    const [, payload] = apiMock.updateDoc.mock.calls.at(-1)!;
    expect(payload).not.toHaveProperty('deck');
    expect(payload.body).toBe(BASE_BODY);
  });

  test('漂移锚点仍可发起：指令注明可能漂移，不崩溃', async () => {
    apiMock.listDocComments.mockResolvedValue({
      comments: [makeComment({
        id: 'cdeck',
        anchor_text: '已漂移的页标题',
        target: 'deck_slide',
        slide_index: 2,
        anchor: { located: false, candidates: [{ text: '方法页', start: 10, heading: '方法页', similarity: 0.8 }] },
      })],
    });
    renderEditor();
    await openCommentsPanel();
    fireEvent.click(await screen.findByTestId('comment-ai-process-cdeck'));
    await waitFor(() => expect(apiMock.sendChatFull).toHaveBeenCalledTimes(1));
    const [opts] = apiMock.sendChatFull.mock.calls[0];
    expect(opts.text).toContain('可能已在幻灯片中漂移');
  });
});
