import { describe, test, expect } from 'vitest'
import { applyChunkToSession, emptySession, shouldApplyDocRev, type SessionState } from './chat-reducer';
import type { ChatStreamChunk } from './types';

function send(s: SessionState, chunk: ChatStreamChunk): SessionState {
  return applyChunkToSession(s, chunk);
}

function sessionWithAssistant(): SessionState {
  let s = emptySession();
  s = send(s, { type: 'turn_started', event_idx: 1, patient_hash: null });
  s = send(s, { type: 'final_answer_chunk', text: '' });
  // final_answer_chunk on a non-assistant message is ignored; push an
  // assistant streaming message the way sendMessage does.
  s = {
    ...s,
    messages: [...s.messages, { id: 'a1', role: 'assistant', text: '', isStreaming: true }],
  };
  return s;
}

/** #829: seq-precise chip lifecycle under parallel tool execution. */
describe('chat-reducer #829 — tool_result seq closing', () => {
  test('parallel tool_calls stay running until their own tool_result arrives', () => {
    const s0 = sessionWithAssistant();
    const s1 = send(s0, { type: 'tool_call', tool: 'search_medical_web', args: { query: 'a' }, seq: 1 });
    const s2 = send(s1, { type: 'tool_call', tool: 'visit_medical_site', args: { url: 'u' }, seq: 2 });
    let chips = s2.messages.at(-1)?.toolCalls;
    expect(chips?.map((c) => c.status)).toEqual(['running', 'running']); // both live in parallel

    const s3 = send(s2, { type: 'tool_result', seq: 1, success: true, elapsed_ms: 120, preview: 'PubMed results for "a"' });
    chips = s3.messages.at(-1)?.toolCalls;
    expect(chips?.map((c) => c.status)).toEqual(['done', 'running']);
    expect(chips?.[0].resultPreview).toBe('PubMed results for "a"');
    expect(chips?.[0].elapsedMs).toBe(120);

    const s4 = send(s3, { type: 'tool_result', seq: 2, success: false, elapsed_ms: 300, preview: 'HTTP 403' });
    chips = s4.messages.at(-1)?.toolCalls;
    expect(chips?.map((c) => c.status)).toEqual(['done', 'error']);
    expect(chips?.[1].resultPreview).toBe('HTTP 403');
  });

  test('legacy events without seq keep the close-previous behavior', () => {
    const s0 = sessionWithAssistant();
    const s1 = send(s0, { type: 'tool_call', tool: 'search_node', args: {} });
    const s2 = send(s1, { type: 'tool_call', tool: 'search_encounter', args: {} });
    // No seq on the first call → closed by the second call's arrival.
    expect(s2.messages.at(-1)?.toolCalls?.map((c) => c.status)).toEqual(['done', 'running']);
  });
});

/** #831: sub-agent visibility attaches to the streaming assistant message. */
describe('chat-reducer #831 — subagent events', () => {
  test('started → progress → done updates a single entry keyed by id', () => {
    const s0 = sessionWithAssistant();
    const s1 = send(s0, { type: 'subagent_started', id: 'sub_1', task: 'literature review', scope: 'global' });
    const s2 = send(s1, {
      type: 'subagent_progress', id: 'sub_1', task: 'literature review', phase: 'tool',
      current_tool: 'search_medical_web', tool_args_preview: '{"query":"a"}', turn: 2, max_turns: 4, elapsed_ms: 4200,
    });
    const sa = s2.messages.at(-1)?.subagents?.[0];
    expect(sa).toMatchObject({
      id: 'sub_1', status: 'running', phase: 'tool',
      currentTool: 'search_medical_web', turn: 2, maxTurns: 4,
    });

    const s3 = send(s2, {
      type: 'subagent_done', id: 'sub_1', task: 'literature review', success: true,
      turns: 3, cost_tokens: 900, summary_preview: '3 RCTs reviewed',
    });
    const done = s3.messages.at(-1)?.subagents?.[0];
    expect(done).toMatchObject({ id: 'sub_1', status: 'done', summaryPreview: '3 RCTs reviewed', turns: 3 });
  });

  test('batch fan-out keeps entries separate by id', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'subagent_started', id: 'a', task: 'topic-a' });
    s = send(s, { type: 'subagent_started', id: 'b', task: 'topic-a' }); // same task text, different run
    s = send(s, { type: 'subagent_done', id: 'a', task: 'topic-a', success: true, summary_preview: 'A done' });
    const subs = s.messages.at(-1)?.subagents;
    expect(subs).toHaveLength(2);
    expect(subs?.find((e) => e.id === 'b')?.status).toBe('running');
    expect(subs?.find((e) => e.id === 'a')?.status).toBe('done');
  });
});

// #fix — 错误即回合终结: streamNote 清除(此前错误后状态卡泄漏到所有历史消息)。
describe('chat-reducer — error 清 streamNote', () => {
  test('error 事件清除会话级 streamNote 且消息落错误文本', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'context_info', text: '正在载入钉选参考…', kind: 'file_context' } as any);
    expect(s.streamNote).toBe('正在载入钉选参考…');
    s = send(s, { type: 'error', message: 'LLM request timed out after 600000ms' } as any);
    expect(s.streamNote).toBeUndefined();
    expect(s.messages.at(-1)?.text).toContain('LLM request timed out');
    expect(s.messages.at(-1)?.isStreaming).toBe(false);
  });

  test('turn_complete 同样清除(既有语义回归)', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'context_info', text: '正在分析…', kind: 'file_context' } as any);
    s = send(s, { type: 'turn_complete' });
    expect(s.streamNote).toBeUndefined();
  });
});

/** #927: doc_updated rev 幂等 — rev 随帧存储 + 消费方按 rev 防乱序。 */
describe('chat-reducer #927 — doc_updated rev 幂等', () => {
  test('doc_updated 携带 rev 时随 lastDocBody/lastDocDeck 一起存储', () => {
    const s0 = sessionWithAssistant();
    const s1 = send(s0, { type: 'doc_updated', body: 'v2 body', rev: 7, updatedAt: '2026-09-08T00:00:00Z' });
    expect(s1.lastDocBody).toBe('v2 body');
    expect(s1.lastDocRev).toBe(7);
    // 无 deck 字段 → lastDocDeck null(既有语义)
    expect(s1.lastDocDeck).toBeNull();
  });

  test('无 rev 的旧后端事件保留既有 lastDocRev(不回退)', () => {
    const s0 = sessionWithAssistant();
    const s1 = send(s0, { type: 'doc_updated', body: 'v2 body', rev: 7 });
    const s2 = send(s1, { type: 'doc_updated', body: 'v3 body' });
    expect(s2.lastDocBody).toBe('v3 body');
    expect(s2.lastDocRev).toBe(7);
  });

  test('shouldApplyDocRev — rev 更大才应用,乱序/重放忽略,无 rev 兼容', () => {
    expect(shouldApplyDocRev(undefined, 5)).toBe(true); // 首笔写回
    expect(shouldApplyDocRev(5, 6)).toBe(true); // 正常递增
    expect(shouldApplyDocRev(6, 5)).toBe(false); // 乱序旧包 → 忽略
    expect(shouldApplyDocRev(6, 6)).toBe(false); // 重放 → 忽略
    expect(shouldApplyDocRev(6, undefined)).toBe(true); // 旧后端无 rev → 兼容应用
  });
});
