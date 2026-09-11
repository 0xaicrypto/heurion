import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams, useNavigate } from 'react-router-dom';
// i18n 实例初始化(与 @/test/render 的 provider 同源) — 不导入则 t() 走
// notReadyT 中文默认值,断言需兼容两种环境。
import '@/i18n';
import { WritingEditorPage } from './writing-editor';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { sha1Hex } from '@/lib/hash';
// #979: 源级接线守卫 — App.tsx 原文经 Vite ?raw 导入(避免 node fs 依赖,
// web 包 tsc 无 node types)。
import appSrc from '../App.tsx?raw';

/**
 * #979/#983 回归网 — writing-editor 路由守卫与统一写回心智模型。
 *
 * #979: /app/writing/:docId 路由 key={docId}(App.tsx WritingEditorRoute) —
 *  切文档重挂载,写状态(diffReview/saveConflict/审阅队列)天然清零;组件内
 *  双保险 effect 在 key 失效时仍强制清空。测试两条路径各自可抓回归。
 * #983: generateMethods/injectResults 不再绕过 diff-review/冲突检测 —
 *  生成 Methods 进审阅(接受才落盘);注入结果三路合并应用增量,后续
 *  autosave 的 base_sha 指纹正确(409 冲突检测可用,绝不静默覆盖)。
 */

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

// #979 被测对象 = App.tsx 的路由包装(key={docId})。App.tsx 不整包导入
// (会拉起全部路由模块图),这里按同一语义复刻 + 源级断言锁 App.tsx 接线。
function KeyedRoute() {
  const { docId } = useParams<{ docId: string }>();
  return <WritingEditorPage key={docId ?? 'none'} />;
}

const DOC_A = {
  id: 'd1',
  title: 'A doc',
  body: 'A body',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: 'st1',
  study_name: 'Study A',
};
const DOC_B = {
  id: 'd2',
  title: 'B doc',
  body: 'B body',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: 'st1',
  study_name: 'Study B',
};

const SESSION_A = 'doc-d1';
type Write = { body: string; rev: number };
const turnScripts: Write[][] = [];

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const writes = turnScripts.shift() ?? [];
    for (const w of writes) {
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'doc_updated', body: w.body, rev: w.rev };
    }
    await new Promise((r) => setTimeout(r, 10));
    yield { type: 'final_answer_chunk', text: 'ok' };
    yield { type: 'turn_complete' };
  });
}

async function sendTurn(writes: Write[]) {
  turnScripts.push(writes);
  void useChatStore.getState().sendMessageQueued(SESSION_A, {
    text: '下一轮修改',
    sessionId: SESSION_A,
    patientHash: null,
    skills: [],
    attachments: [],
    scene: 'document',
  });
  await waitFor(() => {
    expect(useChatStore.getState().sessions[SESSION_A]?.loading).toBe(false);
  });
  await new Promise((r) => setTimeout(r, 40));
  await act(async () => {});
}

function Nav() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/app/writing/d2')}>go-d2</button>;
}

function renderEditor(keyed: boolean) {
  return render(
    <MemoryRouter initialEntries={['/app/writing/d1']}>
      <Routes>
        <Route path="/app/writing/:docId" element={keyed ? <KeyedRoute /> : <WritingEditorPage />} />
      </Routes>
      <Nav />
    </MemoryRouter>,
  );
}

const editorText = (container: HTMLElement) => container.querySelector('.ProseMirror')?.textContent ?? '';
const reviewBanner = () => screen.queryByText(/Review AI changes|审阅 AI 修改/);

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
  apiMock.getDoc.mockImplementation((docId: string) =>
    Promise.resolve(docId === 'd1' ? DOC_A : DOC_B));
  apiMock.updateDoc.mockResolvedValue({ ...DOC_A, updated_at: '2026-01-03T00:00:00Z' });
  apiMock.getDocSnapshots.mockResolvedValue({ snapshots: [] });
  apiMock.getSnapshotBody.mockResolvedValue({ id: 's1', created_at: '', label: '', body: 'A body' });
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

describe('#979 切换文档写状态清零(路由 key 重挂载)', () => {
  test('key={docId}: A 文档审阅未决 → 切到 B 文档,审阅横幅不再残留', async () => {
    renderEditor(true);
    await screen.findByDisplayValue('A doc');

    // A 文档:AI 写回进入审阅(未决)
    await sendTurn([{ body: 'A body\n\nA 未接受段落', rev: 1 }]);
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();

    // 切到 B 文档 — key 变化重挂载,A 的审阅/未接受内容不得串染
    fireEvent.click(screen.getByRole('button', { name: 'go-d2' }));
    await screen.findByDisplayValue('B doc');
    expect(reviewBanner()).toBeNull();
    await waitFor(() => expect(editorText(document.body)).toContain('B body'));
    expect(editorText(document.body)).not.toContain('A 未接受段落');
    // 未发任何保存请求(A 的审阅未接受,B 未编辑)
    expect(apiMock.updateDoc).not.toHaveBeenCalled();
  });

  test('双保险 effect(无 key 兜底): key 失效时切文档仍清空审阅', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');
    await sendTurn([{ body: 'A body\n\nA 未接受段落', rev: 1 }]);
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'go-d2' }));
    await screen.findByDisplayValue('B doc');
    await waitFor(() => expect(reviewBanner()).toBeNull());
  });

  test('App.tsx 源级接线守卫: 路由 element 使用带 key 的 WritingEditorRoute', () => {
    const src = appSrc;
    expect(src).toMatch(/function WritingEditorRoute\(\)/);
    expect(src).toMatch(/<WritingEditorPage key=\{docId/);
    // /app/writing/:docId 路由 element 挂的是 WritingEditorRoute 而非裸页面
    expect(src).toMatch(/path="\/app\/writing\/:docId"[\s\S]{0,200}<WritingEditorRoute \/>/);
  });
});

