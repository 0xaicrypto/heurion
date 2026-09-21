/**
 * #1078 — 自动生成的 References 列表视图(只读派生视图)。
 *
 * 数据流:正文 markdown 中的 `[cite:id]` shortcode(CITE_SHORTCODE_PATTERN)
 * × 文献元数据(DocCitation,api.listDocCitations)→ 按正文首现顺序编号
 * (assignCitationNumbers — 与正文徽标 #1077 / worker 导出 #1099 同一实现)。
 *
 * 设计约束:
 * - 只列**正文中实际引用**且**有 DocCitation 记录**的条目(按 id 去重,
 *   正文多次引用共享同一编号);悬挂引用(id 无记录)不进列表 — 由
 *   #1081 悬挂横幅负责提示,两处职责分离。
 * - 只读派生:无任何编辑入口 — 列表随正文自动增减,标题下方提示
 *   「由正文引用自动生成(不可手写)」。
 * - 正文无任何引用标记 → 整块不渲染(零噪音)。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { assignCitationNumbers } from '@heurion/contracts';
import type { DocCitationWire } from '@/lib/api';

export interface ReferencesListProps {
  /** 文献元数据(api.listDocCitations)。 */
  citations: DocCitationWire[];
  /** 正文 markdown — shortcode 扫描与编号的依据。 */
  bodyText: string;
}

export function ReferencesList({ citations, bodyText }: ReferencesListProps) {
  const { t } = useTranslation();

  /** 编号(id → n,首现顺序)+ 引用序 — 正文变化即重算(纯派生,无状态)。 */
  const entries = useMemo(() => {
    const numbers = assignCitationNumbers(bodyText ?? '');
    if (numbers.size === 0) return [];
    const byId = new Map((citations ?? []).map((c) => [c.id, c]));
    // 只收有记录的 id(悬挂引用由 #1081 横幅处理),按编号升序。
    return [...numbers.entries()]
      .filter(([id]) => byId.has(id))
      .sort((a, b) => a[1] - b[1])
      .map(([id, n]) => ({ n, citation: byId.get(id)! }));
  }, [bodyText, citations]);

  // 正文无引用标记(或引用全部悬挂)→ 不渲染(零噪音)。
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="references-list"
      className="rounded-lg border border-border bg-surface-elevated p-4"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-sm font-semibold text-text-primary">
          {t('writing.referencesAutoTitle', '参考文献')}
        </h3>
        <span className="text-[11px] text-text-tertiary">
          {t('writing.referencesAutoHint', '由正文引用自动生成（不可手写）')}
        </span>
      </div>
      <ol className="space-y-1.5">
        {entries.map(({ n, citation }) => (
          <li
            key={citation.id}
            data-testid="references-entry"
            data-doi={citation.doi}
            className="text-[13px] leading-relaxed text-text-secondary"
          >
            <span className="mr-1.5 font-semibold text-text-primary">{n}.</span>
            {citation.authors?.length ? (
              <span className="mr-1">{citation.authors.join(', ')}.</span>
            ) : null}
            <span className="mr-1 font-medium text-text-primary">{citation.title}.</span>
            {citation.journal ? <span className="mr-1 italic">{citation.journal}.</span> : null}
            {citation.year != null ? <span className="mr-1">{citation.year}.</span> : null}
            {citation.doi ? (
              <span>
                doi:{' '}
                <a
                  href={`https://doi.org/${citation.doi}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                  data-testid={`references-doi-${citation.id}`}
                >
                  {citation.doi}
                </a>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
