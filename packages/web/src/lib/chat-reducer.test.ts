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

  test('#1113 deck_version 随帧存储，普通正文写回不回退', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'doc_updated', body: 'v2', deck_version: 'v2' });
    expect(s.lastDocDeckVersion).toBe('v2');
    // 无该字段的普通正文写回保留既有版本（画布据此去重，不被清空）。
    s = send(s, { type: 'doc_updated', body: 'v3' });
    expect(s.lastDocDeckVersion).toBe('v2');
    s = send(s, { type: 'doc_updated', body: 'v4', deck_version: 'v5' });
    expect(s.lastDocDeckVersion).toBe('v5');
  });

  test('shouldApplyDocRev — rev 更大才应用,乱序/重放忽略,无 rev 兼容', () => {
    expect(shouldApplyDocRev(undefined, 5)).toBe(true); // 首笔写回
    expect(shouldApplyDocRev(5, 6)).toBe(true); // 正常递增
    expect(shouldApplyDocRev(6, 5)).toBe(false); // 乱序旧包 → 忽略
    expect(shouldApplyDocRev(6, 6)).toBe(false); // 重放 → 忽略
    expect(shouldApplyDocRev(6, undefined)).toBe(true); // 旧后端无 rev → 兼容应用
  });
});

/** #408-followup: AI 改名写回 — title 随 doc_updated 存储,body 未变也生效。 */
describe('chat-reducer #408-followup — doc_updated title', () => {
  test('title-only 写回(body 未变)仍存储 lastDocTitle', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'doc_updated', body: 'same body', title: '新标题' });
    expect(s.lastDocTitle).toBe('新标题');
    expect(s.lastDocBody).toBe('same body');
  });

  test('无 title 的旧事件保留既有 lastDocTitle(与 rev 同策略)', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'doc_updated', body: 'v2', title: '第一版标题' });
    s = send(s, { type: 'doc_updated', body: 'v3' });
    expect(s.lastDocTitle).toBe('第一版标题');
  });
});

/** #989 Phase 3: 投影随帧存储 — 前端「编辑过程流式可见」数据源。 */describe('chat-reducer #989 — doc_updated projection 存储', () => {
  test('携带 projection 时随帧存储;旧事件无字段保留既有值(与 rev 同策略)', () => {
    let s = sessionWithAssistant();
    const p1: import('@heurion/contracts').BlockProjection = { schema_version: 1, body_hash: 'aaaaaaaaaaaa', nodes: [{ id: 's_intro', kind: 'section', heading: 'Introduction', level: 2, hash: 'hash-intro-1', start: 0, end: 1, parent_id: null }] };
    s = send(s, { type: 'doc_updated', body: 'v2', projection: p1 });
    expect(s.lastDocProjection).toEqual(p1);
    // 旧形态事件(无 projection 字段)不回退
    const s2 = send(s, { type: 'doc_updated', body: 'v3' });
    expect(s2.lastDocProjection).toEqual(p1);
    // 新投影覆盖
    const p2: import('@heurion/contracts').BlockProjection = { schema_version: 1, body_hash: 'bbbbbbbbbbbb', nodes: [] };
    const s3 = send(s2, { type: 'doc_updated', body: 'v4', projection: p2 });
    expect(s3.lastDocProjection).toEqual(p2);
  });
});

