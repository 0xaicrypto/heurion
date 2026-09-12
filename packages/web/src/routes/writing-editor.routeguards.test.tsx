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

/** #989 Phase 3: 投影构造 helper(前端消费测试用 — id 为不透明字符串)。 */
const projSec = (id: string, heading: string, hash: string) => ({ id, kind: 'section', heading, level: 2, hash, start: 0, end: 1, parent_id: null });
const BASELINE_PROJECTION = {
  schema_version: 1,
  body_hash: 'baseline0000',
  nodes: [
    projSec('s_intro', 'Introduction', 'hash-intro-1'),
    projSec('s_methods', 'Methods', 'hash-methods-1'),
    projSec('s_results', 'Results', 'hash-results-1'),
  ],
};
const DOC_A = {
  id: 'd1',
  title: 'A doc',
  body: 'A body',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  study_id: 'st1',
  study_name: 'Study A',
  // #989 Phase 3: 服务端 getDoc 返回投影 — 前端批次基线。
  block_projection: BASELINE_PROJECTION,
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
type Write = { body: string; rev: number; projection?: unknown };
const turnScripts: Write[][] = [];
/** #989 Phase 3: 流式观察测试需要更长的事件间隔(React 18 批处理会把
 *  10ms 间隔的整轮事件合并成一次提交,瞬态指示条不可观察)。 */
let TURN_GAP_MS = 10;

function mockTurns() {
  apiMock.sendChatFull.mockImplementation(async function* () {
    const writes = turnScripts.shift() ?? [];
    for (const w of writes) {
      await new Promise((r) => setTimeout(r, TURN_GAP_MS));
      yield { type: 'doc_updated', body: w.body, rev: w.rev, ...(w.projection !== undefined ? { projection: w.projection } : {}) };
    }
    await new Promise((r) => setTimeout(r, TURN_GAP_MS));
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

describe('#986 二次保存失败 — dirty 回灌 + autosave 重试 + 常驻警示条', () => {
  test('接受 AI 修改后保存失败(非 409)→ 警示条常驻,autosave 重试成功后消除', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');
    // 第一次 updateDoc(接受后的落地保存)网络错误(非 409);第二次 autosave 重试成功。
    apiMock.updateDoc
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ...DOC_A, updated_at: '2026-01-06T00:00:00Z' });

    await sendTurn([{ body: 'A body\n\nR1 段落', rev: 1 }]);
    await waitFor(() => expect(screen.getByRole('button', { name: /全部接受|Accept all/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /全部接受|Accept all/ }));

    // 失败即刻可见(不再是 6 秒后即消失的 toast)
    expect(await screen.findByText(/保存失败 — 修改仅在本窗口|Save failed — your changes/)).toBeTruthy();

    // dirty 回灌 → autosave(2.5s)自动重试 → 第二次成功 → 警示条消除
    await waitFor(() => expect(apiMock.updateDoc).toHaveBeenCalledTimes(2), { timeout: 6000 });
    await waitFor(() => expect(screen.queryByText(/保存失败 — 修改仅在本窗口|Save failed — your changes/)).toBeNull());
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

describe('#989 Phase 3 — 编辑过程流式可见(块投影消费,#987)', () => {
  /**
   * 发起 turn 但**不等待完成** — mock 流跨宏任务发射,指示条只在
   * loading=true 的窗口内可见(生产即流式窗口)。断言须在流进行中完成,
   * 再等 turn 结束让位于审阅。
   */
  async function startTurnStreaming(writes: Write[]) {
    TURN_GAP_MS = 120; // 事件间隔 > React 批处理窗口,瞬态可观察
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
      expect(useChatStore.getState().sessions[SESSION_A]?.loading).toBe(true);
    });
  }

  test('写回进行时画布实时展示「正在编辑」节,批结束让位于审阅', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');

    // 单 turn 两笔写回:1=Introduction 变(对照文档基线 hash-intro-1),
    // 2=Results 也变 — 流进行中逐笔观察指示条。
    void startTurnStreaming([
      {
        body: 'A body\n\nIntro edited',
        rev: 1,
        projection: { schema_version: 1, body_hash: 'p1aaaaaaaa', nodes: [
          projSec('s_intro', 'Introduction', 'hash-intro-2'),
          projSec('s_methods', 'Methods', 'hash-methods-1'),
          projSec('s_results', 'Results', 'hash-results-1'),
        ] },
      },
      {
        body: 'A body\n\nIntro edited\n\nResults edited',
        rev: 2,
        projection: { schema_version: 1, body_hash: 'p2aaaaaaaa', nodes: [
          projSec('s_intro', 'Introduction', 'hash-intro-2'),
          projSec('s_methods', 'Methods', 'hash-methods-1'),
          projSec('s_results', 'Results', 'hash-results-2'),
        ] },
      },
    ]);

    // 指示条实时出现(替代 60 秒黑盒缓冲)— 列表为对照基线的累积 diff
    // (批内事件可能被 React 批处理合并消费,断言 span 累积文本而非瞬时态)。
    const chipText = () => (document.querySelector('[data-testid="editing-live"]')?.parentElement as HTMLElement | null)?.textContent ?? '';
    await waitFor(() => expect(chipText()).toContain('Introduction'), { timeout: 3000 });
    await waitFor(() => expect(chipText()).toContain('Results'), { timeout: 3000 });

    // turn 结束 → 批冲刷进 diff 审阅,指示条自动消失
    await waitFor(() => {
      expect(useChatStore.getState().sessions[SESSION_A]?.loading).toBe(false);
    }, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText(/AI 正在编辑|AI is editing/)).toBeNull(), { timeout: 3000 });
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();
  }, 30_000);

  test('无投影的旧后端事件不破坏既有写回流(向后兼容)', async () => {
    renderEditor(false);
    await screen.findByDisplayValue('A doc');
    await sendTurn([{ body: 'A body\n\nR1 段落', rev: 1 }]);
    expect(await screen.findByText(/审阅 AI 修改|Review AI changes/)).toBeTruthy();
    expect(screen.queryByText(/AI 正在编辑|AI is editing/)).toBeNull();
  });
});
