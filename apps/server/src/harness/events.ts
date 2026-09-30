import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

/** 推给前端的精简事件（SSE data 字段）。 */
export type UiEvent =
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; isError: boolean }
  | { type: 'turn_end'; reason: string }
  | { type: 'version'; seq: number }
  | { type: 'citation_audit'; ok: boolean; unregisteredDois: string[] }
  | { type: 'error'; message: string }

interface Block { type: string; text?: string; id?: string; name?: string; arguments?: string }

/**
 * dsh 的 SDK 通知 → UiEvent。只看根会话；dsh 的 `session.event` 是已提交的会话日志事件，
 * 粒度是「每一步」而不是逐 token（SDK 协议没有 delta 流）。
 */
export function mapNotification(n: HarnessNotification, sessionId: string): UiEvent[] {
  if (n.params.sessionId !== sessionId) return []
  if (n.method === 'session.status') {
    const status = n.params.status
    return status === 'running' || status === 'idle' ? [{ type: 'status', status }] : []
  }
  if (n.method !== 'session.event') return []
  const event = n.params.event as { type?: string; data?: Record<string, unknown> } | undefined
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'assistant/message': {
      const message = data.message as { content?: Block[] } | undefined
      const out: UiEvent[] = []
      for (const b of message?.content ?? []) {
        if (b.type === 'reasoning' && b.text) out.push({ type: 'reasoning', text: b.text })
        else if (b.type === 'text' && b.text) out.push({ type: 'assistant', text: b.text })
        else if (b.type === 'tool-call') out.push({ type: 'tool_call', callId: b.id ?? '', name: b.name ?? '', arguments: b.arguments ?? '' })
      }
      return out
    }
    case 'tool/result': {
      const message = data.message as { toolCallId?: string; isError?: boolean; source?: { toolCallId?: string } } | undefined
      return [{ type: 'tool_result', callId: message?.toolCallId ?? message?.source?.toolCallId ?? '', isError: Boolean(message?.isError) }]
    }
    case 'turn/end': {
      // reason 形如 { kind: 'completed' | 'error' | ..., error?: { message, code } }
      const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } } | string | undefined
      const kind = typeof reason === 'string' ? reason : reason?.kind ?? 'unknown'
      const out: UiEvent[] = [{ type: 'turn_end', reason: kind }]
      if (typeof reason === 'object' && reason?.error) out.push({ type: 'error', message: describeError(reason.error) })
      return out
    }
    default:
      return []
  }
}

const ERROR_HINTS: Record<string, string> = {
  MISSING_CREDENTIAL: '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启 server。',
  INVALID_CREDENTIAL: 'DEEPSEEK_API_KEY 无效，请检查 .env。',
}

function describeError(e: { message?: string; code?: string }): string {
  return (e.code && ERROR_HINTS[e.code]) ?? e.message ?? e.code ?? 'AI 回合失败'
}
