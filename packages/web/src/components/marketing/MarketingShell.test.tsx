import { screen, within } from '@testing-library/react';
import { MarketingShell } from './MarketingShell';
import { render } from '@/test/render';

describe('MarketingShell', () => {
  it('renders app name and top-level navigation', () => {
    render(
      <MarketingShell>
        <div data-testid="content">page content</div>
      </MarketingShell>,
    );

    expect(screen.getByRole('link', { name: /Heurion/i })).toHaveAttribute('href', '/');

    const nav = screen.getByTestId('marketing-nav');
    expect(within(nav).getByRole('link', { name: /memory/i })).toHaveAttribute('href', '/memory');
    expect(within(nav).getByRole('link', { name: /reports/i })).toHaveAttribute('href', '/sidecar');
    expect(within(nav).getByRole('link', { name: /knowledge/i })).toHaveAttribute('href', '/knowledge');
    expect(within(nav).getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security');
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('marks the active subpage in navigation', () => {
    render(
      <MarketingShell>
        <div>page content</div>
      </MarketingShell>,
      { initialEntries: ['/security'] },
    );

    const nav = screen.getByTestId('marketing-nav');
    const activeLink = within(nav).getByRole('link', { name: /security/i });
    expect(activeLink).toHaveClass('text-accent');
  });
});
