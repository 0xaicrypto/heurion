import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
// i18n 实例初始化(与 @/test/render 的 provider 同源) — 不导入则 t() 走
// notReadyT 中文默认值,断言需兼容两种环境。
import '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { sha1Hex } from '@/lib/hash';

/**
 * #926 回归网 — writing-editor 写回编排(路由级)。
 *
 * 覆盖(真实 chat store + 真实路由 effect + 真实 DocEditor 审阅 UI,
 * 仅 mock 网络层 @/lib/api):
 *  - flushPendingWriteBack 三分支:无审阅直接开审阅 / 审阅打开时跨轮入队 /
 *    队尾重放(popNextWriteBack 三路合并后再进审阅)。
 *  - #882 并发保存 409(stale_base)→ saveConflict 横幅 → KeepMine(force)
 *    / LoadLatest(拉最新 + diff 审阅确认,不再发保存请求)两分支。
 *  - #927 doc_updated rev 幂等守卫:乱序旧 rev 经路由级写回消费 effect 被
 *    忽略、不产生新写回批次;更高 rev 正常入队(对照组证明可抓回归)。
 *  - #895 守卫:审阅未决时 autosave 不排定时器、手动 Save 不发保存请求。
 *
 * 驱动方式与 stores/chat.test.ts 的 SSE 主链路 mock 模式一致:
 * useChatStore.sendMessageQueued → store 记录 lastDocBody/lastDocRev →
 * 路由级 consumption effect 消费 → turn 结束(loading true→false)冲刷。
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
const BASE_DOC = {
  id: DOC_ID,
  title: 'Original',
  body: BASE_BODY,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: null,
  study_name: null,
};

/** 每轮 chat turn 的 doc_updated 写回脚本(rev 单调 = 服务端写回序)。 */
type Write = { body: string; rev: number };
const turnScripts: Write[][] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const writes = turnScripts.shift() ?? [];
    // chunk 间跨宏任务发射 — 全同步流会在 loading=true 渲染前跑完,
    // 路由的冲刷 effect(true→false 沿)就永远看不到 turn 边界。
    for (const w of writes) {
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: w.body, rev: w.rev };
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
  // 留出真实宏任务:turn 结束的冲刷渲染 / DocEditor 审阅应用。
  await new Promise((r) => setTimeout(r, 40));
  await act(async () => {});
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

const editorText = (container: HTMLElement) => container.querySelector('.ProseMirror')?.textContent ?? '';
/** #882 冲突横幅的专属锚点 — 同文案也会出现在 header 轻提示(无 ⚠ 前缀),须区分。 */
const conflictBanner = /⚠ .*(modified in another window|文档已在其他窗口被修改)/;

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  apiMock.getDoc.mockResolvedValue(BASE_DOC);
  apiMock.updateDoc.mockResolvedValue({ ...BASE_DOC, updated_at: '2026-01-03T00:00:00Z' });
  // 快照探测恢复空 — 不触发 #837 刷新恢复审阅。
  apiMock.getDocSnapshots.mockResolvedValue({ snapshots: [] });
  apiMock.getSnapshotBody.mockResolvedValue({ id: 's1', created_at: '', label: '', body: BASE_BODY });
  apiMock.listSubmissionDrafts.mockResolvedValue({ drafts: [] });
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
  cleanup();
});

describe('#926 flushPendingWriteBack 三分支(路由级编排)', () => {
  test('分支 1:无审阅时 turn 结束直接开审阅(doc_updated → diffReview)', async () => {
    const { container } = renderEditor();
    await screen.findByDisplayValue('Original');

    await sendTurn([{ body: `${BASE_BODY}\n\nR1 段落`, rev: 1 }]);

    // 冲刷后进入审阅:审阅横幅出现,写回内容在编辑器中以变更标记可见。
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();
    await waitFor(() => expect(editorText(container)).toContain('R1 段落'));
    // 审阅未决 — 不得静默落盘(#553 写回必经审阅)。
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  });

  test('分支 2:审阅打开时跨轮写回入队(横幅计数 + 排队提示)', async () => {
    const { container } = renderEditor();
    await screen.findByDisplayValue('Original');

    await sendTurn([{ body: `${BASE_BODY}\n\nR1 段落`, rev: 1 }]);
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();

    // 审阅未决时新写回到达 → 不顶掉当前审阅,入累计队列。
    await sendTurn([{ body: `${BASE_BODY}\n\nR2 段落`, rev: 2 }]);

    expect(await screen.findByText(/another round of edits|又完成了一轮修改/)).toBeTruthy();
    // #837-ux: 队列轮数徽章。
    expect(await screen.findByText('还有 1 轮排队')).toBeTruthy();
    // 当前审阅仍是第 1 轮内容,未被覆盖。
    expect(editorText(container)).toContain('R1 段落');
    expect(editorText(container)).not.toContain('R2 段落');
  });

  test('分支 3:队尾重放 — 当前审阅结束后三路合并弹出下一轮,接受后落盘', async () => {
    const { container } = renderEditor();
    await screen.findByDisplayValue('Original');

    await sendTurn([{ body: `${BASE_BODY}\n\nR1 段落`, rev: 1 }]);
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();
    await sendTurn([{ body: `${BASE_BODY}\n\nR2 段落`, rev: 2 }]);
    expect(await screen.findByText('还有 1 轮排队')).toBeTruthy();

    // 接受第 1 轮 → 落盘保存 → popNextWriteBack 以本轮正文为基线重放队列。
    await waitFor(() => expect(screen.getByRole('button', { name: /全部接受/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /全部接受/ }));
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(1));
    expect(apiMock.updateDoc.mock.calls[0][1].body).toContain('R1 段落');

    // 下一轮审阅自动呈现(队列余 0,无排队提示;remaining>0 才提示) —
    // 重放 diff 的插入侧(R2)在编辑器中以变更标记可见。
    await waitFor(() => expect(editorText(document.body)).toContain('R2 段落'));
    expect(screen.getByText('审阅 AI 修改')).toBeTruthy();

    // 接受重放轮 → 落盘合并结果,审阅全部结束。
    await waitFor(() => expect(screen.getByRole('button', { name: /全部接受/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /全部接受/ }));
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(2));
    expect(apiMock.updateDoc.mock.calls[1][1].body).toContain('R2 段落');
    await waitFor(() => expect(screen.queryByText('审阅 AI 修改')).toBeNull());
    expect(editorText(container)).toContain('R2 段落');
  });
});

