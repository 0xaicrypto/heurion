import { ApiCore } from './core.js';
import type { AdminUser } from '../../types';

export class AdminApi extends ApiCore {
  /* ────────────────────────── admin ────────────────────────── */

  async listUsers(): Promise<{ users: AdminUser[] }> {
    return this.fetch<{ users: AdminUser[] }>('/api/v1/admin/users');
  }

  async disableUser(userId: string): Promise<{ user_id: string; disabled_at: string; ok: boolean }> {
    return this.fetch(`/api/v1/admin/users/${userId}/disable`, { method: 'POST' });
  }

  async enableUser(userId: string): Promise<{ user_id: string; disabled_at: null; ok: boolean }> {
    return this.fetch(`/api/v1/admin/users/${userId}/enable`, { method: 'POST' });
  }

  async resetUserPassword(userId: string, newPassword: string): Promise<{ user_id: string; ok: boolean }> {
    return this.fetch(`/api/v1/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ new_password: newPassword }),
    });
  }

  /* ────────── #1030: 记忆使用观察指标（admin-only，只读聚合） ────────── */

  async getMemoryMetricsOverview(days: number): Promise<{
    days: number;
    totals: { events: number; users: number; sessions: number };
    byActionUnitType: Array<{ action: string; unitType: string; count: number }>;
    daily: Array<{ date: string; action: string; count: number }>;
  }> {
    return this.fetch(`/api/v1/admin/metrics/memory/overview?days=${days}`);
  }

  async getMemorySuggestionMetrics(days: number): Promise<{
    days: number;
    suggested: number;
    accepted: number;
    dismissed: number;
    acceptRate: number | null;
  }> {
    return this.fetch(`/api/v1/admin/metrics/memory/suggestions?days=${days}`);
  }

  async getMemoryGapMetrics(days: number): Promise<{
    days: number;
    detected: number;
    answered: number;
    answerRate: number | null;
    usersWithGaps: number;
  }> {
    return this.fetch(`/api/v1/admin/metrics/memory/gaps?days=${days}`);
  }

  async getMemoryReferenceMetrics(days: number, limit = 20): Promise<{
    days: number;
    items: Array<{ referenceId: string; kind: string; label: string; uses: number; sessions: number }>;
  }> {
    return this.fetch(`/api/v1/admin/metrics/memory/references?days=${days}&limit=${limit}`);
  }

}
