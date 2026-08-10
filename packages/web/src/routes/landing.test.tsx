import { screen, within } from '@testing-library/react';
import { LandingPage } from './landing';
import { render } from '@/test/render';

describe('LandingPage', () => {
  it('renders hero, pain points, dual-plane sections, and route examples', () => {
    render(<LandingPage />);

    expect(screen.getByRole('heading', { name: /give ai clinical memory and execution/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /three failure modes of medical llms/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /dual-plane architecture: brain \+ hands/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /built for three critical roles/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /why not chatgpt \/ rag\?/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /medical positioning & compliance/i })).toBeInTheDocument();
    expect(screen.getByText(/not a medical device/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /from conversation to action: three distinctive capabilities/i })).toBeInTheDocument();
    expect(screen.getAllByText(/browser automation/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/upload & interpret/i)).toBeInTheDocument();
    expect(screen.getByText(/generic ai chart generation/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /a real clinical research workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /partners & acknowledgements/i })).toBeInTheDocument();
    expect(screen.getAllByText(/cloudflare/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reactome/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/built on cloudflare workers/i)).toBeInTheDocument();

    const nav = screen.getByTestId('marketing-nav');
    expect(within(nav).getByRole('link', { name: /docs/i })).toHaveAttribute('href', '/docs/');
    expect(within(nav).getByRole('link', { name: /memory/i })).toHaveAttribute('href', '/memory');
    expect(within(nav).getByRole('link', { name: /reports/i })).toHaveAttribute('href', '/sidecar');
    expect(within(nav).getByRole('link', { name: /knowledge/i })).toHaveAttribute('href', '/knowledge');
    expect(within(nav).getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security');
  });
});
