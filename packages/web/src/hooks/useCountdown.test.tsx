import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { ResendControl } from '@/components/ResendControl';

vi.mock('@/lib/api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));

describe('ResendControl (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a countdown after first render in idle state then offers resend', async () => {
    render(<ResendControl onResend={vi.fn()} seconds={1} />);

    expect(screen.getByText(/Resend \(1s\)/)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Resend code')).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('fires onResend when clicked', async () => {
    const onResend = vi.fn();
    render(<ResendControl onResend={onResend} seconds={1} />);

    await waitFor(() => {
      expect(screen.getByText('Resend code')).toBeTruthy();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByText('Resend code'));
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Resend \(1s\)/)).toBeTruthy();
  });
});
