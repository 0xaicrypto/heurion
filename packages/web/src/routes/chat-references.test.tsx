import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from '@/routes/chat';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

/** #1007 回归：主 chat 引用能力对称化 — 引用入口/生效条/临时附件固定为引用。 */

const mocks = vi.hoisted(() => ({
  getSessionReferences: vi.fn(),
  addSessionReference: vi.fn(),
  deleteSessionReference: vi.fn(),
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
