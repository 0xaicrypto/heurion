import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, FilePlus, X } from 'lucide-react';
import { Button, Skeleton } from '@/components/ui';
import type { PhiFinding } from './types';

/** #696: PHI 高亮渲染抽为组件(原 94 行内联 JSX)。 */
export function HighlightedBody({ body, findings }: { body: string; findings: PhiFinding[] }) {
  if (!findings || findings.length === 0) return null;
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  const parts: JSX.Element[] = [];
  let cursor = 0;
  sorted.forEach((f, i) => {
    if (f.start > cursor) {
      parts.push(<span key={`txt-${i}`}>{body.slice(cursor, f.start)}</span>);
    }
    parts.push(
      <mark key={`phi-${i}`} className="bg-error/20 text-error rounded-sm px-0.5" title={f.suggestion}>
        {body.slice(f.start, f.end)}
      </mark>,
    );
    cursor = f.end;
  });
  if (cursor < body.length) {
    parts.push(<span key="txt-end">{body.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

/** #598: History 版本列表 — 悬浮窗选择 snapshot(无需滚动到底部)。 */
export function HistoryDialog(input: {
  snapshots: Array<{ snapshot_id: string; created_at: string; body_preview: string }>;
  snapshotsLoading: boolean;
  restoring: string | null;
  /** #910: Restore × 审阅互斥 — 审阅未决时禁用 Restore(与路由守卫同步)。 */
  reviewBlocked?: boolean;
  onClose: () => void;
  onRestore: (snapshotId: string) => void;
}) {
  const { snapshots, snapshotsLoading, restoring, reviewBlocked, onClose, onRestore } = input;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface-elevated p-6 shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">历史版本 (Snapshots)</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {snapshotsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-text-tertiary">No snapshots available</p>
          ) : (
            snapshots.map((s) => (
              <div key={s.snapshot_id} className="flex items-start justify-between rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-text-tertiary">{new Date(s.created_at).toLocaleString()}</p>
                  <p className="mt-1 truncate text-sm text-text-secondary">{s.body_preview || '(empty)'}</p>
                </div>
                {/* #910: 审阅未决时 Restore 禁用 — 避免 Restore diff 顶掉正在进行的 AI 修改审阅。 */}
                <Button size="sm" variant="ghost" onClick={() => onRestore(s.snapshot_id)} disabled={restoring === s.snapshot_id || reviewBlocked} isLoading={restoring === s.snapshot_id} title={reviewBlocked ? '请先处理当前的 AI 修改审阅' : undefined}>
                  Restore
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** PHI Findings Dialog(#696: HighlightedBody 组件化)。 */
export function PhiDialog({ body, findings, onClose }: { body: string; findings: PhiFinding[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">PHI Findings</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-text-secondary mb-4">
          Found {findings.length} potential PHI instance{findings.length !== 1 ? 's' : ''} in the document. Review and manually redact as needed.
        </p>
        <div className="rounded-lg border border-border bg-surface p-4 mb-4 max-h-60 overflow-y-auto text-sm text-text-primary whitespace-pre-wrap">
          <HighlightedBody body={body} findings={findings} />
        </div>
        <div className="space-y-3">
          {findings.map((f, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">&ldquo;{f.text}&rdquo;</p>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    Position: {f.start}–{f.end}
                  </p>
                </div>
                <span className="text-xs text-warning bg-warning/10 rounded-full px-2 py-0.5 shrink-0">PHI</span>
              </div>
              <p className="mt-2 text-sm text-text-secondary">
                <span className="font-medium">Suggestion:</span> {f.suggestion}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/** Add Reference Dialog(#696: 从路由拆出)。 */
export function AddReferenceDialog(input: {
  form: { kind: string; content: string; label: string; source_patient_hash: string };
  setForm: React.Dispatch<React.SetStateAction<{ kind: string; content: string; label: string; source_patient_hash: string }>>;
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { form, setForm, submitting, onClose, onSubmit } = input;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-elevated shadow-xl p-6 m-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Add Reference</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Kind</label>
            <select
              value={form.kind}
              onChange={(e) => setForm((p) => ({ ...p, kind: e.target.value }))}
              className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="guideline">Guideline</option>
              <option value="research">Research</option>
              <option value="protocol">Protocol</option>
              <option value="note">Note</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Label</label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
              placeholder="e.g. WHO Guideline v3"
              className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Content</label>
            <textarea
              value={form.content}
              onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
              placeholder="Paste or type reference content..."
              rows={4}
              className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Source Patient Hash (optional)</label>
            <input
              type="text"
              value={form.source_patient_hash}
              onChange={(e) => setForm((p) => ({ ...p, source_patient_hash: e.target.value }))}
              placeholder="Optional patient hash"
              className="w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} isLoading={submitting} disabled={submitting}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/** #711: 参考材料列表悬浮窗(#696: 从路由拆出)。
 *  #930: 升级"管理 + 添加" — 文件库勾选登记(已上传文件不再需要重传)+
 *  粘贴文本入口(复活 AddReferenceDialog);列表行为不变。 */
export function ReferenceListPopover(input: {
  list: Array<{ reference_id: string; kind: string; label: string; content: string; created_at: string }>;
  deleting: string | null;
  onClose: () => void;
  onDelete: (referenceId: string) => void;
  onOpenPaste: () => void;
  /** #932: 知识库入口合并进 Reference 弹层(工具栏独立按钮移除)。 */
  onOpenKbPicker: () => void;
  filesLibOpen: boolean;
  onToggleFilesLib: () => void;
  filesLibLoading: boolean;
  filesLibAdding: boolean;
  filesLibList: Array<{ file_id: string; name: string; mime: string; size_bytes: number; created_at: string }>;
  onAddFiles: (files: Array<{ file_id: string; name: string; mime: string; size_bytes: number; created_at: string }>) => void;
}) {
  const { t } = useTranslation();
  const { list, deleting, onClose, onDelete, onOpenPaste, onOpenKbPicker, filesLibOpen, onToggleFilesLib, filesLibLoading, filesLibAdding, filesLibList, onAddFiles } = input;
  // #930: 文件库选择器局部状态 — 勾选/搜索,弹层卸载即重置。
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Array<{ file_id: string; name: string; mime: string; size_bytes: number; created_at: string }>>([]);
  const maxPick = 5;
  const taken = new Set(list.map((r) => (r.label || r.content).toLowerCase()));
  const candidates = filesLibList.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase()));

  const togglePick = (f: { file_id: string; name: string; mime: string; size_bytes: number; created_at: string }) => {
    setPicked((prev) => prev.some((p) => p.file_id === f.file_id)
      ? prev.filter((p) => p.file_id !== f.file_id)
      : (prev.length >= maxPick ? prev : [...prev, f]));
  };

  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-[min(92vw,420px)] rounded-xl border border-border bg-surface-elevated p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">{t('writing.refTitle', '参考材料')} ({list.length})</span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>
      <div className="mb-2 flex gap-1.5">
        <Button size="sm" variant={filesLibOpen ? 'secondary' : 'ghost'} onClick={onToggleFilesLib} className="flex-1">
          <FilePlus size={13} className="mr-1" /> {t('writing.refFromFiles', '从文件库选择')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenKbPicker} className="flex-1" title={t('writing.pickFromKb', '从知识库选择总结/文件作为参考')}>
          📚 {t('writing.fromKb', '知识库')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenPaste} className="flex-1">
          <ClipboardPaste size={13} className="mr-1" /> {t('writing.refPaste', '粘贴文本')}
        </Button>
      </div>
      {filesLibOpen && (
        <div className="mb-2 rounded-lg border border-border bg-surface p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('writing.refFilesSearch', '搜索已上传文件…')}
            className="mb-1.5 w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {filesLibLoading ? (
              <p className="py-2 text-center text-xs text-text-tertiary">…</p>
            ) : candidates.length === 0 ? (
              <p className="py-2 text-center text-xs text-text-tertiary">{t('writing.refFilesEmpty', '暂无已上传文件')}</p>
            ) : (
              candidates.map((f) => {
                const added = taken.has(f.name.toLowerCase());
                const checked = picked.some((p) => p.file_id === f.file_id);
                return (
                  <label key={f.file_id} className={`flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs ${added ? 'opacity-50' : 'cursor-pointer hover:bg-surface-elevated'}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={added || (!checked && picked.length >= maxPick)}
                      onChange={() => togglePick(f)}
                    />
                    <span className="min-w-0 flex-1 truncate text-text-primary">{f.name}</span>
                    {added ? (
                      <span className="shrink-0 rounded bg-surface-muted px-1 py-0.5 text-[10px] text-text-secondary">{t('writing.refAlreadyAdded', '已添加')}</span>
                    ) : (
                      <span className="shrink-0 text-[10px] text-text-tertiary">{f.size_bytes > 1048576 ? `${(f.size_bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size_bytes / 1024))}KB`}</span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5">
            <span className="text-[10px] text-text-tertiary">{t('writing.refFilesPicked', '已选 {{n}}/{{max}}', { n: picked.length, max: maxPick })}</span>
            <Button size="sm" onClick={() => { onAddFiles(picked); setPicked([]); }} isLoading={filesLibAdding} disabled={filesLibAdding || picked.length === 0}>
              {t('writing.refAddSelected', '添加为参考')}
            </Button>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <p className="py-3 text-center text-xs text-text-tertiary">{t('writing.refEmpty', '暂无参考材料 — 点击 Reference 添加，AI 将基于这些材料写作')}</p>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {list.map((r) => (
            <li key={r.reference_id} className="flex items-start gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs">
              <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">{r.kind}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-primary">{r.label || r.content.slice(0, 40)}</p>
                <p className="truncate text-text-tertiary">{r.content.slice(0, 80)}</p>
              </div>
              <button
                onClick={() => onDelete(r.reference_id)}
                disabled={deleting !== null}
                className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                aria-label={t('writing.refDelete', '删除参考材料')}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** #754: 导出完成态面板 — 下载反馈取代服务器路径字符串;记录本会话导出历史。 */
export function ExportDonePanel(input: {
  exportResult: { docx_path: string; size_bytes: number } | null;
  exportHistory: Array<{ format: 'docx' | 'pdf'; filename: string; size: number; at: number }>;
  onClose: () => void;
}) {
  const { exportResult, exportHistory, onClose } = input;
  return (
    <div className="relative ml-3">
      <div className="w-72 rounded-xl border border-border bg-surface-elevated p-3 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1 text-sm font-medium text-text-primary">
            <span className="text-success">✓</span> Export complete
          </span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
        </div>
        {exportResult && (
          <div className="mb-1 rounded-lg bg-surface px-2 py-1.5 text-xs text-text-secondary">
            📄 DOCX · {(exportResult.size_bytes / 1024).toFixed(1)} KB
          </div>
        )}
        {exportHistory.length > 0 && (
          <div className="mt-2 border-t border-border pt-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Export history</span>
            <ul className="mt-1 space-y-0.5">
              {exportHistory.map((h) => (
                <li key={h.at} className="flex items-center justify-between text-xs text-text-secondary">
                  <span className="truncate">{h.format === 'docx' ? '📄' : '📕'} {h.filename}</span>
                  <span className="text-text-tertiary">{(h.size / 1024).toFixed(0)}KB</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
