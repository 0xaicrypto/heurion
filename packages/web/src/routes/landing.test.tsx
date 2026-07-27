import { screen } from '@testing-library/react';
import { LandingPage } from './landing';
import { render } from '@/test/render';

describe('LandingPage', () => {
  it('renders hero, three pillars, and route examples', () => {
    render(<LandingPage />);

    expect(screen.getByRole('heading', { name: /self-evolving clinical ai workstation/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /four-layer memory/i })).toHaveAttribute('href', '/memory');
    expect(screen.getByRole('link', { name: /medsci-sidecar/i })).toHaveAttribute('href', '/sidecar');
    expect(screen.getByRole('link', { name: /evolving knowledge base/i })).toHaveAttribute('href', '/knowledge');
    expect(screen.getByText(/route first, then project/i)).toBeInTheDocument();
    expect(screen.getByText(/security & isolation/i)).toBeInTheDocument();
  });
});
