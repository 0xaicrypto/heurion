import { useEffect, useRef } from 'react';
import { usePluginRegistrations } from './PluginUIRegistry';

interface PluginExtensionPointProps {
  point: string;
  context?: unknown;
  fallback?: React.ReactNode;
}

export function PluginExtensionPoint({ point, context, fallback }: PluginExtensionPointProps) {
  const registrations = usePluginRegistrations(point);

  if (registrations.length === 0) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <div className="space-y-3">
      {registrations.map((registration) => (
        <PluginHost key={`${registration.pluginId}-${registration.extensionPointId}`} registration={registration} context={context} />
      ))}
    </div>
  );
}

function PluginHost({
  registration,
  context,
}: {
  registration: ReturnType<typeof usePluginRegistrations>[number];
  context?: unknown;
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
        // eslint-disable-next-line no-console
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
      className="rounded-lg border border-border bg-surface p-1"
    />
  );
}
