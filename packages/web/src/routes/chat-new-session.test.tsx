import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from '@/routes/chat';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';

/** 复现：新建会话后第一条消息 AI 必须回复（bug 回归测试）。 */
vi.mock('@/components/plugins/PluginExtensionPoint', () => ({
  PluginExtensionPoint: () => null,
}));
vi.mock('@/lib/api-client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    createSession: vi.fn().mockResolvedValue({ id: 'session_new1', title: '新会话', status: 'open', created_at: new Date().toISOString(), message_count: 0 }),
    getMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
    getContextUsage: vi.fn().mockResolvedValue({ history_tokens: 0, history_budget: 8000, history_turns: 20, omitted_turns: 0, will_compact: false }),
    getExecutionFileDownload: vi.fn().mockResolvedValue({ download_url: '' }),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getLlmStatus: vi.fn().mockResolvedValue({ provider: 'deepseek', model: 'deepseek-chat', ok: true }),
    createKnowledgeArticle: vi.fn().mockResolvedValue({}),
    uploadFile: vi.fn(),
    sendChatFull: vi.fn(async function* () {
      yield { type: 'context_usage', history_tokens: 0, history_budget: 8000, history_turns: 20, omitted_turns: 0, will_compact: false };
      yield { type: 'final_answer_chunk', text: '第一条回复' };
      yield { type: 'citations', items: [] };
      yield { type: 'turn_complete', assistant_event_idx: 3 };
    }),
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
  useChatStore.setState({ sessions: {} });
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Doc' } as any);
});

describe('first message after creating a session (bug repro)', () => {
  test('assistant replies to the very first message of a new session', async () => {
    render(<ChatPage />);

    // Empty state: no session → "还没有会话"
    expect(await screen.findByText(/还没有会话|No session yet/)).toBeInTheDocument();

    // Click 新建会话 (the header + button both open the dialog)
    const newButtons = screen.getAllByRole('button', { name: /新建会话|New Session/i });
    fireEvent.click(newButtons[newButtons.length - 1]);

    // Dialog opens; type a title and confirm
    const titleInput = await screen.findByPlaceholderText(/会话名称|session name/i);
    fireEvent.change(titleInput, { target: { value: '新会话' } });
    const confirm = screen.getAllByRole('button').find((b) => /创建|新建|create/i.test(b.textContent || '')) as HTMLElement;
    fireEvent.click(confirm);

    // Now the input is enabled; type the first message and send
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/请先新建一个会话|Create a session first/)).not.toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/输入|message|聊天/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: /发送|send/i }));

    // The assistant reply must appear
    await waitFor(() => {
      expect(screen.getByText('第一条回复')).toBeInTheDocument();
    });
  });
});

describe('session restore after refresh (bug repro)', () => {
  test('existing open session is auto-selected on mount', async () => {
    const { api } = await import('@/lib/api-client');
    (api.listSessions as any).mockResolvedValue({
      sessions: [
        { id: 'session_persist1', title: '持久会话', status: 'open', created_at: new Date().toISOString(), message_count: 2 },
      ],
    });

    render(<ChatPage />);

    // The session should be restored automatically — input becomes usable
    // (not the 'no session' placeholder) and its title shows in the header.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/请先新建一个会话|Create a session first/)).not.toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/输入|message/i) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByText('持久会话')).toBeInTheDocument();
  });
});
