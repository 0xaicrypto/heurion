import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore, latestAssistantTurnId, onChatPendingDropped, pendingQueuePosition, resetAssistantTurnIdsForTests, type ChatMessage, type PendingChatSlot } from '@/stores/chat';

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
    // #947: 文案走 i18n（语言由检测器决定），断言任一 locale 变体而非裸 TypeError。
    expect(last.text === '网络连接中断（服务器可能已重启或网络不稳定），请重试。' ||
      last.text === 'Network connection interrupted (the server may have restarted or the network is unstable). Please retry.').toBe(true);
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

describe('chat store — 追加问题排队(#fix)', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
  });

  test('回复进行中 sendMessageQueued → 排队不发送,回复完成后自动发出', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    const sent: string[] = [];
    sendChatFull.mockImplementationOnce(async function* (opts: any) {
      sent.push(opts.text);
      yield { type: 'final_answer_chunk', text: '第一轮回复' };
      yield { type: 'turn_complete' };
    });
    // 第二轮(排队消息自动发出)。
    sendChatFull.mockImplementationOnce(async function* (opts: any) {
      sent.push(opts.text);
      yield { type: 'final_answer_chunk', text: '第二轮回复' };
      yield { type: 'turn_complete' };
    });

    const store = useChatStore.getState();
    // 第一轮:直接发送。
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '润色摘要', attachments: [], skills: [] });
    // 回复进行中:追加消息 → 排队,不触发新一轮 fetch。
    const queued = store.sendMessageQueued('s1', { sessionId: 's1', text: '顺便把标题也改一下', attachments: [], skills: [] });
    expect(queued).toBeInstanceOf(Promise);
    expect(sent).toEqual(['润色摘要']);
    // #1095: 多槽 FIFO — 排队槽带显式 turnId。
    const queue = useChatStore.getState().sessions.s1.pendingQueue ?? [];
    expect(queue.map((s) => s.text)).toEqual(['顺便把标题也改一下']);
    await expect(queued).resolves.toBe(queue[0].turnId);

    await p1;
    // 第一轮完成后,排队消息自动发出(FIFO 出队 → 队列清空)。
    await vi.waitFor(() => expect(sent).toEqual(['润色摘要', '顺便把标题也改一下']));
    await vi.waitFor(() => expect(useChatStore.getState().sessions.s1.pendingQueue).toEqual([]));
    const msgs = useChatStore.getState().sessions.s1.messages;
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['润色摘要', '顺便把标题也改一下']);
  });

  test('#1095 回复中连续追加 → 多槽 FIFO 全部保留,按序发出', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    const sent: string[] = [];
    sendChatFull.mockImplementation(async function* (opts: any) {
      sent.push(opts.text);
      yield { type: 'final_answer_chunk', text: '回复' };
      yield { type: 'turn_complete' };
    });
    const store = useChatStore.getState();
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '第一轮', attachments: [], skills: [] });
    const tA = await store.sendMessageQueued('s1', { sessionId: 's1', text: '追加 A', attachments: [], skills: [] });
    const tB = await store.sendMessageQueued('s1', { sessionId: 's1', text: '追加 B', attachments: [], skills: [] });
    // #1095: 队列不再覆盖 — A、B 都在，顺序 FIFO；turnId 互不相同。
    const queue = useChatStore.getState().sessions.s1.pendingQueue ?? [];
    expect(queue.map((s) => s.text)).toEqual(['追加 A', '追加 B']);
    expect(tA).not.toBe(tB);
    await p1;
    await vi.waitFor(() => expect(sent).toEqual(['第一轮', '追加 A', '追加 B']));
  });

  test('stopStream 停止分析并清空排队消息(不自动发出)', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    const sent: string[] = [];
    sendChatFull.mockImplementationOnce(async function* (opts: any, signal?: AbortSignal) {
      sent.push(opts.text);
      // 模拟长流:abort 信号到达才结束。
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve());
        setTimeout(resolve, 8000);
      });
      yield { type: 'final_answer_chunk', text: 'x' };
    });
    const store = useChatStore.getState();
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '第一轮', attachments: [], skills: [] });
    // 排队一条。
    await store.sendMessageQueued('s1', { sessionId: 's1', text: '追加消息', attachments: [], skills: [] });
    expect(useChatStore.getState().sessions.s1.pendingQueue?.[0]?.text).toBe('追加消息');

    // 停止:loading 结束、队列清空、排队消息不被发出。
    store.stopStream('s1');
    await p1;
    const s = useChatStore.getState().sessions.s1;
    expect(s.loading).toBe(false);
    expect(s.pendingQueue).toEqual([]);
    expect(sent).toEqual(['第一轮']);
  });
});

