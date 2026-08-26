import { FileText, Loader2, X } from 'lucide-react';

/** 上传进度状态(由调用方驱动,stage=importing 时显示服务端导入阶段)。 */
export interface UploadProgressState {
  fileName: string;
  percent: number;
  stage: 'uploading' | 'importing';
  /** #714: 失败态 — 显示错误信息,允许关闭 Modal。 */
  error?: string;
}

/**
 * #fix: 上传进度 Modal — 上传文件时以模态框展示进度条与文件名,
 * 避免大文件上传期间用户以为卡死。stage=importing 显示不确定进度条
 * (服务端正在导入原文/提取图片公式,无精确进度)。
 *
 * #714: 支持取消与失败态 — 大文件(分片)上传中途可取消(对应服务端
 * upload-abort),失败时 Modal 内联展示错误而非仅关掉顶部 Alert。
 */
export function UploadProgressModal({ state, onCancel }: { state: UploadProgressState | null; onCancel?: () => void }) {
  if (!state) return null;
  const { fileName, percent, stage, error } = state;
  const importing = stage === 'importing' && !error;
  const pct = importing ? 100 : percent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="m-4 w-full max-w-sm rounded-xl border border-border bg-surface-elevated p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${error ? 'bg-error/10 text-error' : 'bg-accent/10 text-accent'}`}>
            <FileText size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">
              {error ? '上传失败' : importing ? '正在导入原文…' : '正在上传…'}
            </h3>
            <p className="truncate text-xs text-text-tertiary" title={fileName}>{fileName}</p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              disabled={importing}
              className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-40"
              aria-label="取消上传"
              title={importing ? '导入中不可取消' : '取消上传'}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* 进度条:uploading 用真实百分比;importing 用不确定动画;失败为红条。 */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
          {error ? (
            <div className="h-full w-full rounded-full bg-error/40" />
          ) : importing ? (
            <div className="relative h-full w-full overflow-hidden rounded-full">
              <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-accent" style={{ animation: 'upload-indeterminate 1.2s ease-in-out infinite' }} />
            </div>
          ) : (
            <div className="h-full rounded-full bg-accent transition-all duration-200" style={{ width: `${pct}%` }} />
          )}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-text-secondary">
            {error ? (
              <X size={12} className="text-error" />
            ) : (
              <Loader2 size={12} className="animate-spin" />
            )}
            {error ? (
              <span className="max-w-[260px] truncate text-error">{error}</span>
            ) : importing ? (
              '正在提取文字、图片与公式…'
            ) : `${pct}%`}
          </span>
        </div>
      </div>
      <style>{`@keyframes upload-indeterminate { 0% { left: -33%; } 100% { left: 100%; } }`}</style>
    </div>
  );
}
