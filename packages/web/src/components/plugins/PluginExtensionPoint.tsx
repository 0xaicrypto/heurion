import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (host.shadowRoot) return;

    const shadow = host.attachShadow({ mode: 'closed' });

    let mounted = true;
    Promise.resolve(registration.factory(context))
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
  }, [registration, context]);

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