describe('chat store — 停滞提示起点保留(#fix 2026-09)', () => {  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('长时间静默:stallSince 保持最早起点不重置,数据恢复后清除', async () => {
    const { api } = await import('@/lib/api');
    const sendChatFull = api.sendChatFull as any;
    // 流:发一条事件后挂起(模拟上下文组装/长思考期无 SSE 事件),由测试
    // 手动放行结束。
    // 用对象持有 resolve：裸 let 会在 TS 控制流下被窄化为 null/never
    // （回调内赋值不可见），调用点报 TS2349。
    const release: { resolve: (() => void) | null } = { resolve: null };
    sendChatFull.mockImplementationOnce(async function* () {
      yield { type: 'context_info', text: '正在读取文档与参考资料…', kind: 'file_context' };
      await new Promise<void>((resolve) => { release.resolve = resolve; });
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete' };
    });

    const p = useChatStore.getState().sendMessage('s1', { sessionId: 's1', text: 'hi', attachments: [], skills: [] });

    // 90s 无新事件 → 停滞置位。
    await vi.advanceTimersByTimeAsync(95_000);
    const first = useChatStore.getState().sessions.s1.stallSince;
    expect(first).not.toBeNull();

    // 再过 5s:起点不变(UI 时长随 tick 增长,不回 "<1s")。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useChatStore.getState().sessions.s1.stallSince).toBe(first);

    // 再过 90s(第二次停滞触发):仍不重置 — 此前 bug 每 100ms 重置为 now。
    await vi.advanceTimersByTimeAsync(90_000);
    expect(useChatStore.getState().sessions.s1.stallSince).toBe(first);

    // 数据恢复 → 停滞清除,流正常走完。
    release.resolve?.();
    await p;
    const s = useChatStore.getState().sessions.s1;
    expect(s.stallSince).toBeNull();
    expect(s.messages[s.messages.length - 1].text).toBe('done');
  });
});

