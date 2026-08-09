/**
 * #457 — single SSE stream parser. The backend writes frames as
 * `data: {json}\n\n` (chat-sse.ts); all four hand-rolled copies
 * (sendChatFull / deepAnalysis / polishDoc / sendDocChat) are replaced by
 * this one implementation, which also owns reader release + abort cancel.
 */
export async function* parseSseStream<T = unknown>(
  res: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<T> {
  if (!res.body) throw new Error('SSE response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  abortSignal?.addEventListener(
    'abort',
    () => {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    },
    { once: true },
  );

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            yield JSON.parse(data) as T;
          } catch {
            /* malformed payload; skip */
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
