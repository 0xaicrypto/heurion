import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

interface Props { children: ReactNode; }
interface State { hasError: boolean; }

class ErrorBoundaryInner extends Component<Props & { t: (k: string) => string }, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(): State { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="text-xl font-bold text-text-primary">{this.props.t('common.errorBoundary')}</h1>
          <p className="text-text-secondary">{this.props.t('common.errorBoundaryHint')}</p>
          <Button onClick={() => window.location.reload()}>{this.props.t('common.retry')}</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return <ErrorBoundaryInner t={t}>{children}</ErrorBoundaryInner>;
}
