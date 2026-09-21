/**
 * #1077 — 引用详情预览弹窗(点击正文引用徽标弹出)。
 *
 * 展示文献元数据:标题/作者/期刊/年份/来源 + DOI 链接(https://doi.org/<doi>)。
 * 悬挂引用(正文标记无对应 DocCitation 记录)渲染警示态说明,不留死弹窗。
 * 基于共享 Modal 基础设施(backdrop/Esc 可关,#922 收敛先例)。
 */
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui';
import type { DocCitationWire } from '@/lib/api';

export interface CitationPreviewModalProps {
  /** 点击的引用 id — 未命中 citations 时按悬挂态渲染。 */
  citationId: string | null;
  /** 文献元数据(api.listDocCitations)。 */
  citations: DocCitationWire[];
  onClose: () => void;
}

export function CitationPreviewModal({ citationId, citations, onClose }: CitationPreviewModalProps) {
  const { t } = useTranslation();
  const citation = citationId ? (citations ?? []).find((c) => c.id === citationId) : undefined;
  if (!citationId) return null;

  return (
    <Modal
      open
      onClose={onClose}
      backdropClose
      escClose
      aria-label={t('writing.citationPreviewTitle', '引用详情')}
      backdropClassName="bg-black/50 p-4"
      panelClassName="w-full max-w-md"
    >
      <div
        data-testid="citation-preview"
        data-citation-id={citationId}
        className="rounded-xl border border-border bg-surface-elevated p-4 shadow-xl"
      >
        {citation ? (
          <>
            <div className="mb-2 flex items-start justify-between gap-2">
              <h3 className="font-serif text-sm font-semibold leading-snug text-text-primary">
                {citation.title}
              </h3>
            </div>
            <dl className="space-y-1 text-[13px] text-text-secondary">
              {citation.authors?.length ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-text-tertiary">{t('writing.citationPreviewAuthors', '作者')}</dt>
                  <dd>{citation.authors.join(', ')}</dd>
                </div>
              ) : null}
              {citation.journal ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-text-tertiary">{t('writing.citationPreviewJournal', '期刊')}</dt>
                  <dd className="italic">
                    {citation.journal}
                    {citation.year != null ? ` · ${citation.year}` : ''}
                  </dd>
                </div>
              ) : null}
              {citation.doi ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-text-tertiary">DOI</dt>
                  <dd>
                    <a
                      href={`https://doi.org/${citation.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                      data-testid="citation-preview-doi"
                    >
                      {citation.doi}
                    </a>
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="shrink-0 text-text-tertiary">{t('writing.citationPreviewSource', '来源')}</dt>
                <dd className="capitalize">{citation.source}</dd>
              </div>
            </dl>
          </>
        ) : (
          <div className="flex items-start gap-2 text-[13px] text-text-secondary">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="font-medium text-text-primary">
                {t('writing.citationPreviewDangling', '该引用标记未找到对应文献记录')}
              </p>
              <p className="mt-1 font-mono text-[12px] text-text-tertiary">{`[cite:${citationId}]`}</p>
            </div>
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="citation-preview-close">
            {t('writing.citationPreviewClose', '关闭')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
