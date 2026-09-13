import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getApp, registerSecondUser } from '../setup.js';
import { twinsBaseDir } from '../../src/lib/upload-path.js';

/** #1030: 记忆使用观察指标 — admin 只读聚合 + 非 admin 403。 */

async function getPrisma() {
  const { default: prisma } = await import('../../src/common/prisma.js');
  return prisma as any;
}

/** 注册一个用户并提升为 admin（重启 token 让 role 进入 JWT）。 */
async function adminAuth(): Promise<{ headers: Record<string, string>; userId: string }> {
  const app = await getApp();
  const prisma = await getPrisma();
  const suffix = Math.random().toString(36).slice(2, 6);
  const username = `metricsadmin_${Date.now()}_${suffix}`;
  const displayName = `Metrics Admin ${suffix}`;
  const password = 'test123456';
  const reg = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password, display_name: displayName }),
  });
  const body = JSON.parse(reg.payload);
  const userId = JSON.parse(Buffer.from(body.jwt_token.split('.')[1], 'base64').toString()).userId;
  await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
  // login #283 按 displayName/email/phone 查找（不含 username），用 displayName 登录。
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username: displayName, password }),
  });
  const token = JSON.parse(login.payload).jwt_token;
  return { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, userId };
}

describe('#1030 记忆使用观察指标', () => {
  test('admin 可查 overview/suggestions/gaps/references，非 admin 403', async () => {
    const app = await getApp();
    const prisma = await getPrisma();
    const { headers, userId } = await adminAuth();
    const now = new Date().toISOString();
    const refId = `ref_metrics_${Date.now()}`;
    const mk = (action: string, unitType: string, unitId: string) =>
      prisma.memoryUsageEvent.create({
        data: { userId, unitType, unitId, action, sessionId: 's_metrics', at: now },
      });
    await mk('referenced', 'reference', refId);
    await mk('referenced', 'reference', refId);
    await mk('accepted', 'reference', refId);
    await mk('suggested', 'reference', `${refId}_b`);
    await mk('dismissed', 'reference', `${refId}_b`);
    await mk('retrieved', 'summary', 'sum_metrics');
    await prisma.referenceItem.create({
      data: { id: refId, userId, kind: 'pasted_text', sourceRef: null, label: '指标材料一', snapshot: 'x', createdAt: now, updatedAt: now },
    });

    const get = async (p: string) =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/admin/metrics/memory/${p}`, headers })).payload);

    const overview = await get('overview?days=14');
    expect(overview.days).toBe(14);
    expect(overview.totals.events).toBeGreaterThanOrEqual(6);
    expect(overview.byActionUnitType.some((x: any) => x.action === 'referenced' && x.unitType === 'reference' && x.count >= 2)).toBe(true);
    expect(overview.daily.length).toBeGreaterThanOrEqual(1);

    const sug = await get('suggestions?days=14');
    expect(sug.suggested).toBeGreaterThanOrEqual(1);
    expect(sug.accepted).toBeGreaterThanOrEqual(1);
    expect(sug.dismissed).toBeGreaterThanOrEqual(1);
    const resolved = sug.accepted + sug.dismissed;
    expect(sug.acceptRate).toBeCloseTo(sug.accepted / resolved, 5);

    const refs = await get('references?days=14&limit=10');
    const row = refs.items.find((i: any) => i.referenceId === refId);
    expect(row).toBeTruthy();
    expect(row.uses).toBe(3);
    expect(row.label).toBe('指标材料一');

    // gap 指标来自用户 eventLog（JSONL）。
    const dir = twinsBaseDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'event_log.jsonl'), [
      { idx: 1, timestamp: Date.now() - 1000, eventType: 'memory_gap_detected', content: '', metadata: {}, agentId: userId, sessionId: 's_metrics' },
      { idx: 2, timestamp: Date.now() - 900, eventType: 'memory_gap_answered', content: '', metadata: {}, agentId: userId, sessionId: 's_metrics' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const gaps = await get('gaps?days=14');
    expect(gaps.detected).toBeGreaterThanOrEqual(1);
    expect(gaps.answered).toBeGreaterThanOrEqual(1);
    expect(gaps.answerRate).toBeGreaterThan(0);

    // 非 admin 一律 403。
    const second = await registerSecondUser();
    for (const p of ['overview', 'suggestions', 'gaps', 'references']) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/admin/metrics/memory/${p}?days=7`,
        headers: { authorization: `Bearer ${second.token}` },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
