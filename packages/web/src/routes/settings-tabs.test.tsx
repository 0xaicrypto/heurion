import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { SettingsPage } from './settings';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/api', () => ({
  api: {
    getUserProfile: vi.fn().mockResolvedValue({ user_id: 'u1', display_name: 'T' }),
    updateUserProfile: vi.fn(),
    testLlm: vi.fn(),
    updateLlmSettings: vi.fn(),
    getLlmStatus: vi.fn().mockResolvedValue({ provider: 'deepseek', model: 'x', healthy: true, latency_ms: 10 }),
    getAdminLlmCostDashboard: vi.fn().mockResolvedValue({ models: [], totals: {}, per_day: [] }),
    getEvolutionQueueMetrics: vi.fn().mockResolvedValue({ pending: 0, running: 0, recent: [] }),
    listAuditLogs: vi.fn().mockResolvedValue({ logs: [] }),
    listInstalledPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    getPluginAuditLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
  },
  ApiError: class ApiError extends Error {},
}));

describe('SettingsPage merged audit/logs tabs (#341)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: true });
  });

  it('shows audit and logs tabs and switches content', async () => {
    render(<SettingsPage />, { initialEntries: ['/app/settings'] });

    fireEvent.click(screen.getByText('Audit'));
    expect(await screen.findByText('All target types')).toBeTruthy();

    fireEvent.click(screen.getByText('Logs'));
    expect(await screen.findByText('All plugins')).toBeTruthy();
  });

  it('opens directly on the audit tab via ?tab=audit', async () => {
    render(<SettingsPage />, { initialEntries: ['/app/settings?tab=audit'] });

    expect(await screen.findByText('All target types')).toBeTruthy();
  });
});