describe('#882 并发保存 409 → saveConflict 横幅两分支', () => {
  async function triggerConflict() {
    renderEditor();
    await screen.findByDisplayValue('Original');
    const { ApiError } = await import('@/lib/api');
    apiMock.updateDoc.mockRejectedValueOnce(new (ApiError as any)('stale base', { status: 409, code: 'stale_base' }));
    fireEvent.change(screen.getByPlaceholderText('Document title'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save|Unsaved|未保存/ }));
    expect(await screen.findByText(conflictBanner)).toBeTruthy();
    // 首次保存带 base_sha 指纹(服务端视角正文 = 初始 Base)。
    expect(apiMock.updateDoc).toHaveBeenCalledTimes(1);
    expect(apiMock.updateDoc.mock.calls[0][1].base_sha).toBe(await sha1Hex(BASE_BODY));
  }

  test('KeepMine:force 覆盖(无 base_sha),横幅收口', async () => {
    await triggerConflict();

    fireEvent.click(screen.getByRole('button', { name: /Keep mine|保留我的版本/ }));
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(2));
    const [, forceCall] = apiMock.updateDoc.mock.calls[1];
    expect(forceCall).toMatchObject({ title: 'Changed', body: BASE_BODY, force: true });
    expect(forceCall).not.toHaveProperty('base_sha');
    await waitFor(() => expect(screen.queryByText(conflictBanner)).toBeNull());
  });

  test('LoadLatest:拉最新进 diff 审阅确认,采用服务端版本且不再发保存请求', async () => {
    await triggerConflict();
    apiMock.getDoc.mockResolvedValueOnce({ ...BASE_DOC, body: 'Server latest', updated_at: '2026-01-04T00:00:00Z' });

    fireEvent.click(screen.getByRole('button', { name: /Load latest|载入最新/ }));
    // 本地未保存内容与服务端最新进 diff 审阅(#927 语义)。
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();
    await waitFor(() => expect(editorText(document.body)).toContain('Server latest'));
    await waitFor(() => expect(screen.getByRole('button', { name: /全部接受/ })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /全部接受/ }));
    // 服务端已是最新 — 直接采用,不再 PUT。
    expect(await screen.findByText(/Loaded the latest server content|已载入服务端最新内容/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(conflictBanner)).toBeNull());
    expect(apiMock.getDoc).toHaveBeenCalledTimes(2);
    expect(apiMock.updateDoc).toHaveBeenCalledTimes(1);
  });
});

describe('#927 doc_updated rev 幂等守卫(路由级 consumption effect)', () => {
  test('乱序旧 rev 不产生新写回批次;更高 rev 正常入队(对照组)', async () => {
    renderEditor();
    await screen.findByDisplayValue('Original');

    // rev 5 写回 → 审阅打开,appliedDocRev 基线 = 5。
    await sendTurn([{ body: `${BASE_BODY}\n\nV5`, rev: 5 }]);
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();

    // SSE 乱序/重放:rev 4(旧于已应用)→ 守卫必须忽略。
    await sendTurn([{ body: 'Stale V4', rev: 4 }]);
    await act(async () => {});
    expect(screen.queryByText(/another round of edits|又完成了一轮修改/)).toBeNull();
    expect(screen.queryByText('还有 1 轮排队')).toBeNull();

    // 对照组:rev 6(> 5)→ 守卫放行 → 审阅打开时入队。
    await sendTurn([{ body: `${BASE_BODY}\n\nV6`, rev: 6 }]);
    expect(await screen.findByText(/another round of edits|又完成了一轮修改/)).toBeTruthy();
    expect(await screen.findByText('还有 1 轮排队')).toBeTruthy();
  });
});

describe('#895 审阅未决时保存守卫', () => {
  test('autosave 不排定时器、手动 Save 不发保存请求(守卫前对照:正常 autosave 可发)', async () => {
    renderEditor();
    await screen.findByDisplayValue('Original');

    // 对照:无审阅时 autosave 正常触发(证明 harness 能抓到守卫失效)。
    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Document title'), { target: { value: 'A1' } });
    await act(async () => {
      vi.advanceTimersByTime(3000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(apiMock.updateDoc).toHaveBeenCalledTimes(1);
    expect(apiMock.updateDoc.mock.calls[0][1]).toMatchObject({ title: 'A1', body: BASE_BODY });
    vi.useRealTimers();

    // turn 结束进入审阅 → 审阅未决。
    await sendTurn([{ body: `${BASE_BODY}\n\nR1 段落`, rev: 1 }]);
    expect(await screen.findByText('审阅 AI 修改')).toBeTruthy();

    // dirty 状态下推进超过 autosave 阈值:守卫必须让定时器根本不排。
    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Document title'), { target: { value: 'A2' } });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(apiMock.updateDoc).toHaveBeenCalledTimes(1);
    // 手动 Save 同样被守卫拦截。
    fireEvent.click(screen.getByRole('button', { name: /Save|Unsaved|未保存/ }));
    expect(apiMock.updateDoc).toHaveBeenCalledTimes(1);
  });
});
