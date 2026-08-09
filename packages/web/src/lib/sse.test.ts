import { describe, test, expect } from 'vitest';
import { parseSseStream } from './sse';

/**
 * #457: the single SSE parser used by sendChatFull / deepAnalysis / polishDoc.
 */
describe('parseSseStream (#457)', () => {
  function makeResponse(frames: string[]): Response {
    const body = frames.join('\n\n') + '\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  test('parses data: frames across chunks', async () => {
    const res = makeResponse(['data: {"type":"a"}', 'data: {"type":"b"}']);
    const out: Array<Record<string, unknown>> = [];
    for await (const chunk of parseSseStream(res)) out.push(chunk as Record<string, unknown>);
    expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  test('skips malformed JSON and comment lines', async () => {
    const res = makeResponse(['data: {bad json', ': comment', 'data: {"ok":1}']);
    const out: unknown[] = [];
    for await (const chunk of parseSseStream(res)) out.push(chunk);
    expect(out).toEqual([{ ok: 1 }]);
  });

  test('splits a single chunk containing multiple frames', async () => {
    const body = 'data: {"n":1}\n\ndata: {"n":2}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const out: unknown[] = [];
    for await (const chunk of parseSseStream(res)) out.push(chunk);
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
