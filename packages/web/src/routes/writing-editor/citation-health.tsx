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
  /**
   * 复审 #2 修复: 清除悬挂标记后服务端基于客户端基线（base_body/base_deck）
   * 计算，返回改写后的正文/deck — 路由据此同步编辑器与服务端基线（用户
   * 未保存编辑不会被服务端旧版本静默覆盖：基线由调用方传入而非服务端旧值）。
   */
  onCleanupApplied?: (next: { body: string; deck: string | null }) => void;
  /** 统一轻提示通道（删除失败等可见反馈 — 此前空 catch 静默）。 */
  onNotice?: (text: string, ttlMs?: number) => void;
  /** 复审 #2: 客户端当前正文基线（用户正在编辑的未保存内容）— 清除以它为底稿
   *  （标记清除 + 未保存编辑一并落库）。 */
  currentBody?: string;
  /** 复审 #2: 客户端所知的**服务端**基线（lastSavedBody）— 服务端已被其他
   *  窗口推进时 409 明示，不静默覆盖任一侧。 */
  serverBase?: string | null;
  /**
   * 复审轮 4（P0 修复）: 客户端**实时** deck 基线（deckJson 画布值，含未保存
   * 编辑）— 清除以它为底稿（第二轮误传 lastSavedDeck 保存基线，未保存的
   * 画布编辑被静默丢弃）。
   */
  currentDeck?: string | null;
  /** 复审轮 4: 客户端所知的服务端 deck 基线（lastSavedDeck）— 过期 → 409 明示。 */
  serverDeckBase?: string | null;
}) {
  const { t } = useTranslation();
  const { docId, pollMs = 30_000, sendChatText, onCleanupApplied, onNotice, currentBody, serverBase, currentDeck, serverDeckBase } = input;
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

  // 复审 #2 修复: 悬挂引用「删除」= 清除正文标记本身（POST dangling/:id/remove —
  // 悬挂引用按定义无记录可删，旧实现复用面向真实记录的 DELETE 必然 404 且
  // 空 catch 静默失效）。以客户端当前正文/deck 为基线（base_body/base_deck）—
  // 用户未保存的编辑参与清除计算，不会被服务端旧版本静默覆盖；
  // 复审 #3: deck 内的悬挂标记同帧清除（与 GET /dangling 扫描范围对齐）。
  const onDelete = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.removeDanglingCitation(docId, id, {
        base_body: currentBody,
        server_base: serverBase ?? undefined,
        base_deck: currentDeck ?? undefined,
        server_deck_base: serverDeckBase ?? undefined,
      });
      setDangling((prev) => prev.filter((x) => x.id !== id));
      onCleanupApplied?.({ body: res.body, deck: res.deck });
      onNotice?.(t('writing.citationDanglingDeleted', '已移除该悬挂引用标记（{{n}} 处）', { n: res.removed }), 3000);
    } catch (err) {
      // 复审 #2: 409（服务端内容已被并发修改）等失败必须可见，不静默吞错。
      const msg = err instanceof Error ? err.message : String(err);
      onNotice?.(t('writing.citationDanglingDeleteFail', '悬挂引用清理失败：{{msg}} — 请刷新后重试', { msg }), 4000);
    } finally {
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
