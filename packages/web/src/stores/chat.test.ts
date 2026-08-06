import { describe, test, expect, vi, beforeEach } from 'vitest';
import { useChatStore, type ChatMessage } from '@/stores/chat';

vi.mock('@/lib/api-client', () => ({
  api: {
    sendChatFull: vi.fn(async function* () {
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete' };
    }),
    getContextUsage: vi.fn(),
  },
}));

describe('chat store — regenerate (§10.3 #220)', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
  });

  test('regenerate drops the stale reply and re-runs the last user turn', async () => {
    const store = useChatStore.getState();
    const base: ChatMessage[] = [
      { id: 'u1', role: 'user', text: '第一问', createdAt: 1000 },
      { id: 'a1', role: 'assistant', text: '旧回答', createdAt: 2000 },
      { id: 'u2', role: 'user', text: '第二问', createdAt: 3000 },
      { id: 'a2', role: 'assistant', text: '过期回答', isStreaming: true, createdAt: 4000 },
    ];
    useChatStore.setState({
      sessions: { s1: { messages: base, abort: null, loading: false, compacting: false } },
    });

    await useChatStore.getState().regenerate('s1', { sessionId: 's1', text: '', attachments: [], skills: [] });

    const msgs = useChatStore.getState().sessions.s1.messages;
    expect(msgs.length).toBe(4); // u1, a1, fresh u2', fresh assistant
    expect(msgs[2].text).toBe('第二问');
    // The fresh reply streamed to completion.
    expect(msgs[msgs.length - 1].role).toBe('assistant');
    expect(msgs[msgs.length - 1].text).toBe('done');
    expect(msgs[msgs.length - 1].isStreaming).toBe(false);
  });

  test('regenerate is a no-op while loading', async () => {
    useChatStore.setState({
      sessions: { s1: { messages: [{ id: 'u1', role: 'user', text: 'q' }], abort: null, loading: true, compacting: false } },
    });
    await useChatStore.getState().regenerate('s1', { sessionId: 's1', text: '', attachments: [], skills: [] });
    expect(useChatStore.getState().sessions.s1.messages.length).toBe(1);
  });

  test('failed messages are flagged for retry', async () => {
    const store = useChatStore.getState();
    store.getOrCreate('s1');
    // Force an error path: make the stream throw.
    const { api } = await import('@/lib/api-client');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      throw new Error('llm down');
    });
    await store.sendMessage('s1', { sessionId: 's1', text: 'hi', attachments: [], skills: [] });
    const last = useChatStore.getState().sessions.s1.messages[1];
    expect(last.failed).toBe(true);
    expect(last.text).toContain('Error');
  });
});
