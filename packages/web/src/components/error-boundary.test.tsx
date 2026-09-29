import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';

/**
 * #1147 — ErrorBoundary 崩溃上报回归：此前只有降级 UI，componentDidCatch
 * 缺失 → 生产崩溃无任何痕迹。
 */
import { ErrorBoundary } from './ErrorBoundary';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  delete (globalThis as { __heurionErrorReporter?: unknown }).__heurionErrorReporter;
});

function Boom(): never {
  throw new Error('boom-for-boundary-test');
}

describe('#1147 ErrorBoundary 上报', () => {
  test('componentDidCatch 调宿主 reporter + console.error 留痕', () => {
    const reporter = vi.fn();
    (globalThis as { __heurionErrorReporter?: unknown }).__heurionErrorReporter = reporter;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(reporter).toHaveBeenCalledTimes(1);
    const [err, info] = reporter.mock.calls[0] as [Error, { componentStack?: string }];
    expect(err.message).toBe('boom-for-boundary-test');
    expect(String(info?.componentStack)).toContain('Boom');
    expect(errSpy).toHaveBeenCalledWith(
      '[ErrorBoundary]',
      expect.any(Error),
      expect.anything(),
    );
    // 降级 UI 仍在（上报不改变原有行为）
    expect(screen.getByText('出现错误')).toBeInTheDocument();

    errSpy.mockRestore();
  });

  test('未注入 reporter 时仅 console.error（不抛）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith('[ErrorBoundary]', expect.any(Error), expect.anything());
    errSpy.mockRestore();
  });
});
