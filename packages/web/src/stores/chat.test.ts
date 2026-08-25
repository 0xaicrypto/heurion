import { describe, test, expect, vi, beforeEach } from 'vitest';
import { useChatStore, type ChatMessage } from '@/stores/chat';

vi.mock('@/lib/api', () => ({
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
    useChatStore.setState({
      sessions: { s1: { messages: [], abort: null, loading: false, compacting: false } },
    });
    // Force an error path: make the stream throw.
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield 'boom';
      throw new Error('llm down');
    });
    await useChatStore.getState().sendMessage('s1', { sessionId: 's1', text: 'hi', attachments: [], skills: [] });
    const last = useChatStore.getState().sessions.s1.messages[1];
    expect(last.failed).toBe(true);
    expect(last.text).toContain('Error');
  });

  test('network-level failures render a friendly retry message instead of raw TypeError', async () => {
    useChatStore.setState({
      sessions: { s1: { messages: [], abort: null, loading: false, compacting: false } },
    });
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield 'x';
      throw new TypeError('network error');
    });
    await useChatStore.getState().sendMessage('s1', { sessionId: 's1', text: '润色一下', attachments: [], skills: [] });
    const last = useChatStore.getState().sessions.s1.messages[1];
    expect(last.failed).toBe(true);
    expect(last.text).toBe('网络连接中断（服务器可能已重启或网络不稳定），请重试。');
    expect(last.text).not.toContain('TypeError');
  });
});

describe('chat store — 附件导出与消息更新（#582）', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
  });

  test('attachment_export_option chunk 附着 exportOptions', async () => {
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield { type: 'attachment_export_option', options: ['save_as_document', 'export_pdf', 'continue_discussion'] };
      yield { type: 'turn_complete' };
    });
    const store = useChatStore.getState();
    await store.sendMessage('s1', { sessionId: 's1', text: '帮我润色一下', attachments: ['f1'], skills: [] });
    const asst = useChatStore.getState().sessions.s1.messages[1];
    expect(asst.exportOptions).toEqual(['save_as_document', 'export_pdf', 'continue_discussion']);
  });

  test('patchMessage 就地更新单条消息字段（导出状态）', () => {
    const store = useChatStore.getState();
    store.setMessages('s1', [{ id: 'a1', role: 'assistant', text: '润色结果' }]);
    store.patchMessage('s1', 'a1', { exportState: 'saving' });
    expect(useChatStore.getState().sessions.s1.messages[0].exportState).toBe('saving');
  });
});

describe('chat store — 选中即引用 selection 透传（#693）', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
  });

  test('sendMessage 将编辑器选中文本透传给 sendChatFull', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    let captured: any = null;
    sendChatFull.mockImplementationOnce(async function* (opts: any) {
      captured = opts;
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete' };
    });
    await useChatStore.getState().sendMessage('s1', {
      sessionId: 's1',
      text: '润色这段',
      attachments: [],
      skills: [],
      selection: '原始摘要内容一句话。',
    });
    expect(captured?.selection).toBe('原始摘要内容一句话。');
  });

  test('无选中时不携带 selection', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    let captured: any = null;
    sendChatFull.mockImplementationOnce(async function* (opts: any) {
      captured = opts;
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete' };
    });
    await useChatStore.getState().sendMessage('s1', {
      sessionId: 's1',
      text: '随便聊聊',
      attachments: [],
      skills: [],
    });
    expect(captured?.selection).toBeUndefined();
  });
});
