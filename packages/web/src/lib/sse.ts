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

/**
 * #660 — coalesce a chunk stream into windows. LLM token events arrive far
 * faster than the UI can re-render; consumers apply one batch per window
 * (default 16ms ≈ one render frame) instead of one setState per chunk.
 * Done is flushed immediately even if the window has not elapsed.
 */
export async function* batchChunks<T>(
  source: AsyncIterable<T>,
  windowMs = 16,
): AsyncGenerator<T[]> {
  const iter = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<T>> | null = null;
  while (true) {
    const batch: T[] = [];
    // Await the chunk that was in flight when the previous window closed —
    // never abandon an in-flight next(), or a chunk is silently lost.
    if (pending) {
      const r = await pending;
      pending = null;
      if (r.done) {
        if (batch.length) yield batch;
        break;
      }
      batch.push(r.value);
    } else {
      const r = await iter.next();
      if (r.done) {
        if (batch.length) yield batch;
        break;
      }
      batch.push(r.value);
    }
    // Gather every chunk that arrives inside the window; cap at 128 to
    // bound memory when the source floods faster than the timer.
    while (batch.length < 128) {
      const nextP = iter.next();
      const timeoutP = new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), windowMs);
      });
      const res = await Promise.race([
        nextP.then((r) => ({ kind: 'value' as const, r })),
        timeoutP,
      ]);
      if (res.kind === 'timeout') {
        pending = nextP;
        break;
      }
      if (res.r.done) {
        pending = Promise.resolve(res.r);
        break;
      }
      batch.push(res.r.value);
    }
    yield batch;
  }
}
