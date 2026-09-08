import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** #919: 当 key 变化（路由切换）时自动清除错误态并重新挂载子树。 */
  resetKey?: string;
  /** #919: route 级用 inline 紧凑样式，根级仍是整页接管。 */
  variant?: 'page' | 'inline';
}
interface State { hasError: boolean; resetKey?: string; }

class ErrorBoundaryInner extends Component<Props & { t: (k: string) => string }, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(): State { return { hasError: true }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // #919: resetKey 变化（跳转到另一个路由）→ 自动复位，上一个页面的
    // 崩溃不应污染下一个页面。
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, resetKey: props.resetKey };
    }
    return null;
  }

  /** inline 重试：复位后子树重新挂载（错误期间子树已被卸载）。 */
  private retryInline = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      const { t, variant } = this.props;
      if (variant === 'inline') {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
            <h2 className="text-sm font-semibold text-text-primary">{t('common.errorBoundary')}</h2>
            <p className="max-w-sm text-xs text-text-secondary">{t('common.errorBoundaryHint')}</p>
            <Button size="sm" variant="secondary" onClick={this.retryInline}>{t('common.retry')}</Button>
          </div>
        );
      }
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="text-xl font-bold text-text-primary">{t('common.errorBoundary')}</h1>
          <p className="text-text-secondary">{t('common.errorBoundaryHint')}</p>
          <Button onClick={() => window.location.reload()}>{t('common.retry')}</Button>
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

/** #919: 路由级边界 — 单个 /app/* 页面崩溃不再白屏整个应用，换页自动复位。 */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <ErrorBoundaryInner t={t} resetKey={location.pathname} variant="inline">
      {children}
    </ErrorBoundaryInner>
  );
}
