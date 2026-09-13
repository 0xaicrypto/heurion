import { describe, test, expect } from 'vitest';
import { getApp, authHeader } from '../setup.js';

/** #1010: 用户级引用材料池 — 隐式排序（最近用过/用得最多/当前场景相关）+ 使用痕迹。 */

async function getPrisma() {
  const { default: prisma } = await import('../../src/common/prisma.js');
  return prisma as any;
}

describe('#1010 引用材料池', () => {
  test('三种排序：recent / frequent / relevant，含使用痕迹元信息', async () => {
    const app = await getApp();
    const prisma = await getPrisma();
    const h = await authHeader();
    const user = await prisma.user.findFirst({ orderBy: { createdAt: 'desc' } });
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

    const mkItem = (n: number, label: string, snapshot: string, createdOffset: number) =>
      prisma.referenceItem.create({
        data: {
          id: `ref_pool_${now}_${n}`, userId: user.id, kind: 'pasted_text', sourceRef: null,
          label, snapshot, createdAt: iso(createdOffset), updatedAt: iso(0),
        },
      });
    const a = await mkItem(0, '放疗抵抗综述', 'ATR 通路与放射敏感性', 3_000);
    const b = await mkItem(1, '常用统计材料', '生存分析统计方法', 2_000);
    const c = await mkItem(2, 'EGFR 耐药机制', 'TKI 获得性耐药综述', 1_000);

    // A: 最近用过（1 次，1 小时前）；B: 用得最多（3 次，2 小时前起）。
    await prisma.memoryUsageEvent.create({
      data: { userId: user.id, unitType: 'reference', unitId: a.id, action: 'referenced', sessionId: 'sess_pool_recent', at: iso(3_600_000) },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.memoryUsageEvent.create({
        data: { userId: user.id, unitType: 'reference', unitId: b.id, action: 'referenced', sessionId: 'sess_pool_freq', at: iso(7_200_000 + i) },
      });
    }
    // 使用痕迹里的"最近会话标题"。
    await prisma.session.upsert({
      where: { id: 'sess_pool_recent' },
      update: { title: '放疗抵抗课题' },
      create: {
        id: 'sess_pool_recent', userId: user.id, title: '放疗抵抗课题', scope: 'global',
        status: 'open', messageCount: 0, createdAt: iso(3_600_000),
      },
    });

    const get = async (qs: string) =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/references?${qs}`, headers: h })).payload);

    const recent = await get('sort=recent&limit=50');
    const recentIds = recent.items.map((i: any) => i.reference_id);
    expect(recentIds.indexOf(a.id)).toBeLessThan(recentIds.indexOf(b.id));
    const rowA = recent.items.find((i: any) => i.reference_id === a.id);
    expect(rowA.usage.last_session_title).toBe('放疗抵抗课题');
    expect(rowA.usage.last_used_at).toBeTruthy();

    const frequent = await get('sort=frequent&limit=50');
    const freqIds = frequent.items.map((i: any) => i.reference_id);
    expect(freqIds.indexOf(b.id)).toBeLessThan(freqIds.indexOf(a.id));
    expect(frequent.items.find((i: any) => i.reference_id === b.id).usage.session_count).toBe(3);

    const relevant = await get('sort=relevant&limit=50&context=' + encodeURIComponent('EGFR 耐药'));
    const relIds = relevant.items.map((i: any) => i.reference_id);
    expect(relIds.indexOf(c.id)).toBeGreaterThanOrEqual(0);
    expect(relIds.indexOf(c.id)).toBeLessThan(relIds.indexOf(b.id));
  });

  test('会话挂载写入使用总线 — 池子 usage 轮询可见（fire-and-forget）', async () => {
    const app = await getApp();
    const prisma = await getPrisma();
    const h = { ...(await authHeader()), 'content-type': 'application/json' };
    const user = await prisma.user.findFirst({ orderBy: { createdAt: 'desc' } });
    const now = Date.now();
    const sessionId = `sess_pool_use_${now}`;
    await prisma.session.create({
      data: { id: sessionId, userId: user.id, title: '池使用验证', scope: 'global', status: 'open', messageCount: 0, createdAt: new Date().toISOString() },
    });

    const content = `池使用验证正文_${now}`;
    const post = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: h,
      payload: JSON.stringify({ kind: 'pasted_text', content, label: '池验证材料' }),
    });
    expect(post.statusCode).toBe(200);
    const itemId = JSON.parse(post.payload).reference_id;

    let row: any = null;
    for (let i = 0; i < 20; i++) {
      const pool = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/references?sort=recent&limit=50', headers: h })).payload);
      const found = pool.items.find((x: any) => x.reference_id === itemId);
      if (found && found.usage.session_count >= 1) { row = found; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toBeTruthy();
    expect(row.usage.session_count).toBeGreaterThanOrEqual(1);
    expect(row.usage.last_session_id).toBe(sessionId);
    expect(row.usage.last_session_title).toBe('池使用验证');
  });
});
