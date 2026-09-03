import { describe, test, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import type { ChatContextUsage } from '@/lib/types';

// i18n 异步 init 且 jsdom 探测为 en — 测试固定 zh-CN（#798: 文案走 i18n）。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const usage = (over: Partial<ChatContextUsage>): ChatContextUsage => ({
  historyTokens: 400,
  historyBudget: 8000,
  historyTurns: 20,
  omittedTurns: 0,
  willCompact: false,
  ...over,
});

/** #fix: will_compact 双触发源 — 低百分比时必须说明是轮次窗口触发。 */
describe('ContextUsageIndicator — compaction trigger attribution', () => {
  test('low token pct + willCompact explains the turn-window trigger', () => {
    render(<ContextUsageIndicator usage={usage({ willCompact: true })} />);
    expect(screen.getByText('5%')).toBeTruthy();
    expect(screen.getByText(/对话已达 20 轮窗口，下一句自动压缩/)).toBeTruthy();
    expect(screen.queryByText('即将压缩')).toBeNull();
  });

  test('high token pct keeps the plain trigger label', () => {
    render(
      <ContextUsageIndicator
        usage={usage({ historyTokens: 7200, willCompact: true })}
      />,
    );
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText('即将压缩')).toBeTruthy();
  });

  test('no red label when willCompact is false', () => {
    render(<ContextUsageIndicator usage={usage({ willCompact: false })} />);
    expect(screen.queryByText(/即将压缩/)).toBeNull();
  });
});
