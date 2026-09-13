import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/lib/plugin-dom-ui';

/** #1009/#1012: 会话待处理建议 — 建议可一键采纳（转正式引用）或忽略（不再重复提示）。 */
export interface SessionSuggestion {
  id: string;
  sessionId: string;
  referenceId: string;
  reason: string;
  /** #1036: 结构化原因码（旧数据为 null → 回退 reason 原文）。 */
  reasonCode?: string | null;
  score?: number | null;
  suggestedAt: string;
  status: string;
  reference: { id: string; kind: string; label: string; snapshot: string; sourceRef: string | null };
}

/** #1036: 建议原因本地化 — code → i18n；无 code 的旧数据回退服务端原文。 */
export function suggestionReasonText(
  s: Pick<SessionSuggestion, 'reason' | 'reasonCode' | 'score'>,
  t: TFunction,
): string {
  if (s.reasonCode === 'opening_keyword') {
    return t('chat.suggestReasonOpening', { score: s.score ?? 0, defaultValue: '当前场景关键词匹配（相关度 {{score}}）' });
  }
  if (s.reasonCode === 'conversation_semantic') {
    return t('chat.suggestReasonConversation', { defaultValue: '对话内容命中未引用材料' });
  }
  return s.reason;
}

export interface SessionSuggestions {
  suggestions: SessionSuggestion[];
  resolving: string | null;
  resolve: (suggestionId: string, accept: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  /** #1008: 开局检测（关键词）— 打开会话时调用一次。 */
  scan: (context: string) => Promise<void>;
}

export function useSessionSuggestions(input: {
  sessionId: string | undefined;
  setError: (e: string) => void;
  /** 采纳后回调 — 调用方借此刷新正式引用列表。 */
  onAccepted?: () => void;
}): SessionSuggestions {
  const { sessionId, setError } = input;
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<SessionSuggestion[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setSuggestions([]);
      return;
    }
    try {
      const r = await api.getSessionSuggestions(sessionId);
      setSuggestions(r.suggestions || []);
    } catch { /* 建议加载失败不阻断对话 */ }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // #1008: 开局检测 — 命中则把返回的 pending 列表直接同步到本地状态。
  const scan = useCallback(async (context: string) => {
    if (!sessionId || !context.trim()) return;
    try {
      const r = await api.scanSessionSuggestions(sessionId, context);
      if (r.suggestions) setSuggestions(r.suggestions);
    } catch { /* 开局扫描失败不阻断对话 */ }
  }, [sessionId]);

  const resolve = async (suggestionId: string, accept: boolean) => {
    if (!sessionId) return;
    setResolving(suggestionId);
    try {
      const label = suggestions.find((s) => s.id === suggestionId)?.reference.label || '';
      await api.resolveSessionSuggestion(sessionId, suggestionId, accept);
      // 采纳/忽略都从横幅移除；服务端已保证忽略后不再对同一会话重复提示。
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestionId));
      // #1036: 轻量成功反馈（不打断操作）。
      showToast(
        accept
          ? t('chat.suggestionAccepted', '已引用「{{label}}」', { label })
          : t('chat.suggestionIgnored', '已忽略该建议'),
        accept ? 'success' : 'info',
      );
      if (accept) input.onAccepted?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setResolving(null);
    }
  };

  return { suggestions, resolving, resolve, refresh, scan };
}
