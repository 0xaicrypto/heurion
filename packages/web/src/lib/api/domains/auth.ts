import { ApiCore } from './core.js';
import type { AuthSession, UserProfile } from '../../types';

export class AuthApi extends ApiCore {
  /* ────────────────────────── auth ────────────────────────── */

  async register(input: {
    username: string;
    password: string;
    displayName?: string;
    email?: string;
    code?: string;
  }): Promise<AuthSession> {
    const body: Record<string, string> = {
      username: input.username,
      password: input.password,
    };
    if (input.displayName?.trim()) body.display_name = input.displayName.trim();
    if (input.email?.trim()) body.email = input.email.trim();
    if (input.code) body.code = input.code;

    const r = await this.fetch<{
      user_id: string;
      jwt_token: string;
      created_at: string;
      role: string;
      expires_in_seconds: number;
    }>('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(body) });

    this.storeSession({ jwt_token: r.jwt_token, user_id: r.user_id, display_name: input.displayName?.trim() || input.username });

    return {
      token: r.jwt_token,
      userId: r.user_id,
      role: r.role === 'admin' ? 'admin' : 'user',
      displayName: input.displayName?.trim() || input.username,
      expiresInSeconds: r.expires_in_seconds,
    };
  }

  async login(username: string, password: string): Promise<AuthSession> {
    const r = await this.fetch<{
      jwt_token: string;
      expires_in_seconds: number;
      user_id: string;
      role: string;
      display_name: string | null;
    }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    const displayName = r.display_name || username;
    this.storeSession({ jwt_token: r.jwt_token, user_id: r.user_id, display_name: displayName });

    return {
      token: r.jwt_token,
      userId: r.user_id,
      role: r.role === 'admin' ? 'admin' : 'user',
      displayName,
      expiresInSeconds: r.expires_in_seconds,
    };
  }

  /* ────────────────────────── user profile ────────────────────────── */

  async getUserProfile(): Promise<UserProfile> {
    return this.fetch<UserProfile>('/api/v1/user/profile');
  }

  /* ────────────────────────── email verification (#285) ────────── */

  async sendVerificationCode(email: string, purpose: 'register' | 'bind' | 'reset'): Promise<{ ok: boolean; expires_in: number }> {
    return this.fetch('/api/v1/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) });
  }

  async bindEmail(email: string, code: string): Promise<{ ok: boolean; email: string; email_verified: boolean }> {
    return this.fetch('/api/v1/auth/bind-email', { method: 'POST', body: JSON.stringify({ email, code }) });
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.fetch('/api/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });
  }

  async updateUserProfile(data: Partial<Pick<UserProfile, 'display_name' | 'organization' | 'intended_use'>>): Promise<UserProfile> {
    return this.fetch<UserProfile>('/api/v1/user/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

}
