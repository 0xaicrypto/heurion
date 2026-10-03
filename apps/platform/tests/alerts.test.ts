import { describe, expect, it } from 'vitest'
import type { Mailer } from '../src/auth/mailer.ts'
import { Alerts } from '../src/ops-alert/alerts.ts'
import { Store } from '../src/store/db.ts'

function env() {
  const store = new Store(':memory:')
  const admin = store.createUser({ username: 'admin', display_name: '管理员', password_hash: 'x', role: 'admin', email: 'ops@hosp.cn' })
  store.createUser({ username: 'noemail', display_name: '没邮箱的管理员', password_hash: 'x', role: 'admin' })
  store.createUser({ username: 'user', display_name: '普通用户', password_hash: 'x', role: 'user', email: 'u@hosp.cn' })
  const sent: Array<{ to: string; subject: string }> = []
  const mailer: Mailer = { configured: true, available: true, send: async (to, subject) => { sent.push({ to, subject }) } }
  const alerts = new Alerts(store, mailer, { log: () => {} })
  return { store, admin, sent, alerts }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('运维告警', () => {
  it('模型认证失败立即告警，只发给有邮箱的在职管理员；一小时内同类不重复', async () => {
    const t = env()
    t.alerts.turnFailed('Authentication Fails, Your api key: ****9LQL is invalid')
    await flush()
    expect(t.sent).toEqual([{ to: 'ops@hosp.cn', subject: '[Heurion 告警] 模型服务认证失败（API key 无效）' }])
    t.alerts.turnFailed('Authentication Fails, Your api key: ****9LQL is invalid')
    await flush()
    expect(t.sent).toHaveLength(1)
  })

  it('一般失败（超时、网络）攒够阈值才告警', async () => {
    const t = env()
    for (let i = 0; i < 4; i++) t.alerts.turnFailed('模型服务 5 分钟无响应，已自动停止')
    await flush()
    expect(t.sent).toEqual([])
    t.alerts.turnFailed('fetch failed')
    await flush()
    expect(t.sent.map(s => s.subject)).toEqual(['[Heurion 告警] AI 回合大量失败'])
  })

  it('余额不足单独告警；没有可发的管理员时不报错', async () => {
    const t = env()
    t.alerts.turnFailed('402 Insufficient Balance')
    await flush()
    expect(t.sent.map(s => s.subject)).toEqual(['[Heurion 告警] 模型服务余额不足'])
    const empty = new Alerts(new Store(':memory:'), { configured: true, available: true, send: async () => { throw new Error('不该发') } }, { log: () => {} })
    expect(await empty.notify('model_auth', 'x')).toBe('no_recipient')
  })
})
