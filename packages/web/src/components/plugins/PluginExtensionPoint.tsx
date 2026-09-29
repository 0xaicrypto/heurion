import { useEffect, useMemo, useRef } from 'react';
import { usePluginIframeFallbacks, usePluginRegistrations } from './PluginUIRegistry';

interface PluginExtensionPointProps {
  point: string;
  context?: unknown;
  fallback?: React.ReactNode;
  layout?: 'column' | 'row';
}

export function PluginExtensionPoint({ point, context, fallback, layout = 'column' }: PluginExtensionPointProps) {
  const registrations = usePluginRegistrations(point);
  const iframeFallbacks = usePluginIframeFallbacks(point);

  if (registrations.length === 0 && iframeFallbacks.length === 0) {
    return fallback ? <>{fallback}</> : null;
  }

  const isRow = layout === 'row';

  return (
    <div className={isRow ? 'flex flex-wrap items-center gap-2' : 'space-y-3'}>
      {registrations.map((registration) => (
        <PluginHost
          key={`${registration.pluginId}-${registration.extensionPointId}`}
          registration={registration}
          context={context}
          inline={isRow}
        />
      ))}
      {iframeFallbacks.map((fallbackEntry) => (
        <PluginIframeHost
          key={`iframe-${fallbackEntry.pluginId}-${fallbackEntry.extensionPointId}`}
          entry={fallbackEntry}
          inline={isRow}
        />
      ))}
    </div>
  );
}

function PluginHost({
  registration,
  context,
  inline,
}: {
  registration: ReturnType<typeof usePluginRegistrations>[number];
  context?: unknown;
  inline?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // #1135: closed shadow root 下 host.shadowRoot 恒为 null — 旧守卫失效,
  // 父组件重渲染(调用方均传内联 context 对象)/StrictMode 双跑 effect 会
  // 二次 attachShadow 抛 NotSupportedError,RouteBoundary 捕获后整页崩。
  // 缓存 root 实例复用(closed 模式没有可查询句柄,只能靠 ref)。
  const shadowRef = useRef<ShadowRoot | null>(null);
  // #1135: context 身份不稳定(内联字面量每次渲染新引用)→ 用内容 key 稳定
  // effect 依赖;内容不变时插件 DOM 不重建(每键重挂载的抖动一并消除)。
  const contextRef = useRef(context);
  contextRef.current = context;
  const contextKey = useMemo(() => {
    try {
      return JSON.stringify(context) ?? String(context);
    } catch {
      return String(context);
    }
  }, [context]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shadow = shadowRef.current ?? (shadowRef.current = host.attachShadow({ mode: 'closed' }));

    let mounted = true;
    shadow.innerHTML = '';
    Promise.resolve(registration.factory(contextRef.current))
      .then((node) => {
        if (!mounted) return;
        shadow.appendChild(node);
      })
      .catch((err) => {
        console.error(`Plugin ${registration.pluginId} failed to render extension ${registration.extensionPointId}`, err);
        const errorNode = document.createElement('div');
        errorNode.textContent = `Plugin render error`;
        shadow.appendChild(errorNode);
      });

    return () => {
      mounted = false;
      shadow.innerHTML = '';
    };
  }, [registration, contextKey]);

  return (
    <div
      ref={hostRef}
      data-plugin-id={registration.pluginId}
      data-extension-point={registration.extensionPointId}
      className={inline ? 'inline-block' : 'rounded-lg border border-border bg-surface p-1'}
    />
  );
}

function PluginIframeHost({
  entry,
  inline,
}: {
  entry: ReturnType<typeof usePluginIframeFallbacks>[number];
  inline?: boolean;
}) {
  return (
    <div
      data-plugin-id={entry.pluginId}
      data-extension-point={entry.extensionPointId}
      className={inline ? 'inline-block' : 'w-full'}
      style={{ minHeight: inline ? 40 : 256 }}
    >
      <iframe
        src={entry.url}
        title={`${entry.pluginName} plugin`}
        sandbox="allow-scripts"
        className="block h-full w-full rounded-lg border border-border bg-surface"
        style={{ minHeight: inline ? 40 : 256 }}
      />
    </div>
  );
}
