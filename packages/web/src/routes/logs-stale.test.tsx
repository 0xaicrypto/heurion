import { describe, test, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import i18n from '@/i18n';

/**
 * #1147 — logs 翻页/筛选的过期响应回归：此前无请求序号，慢的旧请求后到
 * 会覆盖新页结果（快速翻页闪回上一页数据）。
 */
const mocks = vi.hoisted(() => ({
  listInstalledPlugins: vi.fn(),
  getPluginAuditLogs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listInstalledPlugins: mocks.listInstalledPlugins,
      getPluginAuditLogs: mocks.getPluginAuditLogs,
    },
  };
});

import { LogsSection } from './logs';

const logOf = (toolName: string) => ({
  id: toolName,
  pluginId: 'p1',
  toolName,
  jobId: 'j1',
  status: 'completed',
  durationMs: 5,
  createdAt: '2026-01-01T00:00:00Z',
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  mocks.listInstalledPlugins.mockReset().mockResolvedValue({ plugins: [{ pluginId: 'p1', name: 'P1' }] });
  mocks.getPluginAuditLogs.mockReset();
});

describe('#1147 logs 过期响应', () => {
  test('慢的旧请求后到不覆盖新页结果', async () => {
    let resolveOld!: (v: { logs: unknown[]; total: number }) => void;
    mocks.getPluginAuditLogs
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; })) // 挂载首请求（旧筛选）
      .mockImplementation(async () => ({ logs: [logOf('新页工具')], total: 1 }));

    render(<LogsSection />);
    // 等首请求挂起、筛选控件可用后切换插件 → 第二次请求（新结果）
    await screen.findByText('P1 (p1)');
    const pluginSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(pluginSelect, { target: { value: 'p1' } });

    expect(await screen.findByText('新页工具')).toBeInTheDocument();

    // 旧请求现在才返回 — 修复前会覆盖掉新结果。
    resolveOld({ logs: [logOf('旧页工具')], total: 99 });
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() => expect(screen.queryByText('旧页工具')).not.toBeInTheDocument());
    expect(screen.getByText('新页工具')).toBeInTheDocument();
  });
});
