import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from '@/routes/chat';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

/**
 * #598 — 主 chat 场景切换 UI 已移除:场景由后端按上下文自动推断
 * + 意图判定;患者页/写作页仍显式传 patient/document。
 */
vi.mock('@/components/plugins/PluginExtensionPoint', () => ({
  PluginExtensionPoint: () => null,
}));
/** vi.hoisted: mock 工厂引用必须在此处声明(vitest hoisting 限制)。 */
const { sendChatFull } = vi.hoisted(() => ({
  sendChatFull: vi.fn(async function* (opts: Record<string, unknown>) {
    void opts;
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

describe('#598 chat scene auto (selector removed)', () => {
  test('主 chat 不显示场景切换按钮(由意图自动判定)', async () => {
    render(<ChatPage />);
    expect(screen.queryByText('通用对话')).toBeNull();
    expect(screen.queryByText('图表分析')).toBeNull();
    expect(screen.queryByText('患者问诊')).toBeNull();
    expect(screen.queryByText('文档写作')).toBeNull();
  });

  test('发送时未显式携带 scene(后端自动推断 general)', async () => {
    render(<ChatPage />);
    const newButtons = screen.getAllByRole('button', { name: /新建会话|New Session/i });
    fireEvent.click(newButtons[newButtons.length - 1]);
    const titleInput = await screen.findByPlaceholderText(/会话名称|session name/i);
    fireEvent.change(titleInput, { target: { value: '会话' } });
    const confirm = screen.getAllByRole('button').find((b) => /创建|新建|create/i.test(b.textContent || '')) as HTMLElement;
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/请先新建一个会话|Create a session first/)).not.toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/输入|message|聊天/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: /发送|send/i }));
    await waitFor(() => {
      const call = sendChatFull.mock.calls[0]?.[0] as { scene?: string } | undefined;
      expect(call?.scene).toBeUndefined();
    });
  });
});
