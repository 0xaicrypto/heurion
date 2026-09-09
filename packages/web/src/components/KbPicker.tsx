import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';

/**
 * #757 — shared knowledge-base picker modal (chat / writing references /
 * patient attachments). One interaction model everywhere: search + multi-select
 * with a per-context cap. Previously chat-only; writing required re-uploading
 * files that were already in the KB.
 */

export interface KbPickerItem {
  id: string;
  title: string;
  summary: string;
  kind: 'summary' | 'document';
}

interface KbPickerProps {
  open: boolean;
  onClose: () => void;
  /** Confirm current selection (id-kind pairs). */
  onConfirm: (items: KbPickerItem[]) => void;
  /** Pre-selected items (shown checked on open). #786: ids alone could not
   * work — checkboxes match on full items, so callers pass back what a
   * previous onConfirm gave them. */
  initialItems?: KbPickerItem[];
  /** Max items selectable for this context (chat=3). */
  max?: number;
}

export function KbPicker({ open, onClose, onConfirm, initialItems = [], max = 3 }: KbPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbPickerItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<KbPickerItem[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    // #786: seed pre-selections on open — the old effect compared but never
    // seeded, so re-opening always showed an empty selection.
    setPicked(initialItems);
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    handleSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSearch = async (q: string) => {
    setSearching(true);
    try {
      const r = await api.getKnowledgePicker(q);
      setResults(r.summaries || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  if (!open) return null;

  return (
    // #922: 弹窗外壳收敛到共享 Modal(backdrop 点击关闭 — 原行为保持)。
    <Modal
      open={open}
      onClose={onClose}
      backdropClose
      backdropClassName="bg-black/50"
      panelClassName="m-4 flex max-h-[70vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface-elevated p-6 shadow-xl"
    >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">📚 {t('chat.kbPicker', '从知识库添加')}</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={18} /></button>
        </div>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // #721: 300ms debounce — moved into the shared component so every
            // consumer gets it.
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => handleSearch(e.target.value), 300);
          }}
          placeholder={t('chat.kbSearch', '搜索知识库…')}
          className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex-1 space-y-2 overflow-y-auto">
          {searching ? (
            <p className="text-sm text-text-tertiary">…</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-text-tertiary">{t('chat.kbEmpty', '暂无匹配的知识条目')}</p>
          ) : (
            <>
              {/* #932: 按类型分组 — 总结(📝)与上传文件(📎)是两类资产,混排时
                  用户难以定位;同组内保持检索相关性排序。 */}
              {results.some((a) => a.kind === 'summary') && (
                <div>
                  <p className="mb-1 px-1 text-xs font-medium text-text-tertiary">
                    📝 {t('chat.kbGroupSummaries', '总结')} ({results.filter((a) => a.kind === 'summary').length})
                  </p>
                  <div className="space-y-2">
                    {results.filter((a) => a.kind === 'summary').map((a) => renderRow(a))}
                  </div>
                </div>
              )}
              {results.some((a) => a.kind === 'document') && (
                <div>
                  <p className="mb-1 px-1 text-xs font-medium text-text-tertiary">
                    📎 {t('chat.kbGroupDocuments', '文件')} ({results.filter((a) => a.kind === 'document').length})
                  </p>
                  <div className="space-y-2">
                    {results.filter((a) => a.kind === 'document').map((a) => renderRow(a))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
          <span className="text-xs text-text-tertiary">{t('chat.kbPicked', '已选 {{n}}/{{max}}', { n: picked.length, max })}</span>
          <Button size="sm" onClick={() => { onConfirm(picked); onClose(); }}>{t('chat.kbDone', '完成')}</Button>
        </div>
    </Modal>
  );

  function togglePick(a: KbPickerItem) {
    setPicked((prev) => prev.some((p) => p.id === a.id)
      ? prev.filter((p) => p.id !== a.id)
      : (prev.length >= max ? prev : [...prev, a]));
  }

  // #932: 行渲染抽出 — 分组 section 复用;文件标记移除(组头已标明类型)。
  function renderRow(a: KbPickerItem) {
    return (
      <label key={`${a.kind}:${a.id}`} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 hover:bg-surface">
        <input
          type="checkbox"
          checked={picked.some((p) => p.id === a.id)}
          disabled={!picked.some((p) => p.id === a.id) && picked.length >= max}
          onChange={() => togglePick(a)}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{a.title}</p>
          <p className="mt-0.5 truncate text-xs text-text-tertiary">{a.summary}</p>
        </div>
      </label>
    );
  }
}
