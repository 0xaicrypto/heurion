import { describe, test, expect } from 'vitest';
import { getApp, authHeader } from '../setup.js';

/** #1034: 统一会话端点（doc-<docId>）保留写作专属副作用 — 空文档自动导入 + 响应对齐。 */

function buildMultipart(fields: Record<string, string>, file: { name: string; mime: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
  );
  chunks.push(file.content);
  chunks.push(Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('#1034 doc 会话引用端点', () => {
  test('文件类引用挂空文档 → imported_body；幂等；池复用无副作用', async () => {
    const app = await getApp();
    const h = await authHeader();
    const jsonH = { ...h, 'content-type': 'application/json' };
    const now = Date.now();
    const name = `session-ref-${now}.txt`;
    const bodyText = `Session reference auto import body ${now}.`;

    const mp = buildMultipart({}, { name, mime: 'text/plain', content: Buffer.from(bodyText) });
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/files/upload',
      headers: { ...h, 'content-type': mp.contentType },
      payload: mp.body,
    });
    expect(upload.statusCode).toBe(200);

    const doc = await app.inject({
      method: 'POST', url: '/api/v1/docs', headers: jsonH,
      payload: JSON.stringify({ title: `Session Ref Doc ${now}` }),
    });
    expect(doc.statusCode).toBe(200);
    const docId = JSON.parse(doc.payload).id;
    const sessionId = `doc-${docId}`;

    const addRes = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
      payload: JSON.stringify({ kind: 'file', content: name, label: name }),
    });
    expect(addRes.statusCode).toBe(200);
    const added = JSON.parse(addRes.payload);
    // 与旧写作端点响应对齐：自动导入回传正文。
    expect(added.imported).toBe(true);
    expect(String(added.imported_body)).toContain('Session reference auto import');
    expect(added.pptx_parse).toBeNull();

    const list = JSON.parse((await app.inject({
      method: 'GET', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
    })).payload);
    expect(list.references.some((r: any) => r.reference_id === added.reference_id)).toBe(true);

    // 同一 identity 重复登记 → 幂等（同一 reference_id，不产生第二行）。
    const again = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
      payload: JSON.stringify({ kind: 'file', content: name, label: name }),
    });
    expect(JSON.parse(again.payload).reference_id).toBe(added.reference_id);
    const list2 = JSON.parse((await app.inject({
      method: 'GET', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
    })).payload);
    expect(list2.references.filter((r: any) => r.reference_id === added.reference_id)).toHaveLength(1);

    // 池复用路径（reference_id）是重新挂载 — 不触发副作用。
    const poolAdd = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
      payload: JSON.stringify({ reference_id: added.reference_id }),
    });
    expect(poolAdd.statusCode).toBe(200);
    const poolBody = JSON.parse(poolAdd.payload);
    expect(poolBody.imported).toBe(false);
    expect(poolBody.pptx_parse).toBeNull();
  });

  test('非 doc 会话不触发副作用（imported=false）', async () => {
    const app = await getApp();
    const jsonH = { ...(await authHeader()), 'content-type': 'application/json' };
    const sessionId = `sess_plain_${Date.now()}`;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: jsonH,
      payload: JSON.stringify({ kind: 'file', content: 'plain.txt', label: 'plain.txt' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.imported).toBe(false);
    expect(body.imported_body).toBeNull();
    expect(body.pptx_parse).toBeNull();
  });
});
