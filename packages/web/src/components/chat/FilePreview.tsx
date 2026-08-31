import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

/**
 * #771 — 导出产物 / 上传 pptx 的翻页预览（只读）。
 * worker 端 LibreOffice 转图；入口在聊天下载卡片（与幻灯片编辑视图互补：
 * 一个看编辑中的结构，一个看真实模板版式）。worker 未配置预览能力时
 * 优雅降级为仅下载（501 degraded → 提示文案）。
 */

interface PreviewPage {
  index: number;
  url: string;
}

export function FilePreviewButton({ fileId, fileName }: { fileId: string; fileName?: string; mimeType?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<PreviewPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);

  const startPreview = async () => {
    setOpen(true);
    if (pages) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.previewFile(fileId);
      setPages(r.pages);
      setPageIdx(0);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('preview.failed', '预览失败，请下载后查看'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => void startPreview()}>
        <Eye size={14} className="mr-1" />
        {t('preview.open', '预览')}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4" onClick={() => setOpen(false)}>
          <div
            className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
                <FileText size={15} className="shrink-0" />
                <span className="truncate">{fileName || t('preview.title', '文件预览')}</span>
                <span className="shrink-0 text-xs text-text-tertiary">
                  {pages ? `(${pageIdx + 1}/${pages.length})` : ''}
                </span>
              </div>
              <button onClick={() => setOpen(false)} className="rounded p-1 text-text-tertiary hover:bg-surface-elevated hover:text-text-primary">
                <X size={16} />
              </button>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto bg-surface-elevated p-4">
              {loading && <span className="text-sm text-text-tertiary">{t('preview.rendering', '正在生成预览（首次约需十几秒）…')}</span>}
              {error && <span className="max-w-md text-center text-sm text-error">{error}</span>}
              {pages && pages.length > 0 && (
                <img
                  src={pages[pageIdx].url}
                  alt={`page ${pages[pageIdx].index}`}
                  className="max-h-full max-w-full object-contain shadow-md"
                />
              )}
            </div>
            {pages && pages.length > 1 && (
              <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pageIdx === 0}
                  onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
                >
                  {t('preview.prevPage', '上一页')}
                </Button>
                <span className="text-xs text-text-tertiary">
                  {t('preview.pageOf', '第 {{a}} / {{b}} 页', { a: pageIdx + 1, b: pages.length })}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pageIdx >= pages.length - 1}
                  onClick={() => setPageIdx((i) => Math.min(pages.length - 1, i + 1))}
                >
                  {t('preview.nextPage', '下一页')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
