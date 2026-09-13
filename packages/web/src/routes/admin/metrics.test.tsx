import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/render';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { AdminMetricsPage } from '@/routes/admin/metrics';
import { useAuthStore } from '@/stores/auth';

/** #1030: 记忆使用指标页 — 聚合卡片/表格 + 时间窗切换。 */

const mocks = vi.hoisted(() => ({
  getMemoryMetricsOverview: vi.fn(),
  getMemorySuggestionMetrics: vi.fn(),
  getMemoryGapMetrics: vi.fn(),
  getMemoryReferenceMetrics: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    getMemoryMetricsOverview: mocks.getMemoryMetricsOverview,
    getMemorySuggestionMetrics: mocks.getMemorySuggestionMetrics,
    getMemoryGapMetrics: mocks.getMemoryGapMetrics,
    getMemoryReferenceMetrics: mocks.getMemoryReferenceMetrics,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isAuthenticated: true, token: 't', userId: 'u1', displayName: 'Admin', role: 'admin' } as any);
  mocks.getMemoryMetricsOverview.mockResolvedValue({
    days: 14,
    totals: { events: 42, users: 3, sessions: 5 },
    byActionUnitType: [{ action: 'referenced', unitType: 'reference', count: 7 }],
    daily: [
      { date: '2026-09-12', action: 'referenced', count: 3 },
      { date: '2026-09-13', action: 'accepted', count: 4 },
    ],
  });
  mocks.getMemorySuggestionMetrics.mockResolvedValue({ days: 14, suggested: 10, accepted: 3, dismissed: 1, acceptRate: 0.75 });
  mocks.getMemoryGapMetrics.mockResolvedValue({ days: 14, detected: 4, answered: 2, answerRate: 0.5, usersWithGaps: 2 });
  mocks.getMemoryReferenceMetrics.mockResolvedValue({
    days: 14,
    items: [{ referenceId: 'r1', kind: 'pasted_text', label: '材料一', uses: 9, sessions: 4 }],
  });
});

describe('#1030 admin 记忆指标页', () => {
  test('渲染聚合卡片/表格并支持 14/30 天切换', async () => {
    render(<AdminMetricsPage />);

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText('材料一')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(mocks.getMemoryMetricsOverview).toHaveBeenCalledWith(14);

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    await waitFor(() => expect(mocks.getMemoryMetricsOverview).toHaveBeenCalledWith(30));
    await waitFor(() => expect(mocks.getMemoryReferenceMetrics).toHaveBeenCalledWith(30, 20));
  });
});
