import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useThemeStore } from '@/stores/theme';
import { cn } from '@/lib/utils';

/**
 * 主题切换菜单(light / dark / system)。
 * AppShell 与应用内共用;MarketingShell(landing 等营销页)同样需要。
 */
export function ThemeMenu({ placement = 'bottom-full' }: { placement?: 'bottom-full' | 'top-full' }) {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeStore();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        aria-label={t('common.theme')}
        title={t('common.theme')}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {mode === 'dark' ? <Moon size={18} /> : mode === 'light' ? <Sun size={18} /> : <Monitor size={18} />}
      </button>
      {open && (
        <div
          className={`absolute ${placement} left-0 ${placement === 'bottom-full' ? 'mb-2' : 'mt-2'} w-32 rounded-lg border border-border bg-surface-elevated p-1 shadow-lg`}
          onMouseLeave={() => setOpen(false)}
        >
          {(['light', 'dark', 'system'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-text-primary hover:bg-surface',
                mode === m && 'bg-surface',
              )}
            >
              {m === 'light' && <Sun size={14} />}
              {m === 'dark' && <Moon size={14} />}
              {m === 'system' && <Monitor size={14} />}
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
