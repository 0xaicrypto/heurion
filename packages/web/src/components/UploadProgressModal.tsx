import { FileText, Loader2 } from 'lucide-react';

/** 上传进度状态(由调用方驱动,stage=importing 时显示服务端导入阶段)。 */
export interface UploadProgressState {
  fileName: string;
  percent: number;
  stage: 'uploading' | 'importing';
}

/**
 * #fix: 上传进度 Modal — 上传文件时以模态框展示进度条与文件名,
 * 避免大文件上传期间用户以为卡死。stage=importing 显示不确定进度条
 * (服务端正在导入原文/提取图片公式,无精确进度)。
 */
export function UploadProgressModal({ state }: { state: UploadProgressState | null }) {
  if (!state) return null;
  const { fileName, percent, stage } = state;
  const importing = stage === 'importing';
  const pct = importing ? 100 : percent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="m-4 w-full max-w-sm rounded-xl border border-border bg-surface-elevated p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <FileText size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">
              {importing ? '正在导入原文…' : '正在上传…'}
            </h3>
            <p className="truncate text-xs text-text-tertiary" title={fileName}>{fileName}</p>
          </div>
        </div>

        {/* 进度条:uploading 用真实百分比;importing 用不确定动画。 */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
          {importing ? (
            <div className="relative h-full w-full overflow-hidden rounded-full">
              <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-accent" style={{ animation: 'upload-indeterminate 1.2s ease-in-out infinite' }} />
            </div>
          ) : (
            <div className="h-full rounded-full bg-accent transition-all duration-200" style={{ width: `${pct}%` }} />
          )}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-text-secondary">
            <Loader2 size={12} className="animate-spin" />
            {importing ? '正在提取文字、图片与公式…' : `${pct}%`}
          </span>
        </div>
      </div>
      <style>{`@keyframes upload-indeterminate { 0% { left: -33%; } 100% { left: 100%; } }`}</style>
    </div>
  );
}
