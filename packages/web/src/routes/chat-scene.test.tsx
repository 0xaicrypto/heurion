import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from '@/routes/chat';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

/**
 * #516 — chat 场景入口:四场景切换 UI,发送消息时 scene 随请求传递。
 */
vi.mock('@/components/plugins/PluginExtensionPoint', () => ({
  PluginExtensionPoint: () => null,
}));
/** vi.hoisted: mock 工厂引用必须在此处声明(vitest hoisting 限制)。 */
const { sendChatFull } = vi.hoisted(() => ({
  sendChatFull: vi.fn(async function* () {
    yield { type: 'final_answer_chunk', text: '回复' };
    yield { type: 'citations', items: [] };
    yield { type: 'turn_complete', assistant_event_idx: 3 };
  }),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    createSession: vi.fn().mockResolvedValue({ id: 'session_s1', title: '会话', status: 'open', created_at: new Date().toISOString(), message_count: 0 }),
    getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
    getContextUsage: vi.fn().mockResolvedValue({ history_tokens: 0, history_budget: 8000, history_turns: 20, omitted_turns: 0, will_compact: false }),
    getExecutionFileDownload: vi.fn().mockResolvedValue({ download_url: '' }),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getLlmStatus: vi.fn().mockResolvedValue({ provider: 'deepseek', model: 'deepseek-chat', ok: true }),
    createKnowledgeArticle: vi.fn().mockResolvedValue({}),
    uploadFile: vi.fn(),
    sendChatFull,
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

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: storageMock, configurable: true });
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  sendChatFull.mockClear();
  useChatStore.setState({
    sessions: { session_s1: { messages: [], abort: null, loading: false, compacting: false } },
  });
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as any);
});

describe('#516 chat scene selector', () => {
  test('渲染四个场景入口', async () => {
    render(<ChatPage />);
    await screen.findByText('通用对话');
    expect(screen.getByText('通用对话')).toBeTruthy();
    expect(screen.getByText('患者问诊')).toBeTruthy();
    expect(screen.getByText('文档写作')).toBeTruthy();
    expect(screen.getByText('图表分析')).toBeTruthy();
  });

  /** 建立会话:空状态 → 新建会话对话框 → 确认。 */
  async function createSession() {
    const newButtons = screen.getAllByRole('button', { name: /新建会话|New Session/i });
    fireEvent.click(newButtons[newButtons.length - 1]);
    const titleInput = await screen.findByPlaceholderText(/会话名称|session name/i);
    fireEvent.change(titleInput, { target: { value: '会话' } });
    const confirm = screen.getAllByRole('button').find((b) => /创建|新建|create/i.test(b.textContent || '')) as HTMLElement;
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/请先新建一个会话|Create a session first/)).not.toBeInTheDocument();
    });
  }

  test('默认 general;切换到 chart 后发送携带 scene', async () => {
    render(<ChatPage />);
    await createSession();
    fireEvent.click(screen.getByText('图表分析'));
    const input = screen.getByPlaceholderText(/输入|message|聊天/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '画一张 KM 曲线' } });
    fireEvent.click(screen.getByRole('button', { name: /发送|send/i }));
    await waitFor(() => {
      const call = sendChatFull.mock.calls[0]?.[0] as { scene?: string };
      expect(call?.scene).toBe('chart');
    });
  });

  test('发送后场景在当前会话保持(再次发送仍是 chart)', async () => {
    render(<ChatPage />);
    await createSession();
    fireEvent.click(screen.getByText('图表分析'));
    const input = screen.getByPlaceholderText(/输入|message|聊天/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '问题一' } });
    fireEvent.click(screen.getByRole('button', { name: /发送|send/i }));
    await waitFor(() => expect(sendChatFull.mock.calls.length).toBeGreaterThan(0));
    fireEvent.change(input, { target: { value: '问题二' } });
    fireEvent.click(screen.getByRole('button', { name: /发送|send/i }));
    await waitFor(() => expect(sendChatFull.mock.calls.length).toBe(2));
    const second = sendChatFull.mock.calls[1]?.[0] as { scene?: string };
    expect(second?.scene).toBe('chart');
  });
});