describe('#1074-4/#1095 排队槽显式 turnId（多槽 FIFO）', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
    resetAssistantTurnIdsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('#1095 排队入队生成独立 turnId；多槽不覆盖不丢（覆盖丢弃路径退役）', async () => {
    const droppedEvents: Array<{ text: string; turnId?: string }> = [];
    onChatPendingDropped((e) => droppedEvents.push({ text: e.text, turnId: e.turnId }));
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield { type: 'final_answer_chunk', text: '第一轮' };
      yield { type: 'turn_complete', assistant_event_idx: 11 };
    });
    const store = useChatStore.getState();
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '第一轮', attachments: [], skills: [] });
    const turnIdA = await store.sendMessageQueued('s1', { sessionId: 's1', text: '评论指令 A', attachments: [], skills: [] });
    const queue = useChatStore.getState().sessions.s1.pendingQueue ?? [];
    expect(queue.map((s) => s.text)).toEqual(['评论指令 A']);
    expect(turnIdA).toBe(queue[0].turnId);
    expect(typeof turnIdA).toBe('string');

    // #1095: 第二条排队不再覆盖/丢弃 A — 队列追加 B，零丢弃事件。
    const turnIdB = await store.sendMessageQueued('s1', { sessionId: 's1', text: '评论指令 B', attachments: [], skills: [] });
    expect(droppedEvents).toEqual([]);
    expect((useChatStore.getState().sessions.s1.pendingQueue ?? []).map((s) => s.text)).toEqual(['评论指令 A', '评论指令 B']);
    expect(turnIdA).not.toBe(turnIdB);
    await p1;
  });

  test('Stop / regenerate 清空队列时逐槽事件携带同 turnId', async () => {
    const droppedEvents: Array<{ text: string; turnId?: string }> = [];
    onChatPendingDropped((e) => droppedEvents.push({ text: e.text, turnId: e.turnId }));
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* (_opts: unknown, signal?: AbortSignal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve());
        setTimeout(resolve, 8000);
      });
      yield { type: 'final_answer_chunk', text: 'x' };
    });
    const store = useChatStore.getState();
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '第一轮', attachments: [], skills: [] });
    const queuedTurnId = await store.sendMessageQueued('s1', { sessionId: 's1', text: '排队指令', attachments: [], skills: [] });

    store.stopStream('s1');
    await p1;
    expect(droppedEvents).toEqual([{ text: '排队指令', turnId: queuedTurnId }]);

    // regenerate 同口径（逐槽事件）。
    useChatStore.setState({ sessions: {} });
    const regenEvents: Array<{ text: string; turnId?: string }> = [];
    onChatPendingDropped((e) => regenEvents.push({ text: e.text, turnId: e.turnId }));
    const regenSlotA: PendingChatSlot = {
      text: '排队指令 A',
      opts: { sessionId: 's1', text: '排队指令 A', attachments: [], skills: [] },
      turnId: 'turn_regen_a',
    };
    const regenSlotB: PendingChatSlot = {
      text: '排队指令 B',
      opts: { sessionId: 's1', text: '排队指令 B', attachments: [], skills: [] },
      turnId: 'turn_regen_b',
    };
    useChatStore.setState({
      sessions: { s1: { messages: [
        { id: 'u1', role: 'user', text: '第一问', createdAt: 1 },
      ], abort: null, loading: false, compacting: false, pendingQueue: [regenSlotA, regenSlotB] } },
    });
    await useChatStore.getState().regenerate('s1', { sessionId: 's1', text: '', attachments: [], skills: [] });
    expect(regenEvents).toEqual([
      { text: '排队指令 A', turnId: 'turn_regen_a' },
      { text: '排队指令 B', turnId: 'turn_regen_b' },
    ]);
  });

  test('#1095 队列位次：pendingQueuePosition 按 FIFO 1-based，出队后归零', async () => {
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield { type: 'final_answer_chunk', text: '第一轮' };
      yield { type: 'turn_complete' };
    });
    const store = useChatStore.getState();
    const p1 = store.sendMessage('s1', { sessionId: 's1', text: '第一轮', attachments: [], skills: [] });
    const tA = await store.sendMessageQueued('s1', { sessionId: 's1', text: 'A', attachments: [], skills: [] });
    const tB = await store.sendMessageQueued('s1', { sessionId: 's1', text: 'B', attachments: [], skills: [] });
    expect(pendingQueuePosition('s1', tA!)).toBe(1);
    expect(pendingQueuePosition('s1', tB!)).toBe(2);
    expect(pendingQueuePosition('s1', 'nope')).toBe(0);
    await p1;
    // A 出队 → B 升为第 1 位；全部发完后双双归零。
    await vi.waitFor(() => expect(useChatStore.getState().sessions.s1.pendingQueue).toEqual([]));
    expect(pendingQueuePosition('s1', tA!)).toBe(0);
    expect(pendingQueuePosition('s1', tB!)).toBe(0);
  });
});

describe('#1072-2 web 适配 — latestAssistantTurnId(turn_complete.assistant_event_idx)', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
    resetAssistantTurnIdsForTests();
  });

  test('turn_complete 携带 assistant_event_idx → 记录为该会话的服务端 turn id', async () => {
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete', assistant_event_idx: 42 };
    });
    await useChatStore.getState().sendMessage('s1', { sessionId: 's1', text: 'hi', attachments: [], skills: [] });
    expect(latestAssistantTurnId('s1')).toBe('42');
  });

  test('watchdog 型终止（无 assistant_event_idx）→ 不记录（保留 null）', async () => {
    const { api } = await import('@/lib/api');
    (api.sendChatFull as any).mockImplementationOnce(async function* () {
      yield { type: 'final_answer_chunk', text: 'done' };
      yield { type: 'turn_complete' };
    });
    await useChatStore.getState().sendMessage('s2', { sessionId: 's2', text: 'hi', attachments: [], skills: [] });
    expect(latestAssistantTurnId('s2')).toBeNull();
  });
});
