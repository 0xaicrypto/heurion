import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Search, Wrench } from 'lucide-react';

export interface ToolCallEntry {
  tool: string;
  argsPreview: string;
}

/** Read-only retrieval tools — consecutive ones merge into one foldable row. */
const RETRIEVAL_TOOLS = new Set(['search_node', 'search_encounter', 'search_past_chats']);

interface Group {
  kind: 'retrieval' | 'action';
  tools: string[];
  args: string[];
}

/**
 * U2 — tool-call visualization. Consecutive retrieval calls (search_*)
 * collapse into a single foldable row ('检索患者记忆 · N') like opencode's
 * groupParts; write/action tools render as their own small badges.
 */
export function ToolCalls({ calls }: { calls: ToolCallEntry[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const c of calls) {
      const isRetrieval = RETRIEVAL_TOOLS.has(c.tool);
      const last = out[out.length - 1];
      if (isRetrieval && last && last.kind === 'retrieval') {
        // consecutive retrieval calls merge into one foldable row
        last.tools.push(c.tool);
        last.args.push(c.argsPreview);
      } else {
        // action tools (writes, ocr, defer…) stay on their own row
        out.push({ kind: isRetrieval ? 'retrieval' : 'action', tools: [c.tool], args: [c.argsPreview] });
      }
    }
    return out;
  }, [calls]);

  if (groups.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {groups.map((g, i) =>
        g.kind === 'retrieval' ? (
          <button
            key={i}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-surface-elevated"
            title={t('chat.toolRetrievalHint', '检索工具调用')}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Search size={11} className="text-text-tertiary" />
            {t('chat.toolRetrieval', '检索患者记忆')} · {g.tools.length}
          </button>
        ) : (
          <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-tertiary">
            <Wrench size={11} />
            {g.tools[g.tools.length - 1]}
          </span>
        ),
      )}
      {open && (
        <div className="w-full space-y-0.5 rounded-lg border border-border bg-surface p-2">
          {groups.flatMap((g) => g.tools.map((tool, j) => (
            <div key={`${g.kind}${j}`} className="flex items-start gap-1.5 text-[11px] text-text-tertiary">
              <span className="shrink-0 font-mono">{tool}</span>
              {g.args[j] && <span className="truncate font-mono">{g.args[j]}</span>}
            </div>
          )))}
        </div>
      )}
    </div>
  );
}