describe('chat-reducer #996/#1003 — 本轮节改动累积（聊天改动日志）', () => {
  const proj = (hashA: string, hashB: string) => ({
    schema_version: 1 as const,
    body_hash: 'bh0000000000',
    nodes: [
      { id: 's_intro', kind: 'section' as const, heading: 'Intro', level: 2, hash: hashA, start: 0, end: 15, parent_id: null },
      { id: 's_methods', kind: 'section' as const, heading: 'Methods', level: 2, hash: hashB, start: 15, end: 29, parent_id: null },
    ],
  })

  test('首笔写回冻结基线（上一轮末态），逐笔 diff 累积到 turn_complete 翻入 lastTurnChanges', () => {
    let s = sessionWithAssistant();
    // 上一轮末态（基线）：投影 hash-A 版本
    s = { ...s, lastDocBody: '## Intro\n旧内容。\n\n## Methods\n方法。', lastDocProjection: proj('h_intro_1', 'h_methods_1') };
    // 本轮第一笔写回：Intro 变了
    s = send(s, {
      type: 'doc_updated',
      body: '## Intro\n新内容。\n\n## Methods\n方法。',
      rev: 1,
      projection: proj('h_intro_2', 'h_methods_1'),
    });
    expect(s.turnDocBase?.body).toContain('旧内容。');
    expect(s.turnChanges?.sections.map((x) => x.id)).toEqual(['s_intro']);
    expect(s.turnChanges?.rows.s_intro?.length).toBeGreaterThan(0);
    // 第二笔：Methods 也变
    s = send(s, {
      type: 'doc_updated',
      body: '## Intro\n新内容。\n\n## Methods\n方法改。',
      rev: 2,
      projection: proj('h_intro_2', 'h_methods_2'),
    });
    expect(s.turnChanges?.sections.map((x) => x.id).sort()).toEqual(['s_intro', 's_methods']);
    // turn 完成 → 改动卡数据落 lastTurnChanges，累积态清零
    s = send(s, { type: 'turn_complete', assistant_event_idx: 9 });
    expect(s.lastTurnChanges?.sections.map((x) => x.id).sort()).toEqual(['s_intro', 's_methods']);
    expect(s.turnChanges).toBeUndefined();
    expect(s.turnDocBase).toBeUndefined();
    // 下一轮无写回 → 旧改动卡保留（不误清）
    s = send(s, { type: 'turn_started', event_idx: 10, patient_hash: null });
    s = send(s, { type: 'turn_complete', assistant_event_idx: 12 });
    expect(s.lastTurnChanges?.sections.length).toBe(2);
  })

  test('无投影的旧后端事件不产生改动卡（向后兼容）', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'doc_updated', body: 'v2', rev: 1 });
    s = send(s, { type: 'turn_complete', assistant_event_idx: 4 });
    expect(s.lastTurnChanges).toBeUndefined();
  })
})

/** #1025: 尝试分组 — 推理与工具按 loop(main/rescue)+round 归段。 */
describe('chat-reducer #1025 — attempts 分组', () => {
  test('首个工具前的推理归入准备段,工具调用补上真实 loop/round', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'reasoning_chunk', text: '准备推理' });
    s = send(s, { type: 'tool_call', tool: 'edit_document', args: {}, seq: 1, round: 1, loop: 'main' });
    const attempts = s.messages.at(-1)?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ loop: 'main', round: 1, seqs: [1] });
    expect(attempts[0].reasoning).toBe('准备推理');
  });

  test('换轮/换循环开新尝试;同轮多工具复用同一尝试', () => {
    let s = sessionWithAssistant();
    s = send(s, { type: 'tool_call', tool: 'edit_document', args: {}, seq: 1, round: 1, loop: 'main' });
    s = send(s, { type: 'tool_call', tool: 'insert_asset', args: {}, seq: 2, round: 1, loop: 'main' });
    s = send(s, { type: 'reasoning_chunk', text: '第二轮推理' });
    s = send(s, { type: 'tool_call', tool: 'edit_document', args: {}, seq: 3, round: 2, loop: 'main' });
    s = send(s, { type: 'tool_call', tool: 'edit_document', args: {}, seq: 4, round: 1, loop: 'rescue' });
    const attempts = s.messages.at(-1)?.attempts ?? [];
    expect(attempts.map((a) => ({ loop: a.loop, round: a.round, seqs: a.seqs }))).toEqual([
      { loop: 'main', round: 1, seqs: [1, 2] },
      { loop: 'main', round: 2, seqs: [3] },
      { loop: 'rescue', round: 1, seqs: [4] },
    ]);
    expect(attempts[1].reasoning).toBe('第二轮推理');
  });
});
