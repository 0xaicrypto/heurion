/**
 * #review-4: deck 视图引用徽标层 — deck 卡片不是 TipTap（无 ProseMirror
 * decoration 管道，见 lib/citation-view.ts），slide 文本以可编辑 input/
 * textarea 呈现原始 `[cite:id]` shortcode（编辑面不动），本组件作为只读
 * affordance 叠加在卡片内容下方：
 * - 编号与正文/References/worker 导出同源（contracts.assignCitationNumbers，
 *   首现顺序；作用域 = 传入 text，deck 每页以「标题+要点+备注」独立编号）；
 * - 悬挂引用（id 不在 citations 列表）渲染警示态 `[?]`（与 #1081 横幅同色系，
 *   不静默消失），tooltip 复用 #1077 的 writing.citationDanglingBadge 词条；
 * - 点击徽标 → onCitationClick(id)，路由层弹既有 CitationPreviewModal。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { assignCitationNumbers, CITE_SHORTCODE_PATTERN } from '@heurion/contracts';
import type { DocCitationWire } from '@/lib/api';

interface CitationBadge {
  id: string;
  /** 已知引用的编号（首现顺序）；悬挂引用为 null → 渲染 [?]。 */
  n: number | null;
  citation?: DocCitationWire;
}

export function CitationBadges({ text, citations, onCitationClick }: {
  text: string;
  citations: DocCitationWire[];
  onCitationClick?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const badges = useMemo<CitationBadge[] | null>(() => {
    const matches = [...text.matchAll(CITE_SHORTCODE_PATTERN)];
    if (matches.length === 0) return null;
    const numbers = assignCitationNumbers(text);
    const known = new Map((citations ?? []).map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: CitationBadge[] = [];
    for (const m of matches) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const citation = known.get(id);
      out.push({ id, n: citation ? (numbers.get(id) ?? 0) : null, citation });
    }
    return out;
  }, [text, citations]);
  if (!badges || badges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="deck-citation-badges">
      {badges.map((b, i) => {
        const dangling = b.n === null;
        const title = dangling
          ? t('writing.citationDanglingBadge', '未解析的引用标记 — 未找到对应文献记录')
          : t('writing.citationBadgeTitle', '引用 {{n}}：{{detail}}', {
              n: b.n,
              detail: [
                b.citation?.title ?? '',
                b.citation?.journal ?? '',
                b.citation?.year != null ? String(b.citation.year) : '',
                b.citation?.doi ? `doi:${b.citation.doi}` : '',
              ].filter(Boolean).join(' · '),
            });
        return (
          <button
            key={b.id}
            type="button"
            data-testid={`deck-citation-badge-${i}`}
            data-citation-id={b.id}
            onClick={() => onCitationClick?.(b.id)}
            title={title}
            className={
              dangling
                ? 'shrink-0 rounded border border-warning/50 bg-warning/15 px-1 py-0.5 text-[10px] font-semibold leading-none text-warning transition-colors hover:bg-warning/25'
                : 'shrink-0 rounded border border-accent/40 bg-accent/10 px-1 py-0.5 text-[10px] font-semibold leading-none text-accent transition-colors hover:bg-accent/20'
            }
          >
            {dangling ? '[?]' : `[${b.n}]`}
          </button>
        );
      })}
    </div>
  );
}
