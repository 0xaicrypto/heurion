import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ChatPage } from '@/routes/chat';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

/** #1007 回归：主 chat 引用能力对称化 — 引用入口/生效条/临时附件固定为引用。 */

const mocks = vi.hoisted(() => ({
  getSessionReferences: vi.fn(),
  addSessionReference: vi.fn(),
  deleteSessionReference: vi.fn(),
  getSessionSuggestions: vi.fn(),
  resolveSessionSuggestion: vi.fn(),
  getReferencePool: vi.fn(),
  scanSessionSuggestions: vi.fn(),
}));

vi.mock('@/components/plugins/PluginExtensionPoint', () => ({
  PluginExtensionPoint: () => null,
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listSessions: vi.fn().mockResolvedValue({
      sessions: [{ id: 's1', title: '会话一', status: 'open', created_at: '', message_count: 0 }],
    }),
    getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
    getContextUsage: vi.fn().mockResolvedValue({ history_tokens: 0, history_budget: 8000, history_turns: 20, omitted_turns: 0, will_compact: false }),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getLlmStatus: vi.fn().mockResolvedValue({ provider: 'deepseek', model: 'deepseek-chat', ok: true }),
    getSessionReferences: mocks.getSessionReferences,
    addSessionReference: mocks.addSessionReference,
    deleteSessionReference: mocks.deleteSessionReference,
    getSessionSuggestions: mocks.getSessionSuggestions,
    resolveSessionSuggestion: mocks.resolveSessionSuggestion,
    getReferencePool: mocks.getReferencePool,
    scanSessionSuggestions: mocks.scanSessionSuggestions,
  },
}));

const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

const refRow = {
  reference_id: 'r1', session_reference_id: 'sr1', kind: 'file', label: 'paper.pdf',
  content: 'paper.pdf', source_ref: 'f1', source: 'manual', created_at: '',
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: storageMock, configurable: true });
  storageMock.clear();
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  useChatStore.setState({ sessions: {} });
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as any);
  vi.clearAllMocks();
  mocks.getSessionReferences.mockResolvedValue({ references: [] });
  mocks.getSessionSuggestions.mockResolvedValue({ suggestions: [] });
  mocks.getReferencePool.mockResolvedValue({ items: [] });
  mocks.scanSessionSuggestions.mockResolvedValue({ suggestions: [] });
  mocks.resolveSessionSuggestion.mockResolvedValue({ ok: true });
  mocks.addSessionReference.mockResolvedValue({ ...refRow, reference_id: 'r_new' });
  mocks.deleteSessionReference.mockResolvedValue({ ok: true });
});

