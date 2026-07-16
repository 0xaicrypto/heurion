import { useEffect, useState } from 'react';
import { Check, KeyRound, Shield, UserX, UserCheck, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api-client';
import type { AdminUser } from '@/lib/types';
import { Alert, Skeleton, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const load = () => {
    setLoading(true);
    api.listUsers()
      .then((r) => setUsers(r.users))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load users'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleDisable = async (userId: string) => {
    try {
      await api.disableUser(userId);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.messageText : 'Failed to disable user');
    }
  };

  const handleEnable = async (userId: string) => {
    try {
      await api.enableUser(userId);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.messageText : 'Failed to enable user');
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!resetPassword.trim()) return;
    try {
      await api.resetUserPassword(userId, resetPassword);
      setResetTarget(null);
      setResetPassword('');
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.messageText : 'Failed to reset password');
    }
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center border-b border-border bg-surface px-6">
          <h1 className="font-semibold text-text-primary">Admin — Users</h1>
        </header>
        <main className="p-6">
          {actionError && (
            <Alert variant="error" className="mb-4">{actionError}</Alert>
          )}
          {error && <Alert variant="error" className="mb-4">{error}</Alert>}

          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-secondary">
                    <th className="px-4 py-3 font-medium">Username</th>
                    <th className="px-4 py-3 font-medium">User ID</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.user_id} className={cn('border-b border-border', u.disabled_at && 'opacity-60')}>
                      <td className="px-4 py-3">
                        <span className="font-medium text-text-primary">{u.username}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-text-tertiary">{u.user_id.slice(0, 12)}…</span>
                      </td>
                      <td className="px-4 py-3">
                        {u.role === 'admin' ? (
                          <Badge variant="warning"><Shield size={12} className="mr-1 inline" />admin</Badge>
                        ) : (
                          <span className="text-text-secondary">user</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {u.disabled_at ? (
                          <Badge variant="error">disabled</Badge>
                        ) : u.has_password ? (
                          <Badge variant="success">active</Badge>
                        ) : (
                          <Badge>pending</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-tertiary">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {resetTarget === u.user_id ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="password"
                                value={resetPassword}
                                onChange={(e) => setResetPassword(e.target.value)}
                                placeholder="New password"
                                className="h-7 rounded border border-border bg-surface-elevated px-2 text-xs text-text-primary"
                                autoFocus
                              />
                              <button
                                onClick={() => handleResetPassword(u.user_id)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-success hover:bg-surface"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={() => { setResetTarget(null); setResetPassword(''); }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => {
                                  setResetTarget(u.user_id);
                                  setResetPassword('');
                                  setActionError(null);
                                }}
                                className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-text-secondary hover:bg-surface"
                                title="Reset password"
                              >
                                <KeyRound size={12} />
                              </button>
                              {u.disabled_at ? (
                                <button
                                  onClick={() => handleEnable(u.user_id)}
                                  className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-success hover:bg-surface"
                                  title="Enable"
                                >
                                  <UserCheck size={12} />
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleDisable(u.user_id)}
                                  className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-warning hover:bg-surface"
                                  title="Disable"
                                >
                                  <UserX size={12} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