describe('#983 生成/注入走统一写回流程', () => {
  test('生成 Methods → 进 diff 审阅(不直接落盘),接受才保存', async () => {
    const { container } = renderEditor(false);
    await screen.findByDisplayValue('A doc');
    apiMock.generateMethods.mockResolvedValue({ methods: 'Generated Methods text' });

    fireEvent.click(screen.getByRole('button', { name: /生成方法|Generate Methods/ }));

    // 生成结果进审阅,编辑器以变更标记可见;未接受前不得落盘
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();
    await waitFor(() => expect(editorText(container)).toContain('Generated Methods text'));
    expect(apiMock.updateDoc).not.toHaveBeenCalled();

    // 接受 → saveDoc 落盘(带 base_sha 冲突检测指纹)
    await waitFor(() => expect(screen.getByRole('button', { name: /全部接受|Accept all/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /全部接受|Accept all/ }));
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(1));
    expect(apiMock.updateDoc.mock.calls[0][1].body).toContain('## Methods');
    expect(apiMock.updateDoc.mock.calls[0][1].body).toContain('Generated Methods text');
    expect(apiMock.updateDoc.mock.calls[0][1].base_sha).toBe(await sha1Hex('A body'));
  });

  test('注入结果 → 三路合并应用增量(编辑器含注入块),autosave base_sha 指纹正确', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');
    const injected = 'A body\n\n## Overall survival\n\nHR 0.7 (95% CI 0.5-0.9)';
    apiMock.injectResults.mockResolvedValue({ ok: true });
    // 注入后服务端正文(第二次 getDoc)
    apiMock.getDoc
    // 注入路径的 getDoc(此次测试内第 2 次调用;加载期第 1 次走默认 mock)
    apiMock.getDoc
      .mockResolvedValueOnce({ ...DOC_A, body: injected, updated_at: '2026-01-05T00:00:00Z' });

    fireEvent.click(screen.getByRole('button', { name: /注入结果|Inject Results/ }));
    fireEvent.change(screen.getByPlaceholderText(/小节标题|Section label/), { target: { value: 'Overall survival' } });
    fireEvent.change(screen.getByPlaceholderText(/统计输出|stat output/), { target: { value: '{"p":0.012}' } });
    fireEvent.click(screen.getByRole('button', { name: /^注入$|^Inject$/ }));
    await new Promise((r) => setTimeout(r, 120));

    // 编辑器展示注入后的正文(不再拉旧整篇覆盖后丢服务端增量)
    await waitFor(() => expect(editorText(document.body)).toContain('Overall survival'));

    // autosave(2.5s debounce)触发:body = 注入后正文,base_sha = 服务端新
    // 指纹 — 若仍是旧代码的「拉最新整篇覆盖 + 旧基线」,这里指纹不会同步。
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(1), { timeout: 6000 });
    expect(apiMock.updateDoc.mock.calls[0][1]).toMatchObject({ body: injected });
    expect(apiMock.updateDoc.mock.calls[0][1].base_sha).toBe(await sha1Hex(injected));
    vi.useRealTimers();
  });

  test('守卫: 审阅未决时生成/注入被拦截,不触发 API 调用', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');
    await sendTurn([{ body: 'A body\n\nR1 段落', rev: 1 }]);
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();

    // 生成被拦截
    apiMock.generateMethods.mockResolvedValue({ methods: 'x' });
    fireEvent.click(screen.getByRole('button', { name: /生成方法|Generate Methods/ }));
    expect(screen.getByText(/请先完成当前 AI 修改的审阅|Finish reviewing the current AI changes/)).toBeTruthy();
    expect(apiMock.generateMethods).not.toHaveBeenCalled();

    // 注入被拦截
    apiMock.injectResults.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /注入结果|Inject Results/ }));
    fireEvent.change(screen.getByPlaceholderText(/小节标题|Section label/), { target: { value: 'L' } });
    fireEvent.change(screen.getByPlaceholderText(/统计输出|stat output/), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /^注入$|^Inject$/ }));
    expect(apiMock.injectResults).not.toHaveBeenCalled();
    expect(screen.getAllByText(/请先完成当前 AI 修改的审阅|Finish reviewing the current AI changes/).length).toBeGreaterThan(0);
  });
});
