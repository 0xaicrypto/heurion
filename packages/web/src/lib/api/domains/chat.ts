/**
 * #458 — ChatApi: the chat domain. Chat SSE streaming (sendChatFull /
 * deepAnalysis) previously lived on PluginsApi; session CRUD + context
 * usage lived on BrainApi. All chat concerns now live here.
 */
import { ApiCore, ApiError } from './core.js';
import type { ChatStreamChunk, SendChatOptions } from '../../types';
import { parseSseStream } from '../../sse';
import type { ChatWireMessage } from '@heurion/contracts';

export class ChatApi extends ApiCore {
  /* ────────────────────────── sessions ────────────────────────── */

  async closeSession(sessionId: string): Promise<{ id: string; status: string; closed_at?: string }> {
    return this.fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST' });
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.fetch<void>(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async getMessages(sessionId?: string, limit = 50): Promise<{ messages: ChatWireMessage[]; total: number }> {
    const q = sessionId ? `?session_id=${sessionId}&limit=${limit}` : `?limit=${limit}`;
    return this.fetch<{ messages: ChatWireMessage[]; total: number }>(`/api/v1/agent/messages${q}`);
  }

  async getContextUsage(sessionId: string): Promise<{ history_tokens: number; history_budget: number; history_turns: number; omitted_turns: number; will_compact: boolean }> {
    return this.fetch(`/api/v1/agent/context-usage?session_id=${encodeURIComponent(sessionId)}`);
  }

  /* ────────────────────────── streaming chat ────────────────────────── */

  async *sendChatFull(
    opts: SendChatOptions,
    abortSignal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const body: Record<string, unknown> = {
      text: opts.text,
      session_id: opts.sessionId || '',
      patient_hash: opts.patientHash ?? null,
    };
    if (opts.attachments) body.attachments = opts.attachments;
    if (opts.scope) body.scope = opts.scope;
    if (opts.skills) body.skills = opts.skills;
    const r = await fetch('/api/v1/agent/chat', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!r.ok || !r.body) {
      throw new ApiError(r.status, await r.text().catch(() => r.statusText), '/api/v1/agent/chat');
    }
    // #457: single SSE parser.
    yield* parseSseStream<ChatStreamChunk>(r, abortSignal);
  }

  // #420: parallel deep analysis — SSE stream of sub-agent activity + final answer.
  async *deepAnalysis(
    opts: { question: string; topics: string[]; patientHash?: string | null; context?: string },
    abortSignal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const r = await fetch('/api/v1/agent/deep-analysis', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        question: opts.question,
        topics: opts.topics,
        patient_hash: opts.patientHash ?? null,
        context: opts.context,
      }),
      signal: abortSignal,
    });
    if (!r.ok || !r.body) {
      throw new ApiError(r.status, await r.text().catch(() => r.statusText), '/api/v1/agent/deep-analysis');
    }
    // #457: single SSE parser.
    yield* parseSseStream<ChatStreamChunk>(r, abortSignal);
  }
}
