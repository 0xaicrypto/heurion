import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { LoginPage } from './login';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/api-client', () => ({
  api: {
    sendVerificationCode: vi.fn().mockResolvedValue({ ok: true }),
    resetPassword: vi.fn().mockResolvedValue({ ok: true }),
    login: vi.fn(),
    register: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

describe('LoginPage reset-password flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Avoid the authenticated-redirect effect.
    useAuthStore.setState({ isAuthenticated: false });
  });

  it('shows the forgot-password link and walks through send-code → reset', async () => {
    render(<LoginPage />, { initialEntries: ['/login'] });

    fireEvent.click(screen.getByText('Forgot password?'));

    expect(await screen.findByText('Send code')).toBeTruthy();

    const emailInput = screen.getByPlaceholderText('you@example.com');
    fireEvent.change(emailInput, { target: { value: 'doc@example.com' } });
    fireEvent.click(screen.getByText('Send code'));

    await waitFor(() => {
      expect(screen.getByText('6-digit code')).toBeTruthy();
    });

    const code = screen.getAllByPlaceholderText('6-digit code')[0];
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('at least 8 characters'), { target: { value: 'brandnew123' } });
    fireEvent.click(screen.getByText('Reset password'));

    await waitFor(() => {
      expect(screen.getByText('Password reset — sign in with the new password.')).toBeTruthy();
    });
  });

  it('rejects short new passwords before calling the API', async () => {
    render(<LoginPage />, { initialEntries: ['/login?mode=reset'] });

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'doc@example.com' } });
    fireEvent.click(screen.getByText('Send code'));

    await waitFor(() => {
      expect(screen.getByText('6-digit code')).toBeTruthy();
    });

    fireEvent.change(screen.getAllByPlaceholderText('6-digit code')[0], { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('at least 8 characters'), { target: { value: 'short' } });
    fireEvent.click(screen.getByText('Reset password'));

    expect(await screen.findByText('Password must be at least 8 characters')).toBeTruthy();
  });
});
