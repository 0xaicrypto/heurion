/**
 * #1081 — 悬挂引用可视化提示与清理入口。
 *
 * 数据源：GET /docs/:docId/citations/dangling（正文 [cite:id] 找不到
 * DocCitation 记录 — 迁移未命中/数据异常/跨文档复制）。悬挂引用不会被
 * 静默隐藏或渲染崩溃：横幅列出问题引用，提供两个动作（对齐 issue）：
 * - 「删除该引用」→ DELETE 记录 + AI 编辑链路移除正文标记；
 * - 「重新检索绑定」— 引导 insert_citation 检索流程（AI 在工具循环确认）。
 * 无悬挂引用时不渲染（零噪音）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

export function CitationHealthBanner(input: {
  docId: string | undefined;
  /** 静默刷新节流（正文写回后诊断可能变化；轮询间隔 ms，缺省 30s）。 */
  pollMs?: number;
  /** 指令发送通道 — 「重新检索绑定」走 AI 工具循环（与 #770 导出同哲学）。 */
  sendChatText?: (text: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { docId, pollMs = 30_000, sendChatText } = input;
  const [dangling, setDangling] = useState<Array<{ id: string; occurrences: number }>>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.listDanglingCitations(docId);
        if (!cancelled) setDangling(data.dangling ?? []);
      } catch { /* 诊断失败静默降级 — 引用横幅非关键路径 */ }
    };
    void load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [docId, pollMs]);

  if (!docId || dangling.length === 0) return null;

  const onDelete = async (id: string) => {
    setBusyId(id);
    try {
      await api.deleteDocCitation(docId, id);
      setDangling((prev) => prev.filter((x) => x.id !== id));
    } catch { /* 删除失败保留提示 — 可重试 */ } finally {
      setBusyId(null);
    }
  };

  const onRebind = (id: string) => {
    // 指令 id 以代码模板嵌入（不依赖 i18n 插值 — 测试/降级环境下凭据不丢失）。
    void sendChatText?.(
      [
        t('writing.citationRebindHeader', '请重新检索并绑定该引用：正文中的以下引用标记找不到对应文献记录。'),
        `[cite:${id}]`,
        t('writing.citationRebindBody', '请用 search_citation 检索正确文献（必须带 DOI），确认后建立正式引用（insert_citation），并把正文标记替换为新的引用 id。'),
      ].join('\n'),
    );
  };

  return (
    <div
      data-testid="citation-dangling-banner"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2"
    >
      <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 text-xs text-text-secondary">
        {t('writing.citationDanglingTitle', '以下引用标记未找到对应文献（悬挂引用），导出会显示为 [?] 占位：')}
      </span>
      {dangling.map((d) => (
        <span
          key={d.id}
          data-testid="citation-dangling-item"
          data-citation-id={d.id}
          className="flex items-center gap-1 rounded border border-warning/30 bg-surface-elevated px-1.5 py-0.5 text-[11px] text-text-primary"
          title={t('writing.citationDanglingItem', '该引用未找到对应文献记录（出现 {{n}} 次）', { n: d.occurrences })}
        >
          <span className="font-mono">{`[cite:${d.id}]`}</span>
          <button
            type="button"
            data-testid={`citation-dangling-rebind-${d.id}`}
            disabled={busyId === d.id}
            onClick={() => onRebind(d.id)}
            className="rounded p-0.5 text-text-tertiary transition-colors hover:text-accent disabled:opacity-50"
            aria-label={t('writing.citationRebind', '重新检索绑定')}
            title={t('writing.citationRebind', '重新检索绑定')}
          >
            <Search size={12} />
          </button>
          <button
            type="button"
            data-testid={`citation-dangling-delete-${d.id}`}
            disabled={busyId === d.id}
            onClick={() => void onDelete(d.id)}
            className="rounded p-0.5 text-text-tertiary transition-colors hover:text-warning disabled:opacity-50"
            aria-label={t('writing.citationDanglingDelete', '删除该引用')}
            title={t('writing.citationDanglingDelete', '删除该引用')}
          >
            <Trash2 size={12} />
          </button>
        </span>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto shrink-0"
        data-testid="citation-dangling-rebind-all"
        onClick={() => {
          for (const d of dangling) onRebind(d.id);
        }}
      >
        {t('writing.citationRebindAll', '逐个重新检索绑定')}
      </Button>
    </div>
  );
}
