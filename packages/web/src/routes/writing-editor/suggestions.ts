import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/** #1009/#1012: 会话待处理建议 — 建议可一键采纳（转正式引用）或忽略（不再重复提示）。 */
export interface SessionSuggestion {
  id: string;
  sessionId: string;
  referenceId: string;
  reason: string;
  suggestedAt: string;
  status: string;
  reference: { id: string; kind: string; label: string; snapshot: string; sourceRef: string | null };
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
      await api.resolveSessionSuggestion(sessionId, suggestionId, accept);
      // 采纳/忽略都从横幅移除；服务端已保证忽略后不再对同一会话重复提示。
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestionId));
      if (accept) input.onAccepted?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setResolving(null);
    }
  };

  return { suggestions, resolving, resolve, refresh, scan };
}
