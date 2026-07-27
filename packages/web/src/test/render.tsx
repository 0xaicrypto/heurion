import { ReactElement } from 'react';
import { render as rtlRender, RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';

// Test-only helper; fast-refresh rule does not apply here.
// eslint-disable-next-line react-refresh/only-export-components
function Providers({ children, initialEntries }: { children: React.ReactNode; initialEntries?: string[] }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </I18nextProvider>
  );
}

export function render(ui: ReactElement, options: RenderOptions & { initialEntries?: string[] } = {}) {
  const { initialEntries, ...rest } = options;
  return rtlRender(ui, { wrapper: ({ children }) => <Providers initialEntries={initialEntries}>{children}</Providers>, ...rest });
}
