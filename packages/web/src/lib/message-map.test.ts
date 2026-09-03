import { describe, test, expect } from 'vitest';
import { mapWireMessage } from './message-map';
import type { ChatWireMessage } from '@heurion/contracts';

/** #832-缺3: 时间线快照随 assistant_response metadata 落库 — 刷新后
 *  message-map 重建工具芯片与子代理结果卡。 */
describe('message-map — timeline restore (#832)', () => {
  test('restores toolCalls and subagents from metadata.timeline', () => {
    const wire: ChatWireMessage = {
      role: 'assistant',
      content: '最终回答',
      timestamp: new Date().toISOString(),
      metadata: {
        timeline: {
          tools: [
            { tool: 'search_medical_web', seq: 1, round: 1, argsPreview: '{"query":"asco"}', status: 'completed', resultPreview: 'PubMed results', elapsedMs: 900 },
            { tool: 'edit_document', seq: 2, round: 2, argsPreview: '{}', status: 'completed' },
            { tool: 'visit_medical_site', seq: 3, round: 2, argsPreview: '{"url":"x"}', status: 'error', resultPreview: 'HTTP 403', elapsedMs: 250 },
          ],
          subagents: [
            { id: 'sub_1', task: 'literature', status: 'done', summaryPreview: '3 RCTs', turns: 3, costTokens: 900 },
          ],
        },
      },
    };
    const msg = mapWireMessage(wire);
    expect(msg.toolCalls).toHaveLength(3);
    expect(msg.toolCalls?.[0]).toMatchObject({ tool: 'search_medical_web', seq: 1, round: 1, status: 'done', resultPreview: 'PubMed results', elapsedMs: 900 });
    expect(msg.toolCalls?.[2]?.status).toBe('error');
    expect(msg.subagents?.[0]).toMatchObject({ id: 'sub_1', status: 'done', summaryPreview: '3 RCTs', turns: 3 });
  });

  test('collapses stale running entries to done (defensive against dirty data)', () => {
    const wire: ChatWireMessage = {
      role: 'assistant',
      content: 'x',
      timestamp: new Date().toISOString(),
      metadata: {
        timeline: { tools: [{ tool: 'search_node', seq: 1, status: 'running' }] },
      },
    };
    const msg = mapWireMessage(wire);
    expect(msg.toolCalls?.[0]?.status).toBe('done');
    expect(msg.subagents).toBeUndefined();
  });

  test('plain messages without timeline keep the old shape', () => {
    const msg = mapWireMessage({ role: 'user', content: 'hi', timestamp: new Date().toISOString() });
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.subagents).toBeUndefined();
  });
});
