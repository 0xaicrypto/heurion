import { describe, test, expect } from 'vitest';
import { getApp, authHeader } from '../setup.js';

/** #1008: 开局建议检测（关键词版）— 打开会话时扫描标题/近期消息，宁缺勿扰。 */

async function getPrisma() {
  const { default: prisma } = await import('../../src/common/prisma.js');
  return prisma as any;
}

describe('#1008 开局建议检测', () => {
  test('关键词命中 → pending；重复扫描不重复；已挂载/已忽略不再提示', async () => {
    const app = await getApp();
    const prisma = await getPrisma();
    const h = { ...(await authHeader()), 'content-type': 'application/json' };
    const user = await prisma.user.findFirst({ orderBy: { createdAt: 'desc' } });
    const now = Date.now();
    const iso = new Date().toISOString();
    // 独有词上下文，避免与其他测试的用户级材料互相命中。
    const context = 'ZZQXOPEN 霰粒肿验证';
    const sessionId = `sess_open_${now}`;
    await prisma.session.create({
      data: { id: sessionId, userId: user.id, title: context, scope: 'global', status: 'open', messageCount: 0, createdAt: iso },
    });
    const mkItem = (n: number, label: string, snapshot: string) =>
      prisma.referenceItem.create({
        data: { id: `ref_open_${now}_${n}`, userId: user.id, kind: 'pasted_text', sourceRef: null, label, snapshot, createdAt: iso, updatedAt: iso },
      });
    await mkItem(0, 'ZZQXOPEN 霰粒肿材料', '仅此一条');
    await mkItem(1, '心血管统计方法', '生存分析');

    const scan = async () => JSON.parse((await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references/suggestions/scan`, headers: h,
      payload: JSON.stringify({ context }),
    })).payload);
    const resolve = async (suggestionId: string, accept: boolean) => app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references/suggestions/${suggestionId}/resolve`, headers: h,
      payload: JSON.stringify({ accept }),
    });

    // 已挂载材料在本会话不再被建议（即使关键词命中）。经正式端点挂载以保证
    // ReferenceItem 的确定性 id 与 SessionReference 一致。
    const mount = await app.inject({
      method: 'POST', url: `/api/v1/sessions/${sessionId}/references`, headers: h,
      payload: JSON.stringify({ kind: 'pasted_text', content: '霰粒肿', label: 'ZZQXOPEN 已挂载材料' }),
    });
    expect(mount.statusCode).toBe(200);

    const first = await scan();
    const labels = first.suggestions.map((s: any) => s.reference.label);
    expect(labels).toContain('ZZQXOPEN 霰粒肿材料');
    expect(labels).not.toContain('心血管统计方法');
    expect(labels).not.toContain('ZZQXOPEN 已挂载材料');
    expect(first.suggestions).toHaveLength(1);
    expect(String(first.suggestions[0].reason)).toContain('开局关键词命中');

    // 重复扫描不重复建建议。
    const second = await scan();
    expect(second.suggestions).toHaveLength(1);

    // 忽略后不再提示（同会话同材料）。
    const dismissed = await resolve(first.suggestions[0].id, false);
    expect(dismissed.statusCode).toBe(200);
    const third = await scan();
    expect(third.suggestions).toHaveLength(0);

    // 采纳路径：另建一条命中材料 → 采纳后成为正式引用，且不再建议。
    await mkItem(3, 'ZZQXOPEN 待采纳', '霰粒肿 材料');
    const fourth = await scan();
    const target = fourth.suggestions.find((s: any) => s.reference.label === 'ZZQXOPEN 待采纳');
    expect(target).toBeTruthy();
    const accepted = await resolve(target.id, true);
    expect(accepted.statusCode).toBe(200);
    const refs = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/references`, headers: h })).payload);
    expect(refs.references.some((r: any) => r.label === 'ZZQXOPEN 待采纳' && r.source === 'suggestion_accepted')).toBe(true);
  });
});
