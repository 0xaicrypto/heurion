import { describe, test, expect } from 'vitest';
import { createToolCallStreamFilter, stripToolCallBlocks } from '../../src/modules/chat/tool-call-text.js';

/** #1033: `<tool_call>` 清理 — 终态文本 + 流式通道（含跨 chunk / 未闭合）。 */
describe('#1033 tool-call 文本清理', () => {
  test('stripToolCallBlocks: 闭合块删除，正常文本保留', () => {
    expect(stripToolCallBlocks('前言<tool_call>{"name":"a"}</tool_call>后记')).toBe('前言后记');
    expect(stripToolCallBlocks('<tool_call>{"a":1}</tool_call>\n<tool_call>{"b":2}</tool_call>')).toBe('');
    expect(stripToolCallBlocks('正常回答')).toBe('正常回答');
    expect(stripToolCallBlocks('')).toBe('');
    expect(stripToolCallBlocks(null)).toBe('');
  });

  test('stripToolCallBlocks: 未闭合块从标记处丢弃余下文本', () => {
    expect(stripToolCallBlocks('前言<tool_call>{"name":"a"')).toBe('前言');
    expect(stripToolCallBlocks('合法说明</tool_call>残块')).toBe('合法说明残块');
  });

  test('stream filter: 跨 chunk 标记被拦住，其余立即透传', () => {
    const f = createToolCallStreamFilter();
    let out = '';
    out += f.push('回答开始');
    out += f.push('<tool_');
    out += f.push('call>{"name":"render_scene"}');
    out += f.push('</tool_call>回答继续');
    out += f.flush();
    expect(out).toBe('回答开始回答继续');
  });

  test('stream filter: 未闭合块在 flush 时整体丢弃', () => {
    const f = createToolCallStreamFilter();
    let out = '';
    out += f.push('前言');
    out += f.push('<tool_call>{"name":"x"}');
    out += f.flush();
    expect(out).toBe('前言');
  });

  test('stream filter: 无标记文本逐块透传，不吞尾字符', () => {
    const f = createToolCallStreamFilter();
    expect(f.push('hello ')).toBe('hello ');
    expect(f.push('world')).toBe('world');
    expect(f.flush()).toBe('');
  });
});
