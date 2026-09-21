import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
// i18n 实例初始化(与 @/test/render 的 provider 同源) — 不导入则 t() 走
// notReadyT 中文默认值,断言需兼容两种环境。
import i18n from '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

/**
 * #1043 回归网 — deck 与正文分叉冲突解决 UI(路由级)。
 *
 * 覆盖(issue 测试用例表):
 *  1. 本地有未保存 deck 编辑时收到 doc_updated(deck) → 常驻提示条出现且
 *     不自动消失(活过旧实现 6 秒 toast 窗口),两个按钮均可见,本地不被覆盖。
 *  2. 「保留我的编辑」→ 二次确认后本地 deck 成为权威版本(强制落盘一次,
 *     无 base_sha),横幅收口,本地内容仍在。
 *  3. 「使用 AI 的版本」→ 二次确认后本地未保存编辑被丢弃,UI 采用服务端
 *     deck,不发保存请求(服务端已是权威)。
 *  4. 本地无未保存编辑时收到 doc_updated(deck) → 静默换源,无冲突提示,
 *     不发保存请求(不回归现有行为)。
 *
 * 驱动方式与 writing-editor.writeback.test.tsx 一致:真实 chat store +
 * 真实路由 effect + 真实 DeckView,仅 mock 网络层 @/lib/api。
 * deck 走 ?view=deck 直达 Slides 视图,本地编辑经 DeckView 标题输入触发。
 */

// TipTap needs a real selection API in jsdom(同 doc-editor.test.tsx)。
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
  // #1040: 评论 API mock(路由挂载期拉取列表,不 mock 会 TypeError)。
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
const BASE_BODY = 'Base';
const BASE_DECK = {
  title: 'Deck',
  slides: [{ title: 'Slide A', content: [{ type: 'paragraph', text: 'a1', style: 'bullet' }] }],
};
const AI_DECK = {
  title: 'Deck',
  slides: [{ title: 'AI Slide', content: [{ type: 'paragraph', text: 'a2', style: 'bullet' }] }],
};
const BASE_DOC = {
  id: DOC_ID,
  title: 'Original',
  body: BASE_BODY,
  deck: BASE_DECK,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: null,
  study_name: null,
};

/** 每轮 chat turn 的 doc_updated 写回脚本(rev 单调 = 服务端写回序)。 */
type Write = { body: string; rev: number; title?: string; deck?: unknown };
const turnScripts: Write[][] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const writes = turnScripts.shift() ?? [];
    // chunk 间跨宏任务发射 — 全同步流会在 loading=true 渲染前跑完,
    // 路由的冲刷 effect(true→false 沿)就永远看不到 turn 边界。
    for (const w of writes) {
      await new Promise((r) => setTimeout(r, 10));
      yield {
        type: 'doc_updated',
        body: w.body,
        rev: w.rev,
        ...(w.title ? { title: w.title } : {}),
        ...(w.deck ? { deck: w.deck } : {}),
      };
    }
    await new Promise((r) => setTimeout(r, 10));
    yield { type: 'final_answer_chunk', text: 'ok' };
    yield { type: 'turn_complete' };
  });
}

/**
 * 发起一轮 chat turn 并等待流结束。store 发送**不能包进 act** — act 会把
 * 整个 turn 合并成一次渲染,路由冲刷 effect 依赖的 loading true→false 沿
 * 就永远看不到(生产里 SSE 流天然跨宏任务,不存在该合并)。
 */
async function sendTurn(writes: Write[]) {
  turnScripts.push(writes);
  void useChatStore.getState().sendMessageQueued(SESSION, {
    text: '下一轮修改',
    sessionId: SESSION,
    patientHash: null,
    skills: [],
    attachments: [],
    scene: 'document',
  });
  await waitFor(() => {
    expect(useChatStore.getState().sessions[SESSION]?.loading).toBe(false);
  });
  // 留出真实宏任务:turn 结束的冲刷渲染 / deck 消费 effect。
  await new Promise((r) => setTimeout(r, 40));
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={[`/app/writing/${DOC_ID}?view=deck`]}>
      <Routes>
        <Route path="/app/writing/:docId" element={<WritingEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 冲突横幅专属锚点 — 旧实现仅 6 秒 toast(无 testid),须区分。 */
const deckConflictBanner = () => screen.queryByTestId('deck-conflict-banner');

/** 装载文档(带 deck)→ 本地做一处未保存的 slide 标题编辑。 */
async function setupConflict() {
  renderEditor();
  const titleInput = await screen.findByDisplayValue('Slide A');
  fireEvent.change(titleInput, { target: { value: 'Slide A (edited)' } });
  expect(screen.getByDisplayValue('Slide A (edited)')).toBeTruthy();
  return titleInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  // #996/#1000: viewMode 初始化读 window.location.search(非 router location) —
  // MemoryRouter initialEntries 不生效,须直接 pushState 到带 ?view=deck 的地址。
  window.history.pushState({}, '', `/app/writing/${DOC_ID}?view=deck`);
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  apiMock.getDoc.mockResolvedValue(BASE_DOC);
  apiMock.updateDoc.mockResolvedValue({ ...BASE_DOC, updated_at: '2026-01-03T00:00:00Z' });
  // 快照探测恢复空 — 不触发 #837 刷新恢复审阅。
  apiMock.getDocSnapshots.mockResolvedValue({ snapshots: [] });
  apiMock.getSnapshotBody.mockResolvedValue({ id: 's1', created_at: '', label: '', body: BASE_BODY });
  apiMock.listSubmissionDrafts.mockResolvedValue({ drafts: [] });
  apiMock.listDocComments.mockResolvedValue({ comments: [] });
  apiMock.getDocReferences.mockResolvedValue({ references: [] });
  apiMock.getMessages.mockResolvedValue({ messages: [], total: 0 });
  apiMock.listSkills.mockResolvedValue({ skills: [] });
  mockTurns();
  turnScripts.length = 0;
  useChatStore.setState({ sessions: {} });
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as never);
});

