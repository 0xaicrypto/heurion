import { FilesApi } from './files.js';
import type { AdminUser } from '../../types';

export class AdminApi extends FilesApi {
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

}
