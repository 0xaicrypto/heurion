import { describe, test, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '@/i18n';
import { ActivityTimeline } from './ActivityTimeline';
import type { ChatMessage } from '@/lib/chat-reducer';

// i18n 异步 init 且 jsdom 探测为 en — 测试固定 zh-CN，断言与 zh 文案同源
// （#798: 组件文案必须走 i18n，不硬编码）。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'assistant', text: '', isStreaming: true, ...overrides };
}

/** #832 — 任务活动时间线：分层信息架构（状态行/折叠行/展开）。 */
describe('ActivityTimeline (#832)', () => {
  test('renders nothing for a plain text message without activity', () => {
    const { container } = render(<ActivityTimeline message={baseMessage({ text: '回答' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('status line shows current running tool and stall hint (#828)', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          toolCalls: [{ tool: 'visit_medical_site', argsPreview: '{"url":"x"}', status: 'running', seq: 3, startedAt: Date.now() - 65_000 }],
        })}
        stallSince={Date.now() - 95_000}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('读取网页'); // TOOL_LABELS mapping
    expect(line.textContent).toContain('无新进展'); // #828 stall hint
  });

  test('consecutive completed read-only tools fold into one row with failure count', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          isStreaming: false,
          toolCalls: [
            { tool: 'search_medical_web', argsPreview: 'q1', status: 'done', seq: 1, resultPreview: '5 篇命中', elapsedMs: 900 },
            { tool: 'visit_medical_site', argsPreview: 'u', status: 'error', seq: 2, resultPreview: 'HTTP 429', elapsedMs: 100 },
            { tool: 'generate_image', argsPreview: 'p', status: 'done', seq: 3, elapsedMs: 2500 },
          ],
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('检索/读取 · 2'); // fold group (read-only pair)
    expect(line.textContent).toContain('1 失败'); // per-item failures visible (#832 gap 4)
    expect(line.textContent).toContain('生成图片'); // non-read-only stays its own row
    // Expand the fold — per-item previews become visible.
    fireEvent.click(screen.getByText(/检索\/读取 · 2/));
    expect(line.textContent).toContain('5 篇命中');
    expect(line.textContent).toContain('HTTP 429');
  });

  test('#408-followup 失败工具卡显示「查看原因」入口,展开后可见真实错误', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          isStreaming: false,
          toolCalls: [{ tool: 'edit_document', argsPreview: '{}', status: 'error', seq: 1, resultPreview: 'old_text 未找到', elapsedMs: 120 }],
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('查看原因');
    fireEvent.click(screen.getByText('查看原因'));
    expect(screen.getByText(/old_text 未找到/)).toBeTruthy();
    // 展开后提示翻转 — 入口语义随状态变化。
    expect(screen.getByText('收起')).toBeTruthy();
  });

  test('subagent rows show live phase and collapse into a result preview (#831)', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          subagents: [
            { id: 'sub_1', task: 'literature review', status: 'running', phase: 'tool', currentTool: 'search_medical_web', turn: 2, maxTurns: 4, startedAt: Date.now() - 5000 },
            { id: 'sub_2', task: 'stats check', status: 'done', turns: 2, costTokens: 800, summaryPreview: 'p<0.05 significant' },
          ],
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('literature review');
    expect(line.textContent).toContain('调用工具'); // PHASE_LABEL
    expect(line.textContent).toContain('2/4'); // turn progress
    expect(line.textContent).toContain('stats check');
    // Result details live in the expandable panel (#831). Click the row
    // buttons (not the status-line echo of the task name).
    const buttons = Array.from(line.querySelectorAll('button'));
    fireEvent.click(buttons.find((b) => b.textContent?.includes('2/4'))!);
    expect(line.textContent).toContain('search_medical_web');
    fireEvent.click(buttons.find((b) => b.textContent?.includes('stats check'))!);
    expect(line.textContent).toContain('p<0.05 significant');
    expect(line.textContent).toContain('800 tokens');
  });

  test('round changes render a divider row (#832 round grouping)', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          isStreaming: false,
          toolCalls: [
            { tool: 'search_medical_web', argsPreview: 'q1', status: 'done', seq: 1, round: 1, elapsedMs: 100 },
            { tool: 'search_medical_web', argsPreview: 'q2', status: 'done', seq: 2, round: 2, elapsedMs: 100 },
          ],
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('第 2 轮'); // divider between round 1 → 2
    expect(line.textContent).toContain('检索/读取'); // both folded
  });

  test('reasoning is collapsed by default with a tail preview while streaming', () => {
    const { container } = render(
      <ActivityTimeline
        message={baseMessage({
          reasoning: '分析问题的第一步...\n接下来需要检索证据...\n最终得出结论。',
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('推理中'); // streaming summary label
    // Tail (last ~2 lines) is visible, the full dump is not (#832 gap 5).
    expect(line.textContent).toContain('最终得出结论');
    expect(line.textContent).not.toContain('分析问题的第一步');
    expect(container.querySelector('details')).toBeNull(); // no <details open> dump
  });

  test('长任务生成间隙:状态行显示思考中 + 最近轮次,不粘住开局 streamNote', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          reasoning: '继续分析失败原因……',
          toolCalls: [
            { tool: 'edit_document', argsPreview: '{}', status: 'done', seq: 1, round: 2, elapsedMs: 500 },
          ],
        })}
        streamNote="上下文就绪，AI 正在生成…（长任务可能需要数分钟）"
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    // 工具间隙 = 模型在生成下一轮 → 显示思考中,且带最近轮次(进度可见)
    expect(line.textContent).toContain('思考中');
    expect(line.textContent).toContain('第 2 轮');
    expect(line.textContent).not.toContain('上下文就绪');
  });

  test('首个工具执行前:streamNote 仍作为等待期提示', () => {
    render(
      <ActivityTimeline
        message={baseMessage({ reasoning: '拆解任务……' })}
        streamNote="上下文就绪，AI 正在生成…（长任务可能需要数分钟）"
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('上下文就绪');
  });
});

/** #1025: 尝试列表 — 按循环/轮次分组展示,不再揉成一条推理流。 */
describe('ActivityTimeline #1025 — 尝试分组', () => {
  test('主循环与 rescue 分组展示,各自推理量可见', () => {
    render(
      <ActivityTimeline
        message={baseMessage({
          isStreaming: false,
          attempts: [
            { loop: 'main', round: 1, reasoning: '第一轮推理内容', seqs: [1] },
            { loop: 'rescue', round: 1, reasoning: '精简重试推理', seqs: [2] },
          ],
          toolCalls: [
            { tool: 'edit_document', argsPreview: '{}', status: 'done', seq: 1, round: 1, loop: 'main', elapsedMs: 500 },
            { tool: 'edit_document', argsPreview: '{}', status: 'error', seq: 2, round: 1, loop: 'rescue', resultPreview: 'old_text 未找到' },
          ],
        })}
      />,
    );
    const line = screen.getByTestId('activity-timeline');
    expect(line.textContent).toContain('主循环');
    expect(line.textContent).toContain('精简重试');
    // 推理默认折叠 — 展开后可见各自内容（尝试分组不混流）
    fireEvent.click(screen.getAllByText(/推理完成/)[0]);
    expect(line.textContent).toContain('第一轮推理内容');
    fireEvent.click(screen.getAllByText(/推理完成/)[1]);
    expect(line.textContent).toContain('精简重试推理');
    expect(line.querySelectorAll('button').length).toBeGreaterThanOrEqual(4); // 2 reasoning + 2 tool rows
  });
})