afterEach(() => {
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
  cleanup();
});

describe('#1043 deck/正文分叉冲突解决 UI', () => {
  test('用例 1:本地有未保存 deck 编辑时收到 doc_updated(deck) → 常驻提示条,不自动消失,两按钮可见', async () => {
    await setupConflict();

    await sendTurn([{ body: BASE_BODY, rev: 1, deck: AI_DECK }]);

    // 常驻提示条 + 两个明确按钮;旧 6 秒 toast 文案不再出现。
    expect(await screen.findByTestId('deck-conflict-banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Keep my edits|保留我的编辑/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use AI's version|使用 AI 的版本/ })).toBeTruthy();
    expect(screen.queryByText(/建议先放弃本地画布修改/)).toBeNull();

    // #1066-11: 此前睡 6.1s 验证「活过旧 6 秒 toast TTL」— 横幅是状态驱动
    // 结构渲染(deckConflict 未清空就常驻,无 TTL),结构断言已足够;仍需等待
    // 的时序语义只剩「autosave 暂停」— autosave 防抖 2.5s,若守卫回归会在
    // 冲突到达后 ~2.5s 落盘,故等 3.1s(越过防抖 + 余量)而非 1s(防抖未过,
    // updateDoc 断言会变空洞)。不用 fake timers:本文件 sendTurn/waitFor
    // 全链路依赖真实宏任务流,混用会破坏 turn 边界。
    // 冲突未决期间 autosave 不得擅自落盘(暂停),本地编辑不被覆盖。
    await new Promise((r) => setTimeout(r, 3100));
    expect(deckConflictBanner()).toBeTruthy();
    expect(screen.getByDisplayValue('Slide A (edited)')).toBeTruthy();
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  }, 15000);

  test('用例 2:「保留我的编辑」→ 二次确认后本地 deck 强制落盘一次,成为权威版本', async () => {
    await setupConflict();
    await sendTurn([{ body: BASE_BODY, rev: 1, deck: AI_DECK }]);
    fireEvent.click(await screen.findByRole('button', { name: /Keep my edits|保留我的编辑/ }));

    // 二次确认(不可逆提示)— 未确认前不落盘。
    const confirmBtn = await screen.findByRole('button', { name: /Confirm keep|确认保留/ });
    expect(apiMock.updateDoc).not.toHaveBeenCalled();

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(1));
    const [, call] = apiMock.updateDoc.mock.calls[0];
    // force 覆盖(无 base_sha),deck 为本地编辑版而非 AI 版。
    expect(call).toMatchObject({ force: true, body: BASE_BODY });
    expect(call).not.toHaveProperty('base_sha');
    expect(call.deck).toEqual({
      ...BASE_DECK,
      slides: [{ ...BASE_DECK.slides[0], title: 'Slide A (edited)' }],
    });
    await waitFor(() => expect(deckConflictBanner()).toBeNull());
    // 本地编辑仍在(未被 AI 版覆盖)。
    expect(screen.getByDisplayValue('Slide A (edited)')).toBeTruthy();
  }, 15000);

  test('用例 3:「使用 AI 的版本」→ 二次确认后丢弃本地编辑、采用服务端 deck,不发保存', async () => {
    await setupConflict();
    await sendTurn([{ body: BASE_BODY, rev: 1, deck: AI_DECK }]);
    fireEvent.click(await screen.findByRole('button', { name: /Use AI's version|使用 AI 的版本/ }));

    // 二次确认(不可逆提示)— 未确认前不换源。
    const confirmBtn = await screen.findByRole('button', { name: /Confirm use|确认采用/ });
    expect(screen.getByDisplayValue('Slide A (edited)')).toBeTruthy();

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(screen.getByDisplayValue('AI Slide')).toBeTruthy());
    expect(screen.queryByDisplayValue('Slide A (edited)')).toBeNull();
    await waitFor(() => expect(deckConflictBanner()).toBeNull());
    // 服务端已是该版本 — 不再发保存请求。
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  }, 15000);

  test('用例 4:本地无未保存编辑时收到 doc_updated(deck) → 静默换源,无冲突提示', async () => {
    renderEditor();
    await screen.findByDisplayValue('Slide A');

    await sendTurn([{ body: BASE_BODY, rev: 1, deck: AI_DECK }]);

    await waitFor(() => expect(screen.getByDisplayValue('AI Slide')).toBeTruthy());
    expect(deckConflictBanner()).toBeNull();
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  }, 15000);

  test('用例 5(#1066-3):冲突未决时手动保存被拦截且给出提示,不再静默 return', async () => {
    await setupConflict();
    await sendTurn([{ body: BASE_BODY, rev: 1, deck: AI_DECK }]);
    await screen.findByTestId('deck-conflict-banner');

    // 点击 Save 前,冲突文案只出现 1 处(横幅自身),无 toast。
    expect(screen.getAllByText(/画布冲突 — AI 已更新服务端画布/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /未保存|Save/ }));

    // #1066-3: 保存被拦但有反馈 — 提示条复用冲突文案,出现第 2 处;
    // 且绝不落盘(决策必须经横幅)。
    await waitFor(() => expect(screen.getAllByText(/画布冲突 — AI 已更新服务端画布/)).toHaveLength(2));
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  }, 15000);
});