describe('#1007 主 chat 引用', () => {
  test('会话已有引用时显示生效条，入口可打开引用弹层', async () => {
    mocks.getSessionReferences.mockResolvedValue({ references: [refRow] });
    render(<ChatPage />);

    // sessionId 自动选中后 hook 拉取引用列表 → 生效条可见（不用打开弹层）。
    expect(await screen.findByText(/生效中|Active/)).toBeInTheDocument();
    expect(await screen.findByText('paper.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/管理本会话引用材料|Manage this session/));
    expect(await screen.findByText(/参考材料|Reference Materials/)).toBeInTheDocument();
  });

  test('临时附件"固定为引用"调用会话引用端点（带 file id 精确解析）', async () => {
    localStorage.setItem('nexus-chat-attached-files', JSON.stringify({ s1: [{ name: 'paper.pdf', fileId: 'f1' }] }));
    render(<ChatPage />);

    const pin = await screen.findByRole('button', { name: /固定为引用|Pin as reference/ });
    fireEvent.click(pin);

    await waitFor(() => {
      expect(mocks.addSessionReference).toHaveBeenCalledWith('s1', expect.objectContaining({
        kind: 'pdf', content: 'paper.pdf', source_patient_hash: 'f1',
      }));
    });
  });

  test('生效条上取消引用只卸载该会话引用', async () => {
    mocks.getSessionReferences.mockResolvedValue({ references: [refRow] });
    render(<ChatPage />);

    const remove = await screen.findByRole('button', { name: /取消引用|Remove reference/ });
    fireEvent.click(remove);

    await waitFor(() => expect(mocks.deleteSessionReference).toHaveBeenCalledWith('s1', 'r1'));
    await waitFor(() => expect(screen.queryByText('paper.pdf')).not.toBeInTheDocument());
  });
});

describe('#1012 建议态引用', () => {
  const suggestion = {
    id: 'sug1', sessionId: 's1', referenceId: 'r1', reason: '对话内容命中未引用材料',
    suggestedAt: '', status: 'pending',
    reference: { id: 'r1', kind: 'file', label: '建议材料', snapshot: '正文摘要', sourceRef: 'f1' },
  };

  test('横幅与引用弹层都有建议态；采纳后转正式引用并消失', async () => {
    mocks.getSessionSuggestions.mockResolvedValue({ suggestions: [suggestion] });
    mocks.scanSessionSuggestions.mockResolvedValue({ suggestions: [suggestion] });
    render(<ChatPage />);

    const banner = await screen.findByTestId('suggested-reference-banner');
    expect(within(banner).getByText('建议材料')).toBeInTheDocument();
    expect(within(banner).getByText('对话内容命中未引用材料')).toBeInTheDocument();

    // 引用弹层里建议态与正式引用同区展示（虚线 + 建议标签）。
    fireEvent.click(screen.getByTitle(/管理本会话引用材料|Manage this session/));
    expect(await screen.findByTestId('ref-suggestions')).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole('button', { name: /^引用$|^Use$/ }));
    await waitFor(() => expect(mocks.resolveSessionSuggestion).toHaveBeenCalledWith('s1', 'sug1', true));
    await waitFor(() => expect(screen.queryByTestId('suggested-reference-banner')).not.toBeInTheDocument());
    // 采纳即刷新正式引用列表（供生效条/弹层立即展示）。
    await waitFor(() => expect(mocks.getSessionReferences.mock.calls.length).toBeGreaterThan(1));
  });

  test('忽略后横幅消失且调用 resolve(accept=false)', async () => {
    mocks.getSessionSuggestions.mockResolvedValue({ suggestions: [suggestion] });
    mocks.scanSessionSuggestions.mockResolvedValue({ suggestions: [suggestion] });
    render(<ChatPage />);

    const banner = await screen.findByTestId('suggested-reference-banner');
    fireEvent.click(within(banner).getByRole('button', { name: /忽略|Ignore/ }));

    await waitFor(() => expect(mocks.resolveSessionSuggestion).toHaveBeenCalledWith('s1', 'sug1', false));
    await waitFor(() => expect(screen.queryByTestId('suggested-reference-banner')).not.toBeInTheDocument());
  });
});

describe('#1010 引用池隐式排序', () => {
  const poolItem = {
    reference_id: 'pool1', kind: 'pasted_text', label: '旧材料', content: '正文预览',
    source_ref: null, created_at: '',
    usage: {
      session_count: 2,
      last_used_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_session_id: 'sx',
      last_session_title: '放疗课题',
    },
    score: 0,
  };

  test('池面板：使用痕迹展示、三种排序切换、按 item id 复用', async () => {
    mocks.getSessionReferences.mockResolvedValue({ references: [] });
    mocks.getReferencePool.mockResolvedValue({ items: [poolItem] });
    mocks.addSessionReference.mockResolvedValue({ ...refRow, reference_id: 'pool1' });
    render(<ChatPage />);

    // 会话选中后才启用引用入口（否则 disabled 点击无效）。
    await waitFor(() => expect(mocks.getSessionReferences).toHaveBeenCalledWith('s1'));
    fireEvent.click(screen.getByTitle(/管理本会话引用材料|Manage this session/));
    fireEvent.click(await screen.findByRole('button', { name: /最近引用|Reuse/ }));
    expect(await screen.findByTestId('ref-pool')).toBeInTheDocument();

    // 使用痕迹元信息（会话数 + 最近会话标题）。
    expect(await screen.findByText(/用于 2 个会话|Used in 2 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/最近用于《放疗课题》|Last in "放疗课题"/)).toBeInTheDocument();

    // 切换"用得最多" → 以 frequent 重新拉取。
    fireEvent.click(screen.getByRole('button', { name: /用得最多|Most used/ }));
    await waitFor(() => {
      expect(mocks.getReferencePool).toHaveBeenCalledWith(expect.objectContaining({ sort: 'frequent' }));
    });

    // 勾选并复用 → 以 reference_id 精确挂载（不重算 identity）。
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /添加为参考|Add as reference/ }));
    await waitFor(() => {
      expect(mocks.addSessionReference).toHaveBeenCalledWith('s1', expect.objectContaining({ reference_id: 'pool1' }));
    });
  });
});

describe('#1008 开局检测', () => {
  test('打开会话跑一次关键词扫描（上下文=标题+最近消息）', async () => {
    render(<ChatPage />);
    await waitFor(() => {
      expect(mocks.scanSessionSuggestions).toHaveBeenCalledWith('s1', expect.stringContaining('会话一'));
    });
  });
});
