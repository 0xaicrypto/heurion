import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { PluginExtensionPoint } from '@/components/plugins/PluginExtensionPoint';
import { Alert, Button, Card, Input, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SchemaProperty {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

export function PluginSettingsPage() {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  const pluginId = namespace && name ? `${namespace}/${name}` : '';
  const navigate = useNavigate();

  const [schema, setSchema] = useState<Record<string, SchemaProperty> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!pluginId) return;
    setLoading(true);
    api
      .getPluginSettings(pluginId)
      .then((res) => {
        setSchema((res.schema?.properties || {}) as Record<string, SchemaProperty>);
        setValues((res.values || {}) as Record<string, unknown>);
      })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, [pluginId]);

  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!pluginId) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.savePluginSettings(pluginId, values);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/app/plugins')}>
            <ArrowLeft size={16} />
          </Button>
          <h1 className="font-semibold text-text-primary">Plugin Settings</h1>
          <span className="text-sm text-text-secondary">{pluginId}</span>
        </header>

        <main className="space-y-6 p-6">
          {error && <Alert variant="error">{error}</Alert>}

          {loading ? (
            <Card className="p-6 space-y-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </Card>
          ) : (
            <>
              <Card className="p-6 space-y-4">
                {schema && Object.entries(schema).length === 0 ? (
                  <p className="text-sm text-text-secondary">This plugin has no configurable settings.</p>
                ) : (
                  schema &&
                  Object.entries(schema).map(([key, prop]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-sm font-medium text-text-primary">
                        {prop.title || key}
                        {prop.description && (
                          <p className="text-xs font-normal text-text-tertiary">{prop.description}</p>
                        )}
                      </label>
                      {prop.enum ? (
                        <select
                          value={String(values[key] ?? prop.default ?? '')}
                          onChange={(e) => handleChange(key, e.target.value)}
                          className={cn(
                            'flex h-10 w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          )}
                        >
                          {prop.enum.map((opt) => (
                            <option key={String(opt)} value={String(opt)}>
                              {String(opt)}
                            </option>
                          ))}
                        </select>
                      ) : prop.type === 'boolean' ? (
                        <label className="flex items-center gap-2 text-sm text-text-secondary">
                          <input
                            type="checkbox"
                            checked={!!values[key]}
                            onChange={(e) => handleChange(key, e.target.checked)}
                            className="rounded border-border"
                          />
                          Enable
                        </label>
                      ) : (
                        <Input
                          type={prop.format === 'secret' ? 'password' : prop.type === 'number' ? 'number' : 'text'}
                          value={String(values[key] ?? prop.default ?? '')}
                          onChange={(e) =>
                            handleChange(key, prop.type === 'number' ? Number(e.target.value) : e.target.value)
                          }
                        />
                      )}
                    </div>
                  ))
                )}
                <div className="flex items-center gap-3 pt-2">
                  <Button onClick={handleSave} isLoading={saving} disabled={saving}>
                    <Save size={16} className="mr-1.5" />
                    Save
                  </Button>
                  {saved && <span className="text-sm text-success">Saved</span>}
                </div>
              </Card>

              <PluginExtensionPoint
                point="settings_page"
                context={{ pluginId }}
                fallback={null}
              />
            </>
          )}
        </main>
      </div>
    </AppShell>
  );
}
