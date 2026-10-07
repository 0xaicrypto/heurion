import { describe, it, expect } from 'vitest'
import { Store } from '../src/store/db.ts'
import { MailService } from '../src/mail/service.ts'
import { CalendarService } from '../src/calendar/service.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { TurnService } from '../src/turns/service.ts'

function makeTestApp() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 'test-secret', baseMax: 300, minDelayMs: 0 }) })
  const mail = new MailService(store)
  const calendar = new CalendarService(store, mail)
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
    accounts, devMode: true, devUser: 'dev', mail, calendar,
  })
  const call = (method: string, path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer dev')
    return app.request(path, { ...init, method, headers })
  }
  return {
    get: (path: string, init?: RequestInit) => call('GET', path, init),
    post: (path: string, init?: RequestInit) => call('POST', path, init),
    patch: (path: string, init?: RequestInit) => call('PATCH', path, init),
    delete: (path: string, init?: RequestInit) => call('DELETE', path, init),
  }
}

describe('邮件与日历系统集成 (Mail & Calendar Integration)', () => {
  it('1. MailService: 邮箱域名规范化、智能种子随访与科研邮件、收发与标记已读', () => {
    const store = new Store(':memory:')
    const mail = new MailService(store)

    // 域名使用 heurion.com
    expect(mail.userEmail('wang')).toBe('dr.wang@heurion.com')
    expect(mail.userEmail('Dr_Zhao')).toBe('dr.dr_zhao@heurion.com')

    // 首次访问自动载入 5 封高真实度临床随访与科研进展邮件
    const list = mail.list('u1', 'wang')
    expect(list.length).toBe(5)

    // 涵盖随访计划 (followup) 与科研进度 (research)
    const followups = list.filter(m => m.category === 'followup')
    const researches = list.filter(m => m.category === 'research')
    expect(followups.length).toBeGreaterThanOrEqual(3)
    expect(researches.length).toBeGreaterThanOrEqual(2)

    // 随访邮件包含具体患者代号与临床复查指标
    const abpaMail = list.find(m => m.patient_code === 'PT-BRONCHO-001')
    expect(abpaMail).toBeDefined()
    expect(abpaMail?.subject).toContain('PT-BRONCHO-001')
    expect(abpaMail?.body).toContain('BAR = 1.45')
    expect(abpaMail?.body).toContain('HAM = 12.44 cm³')
    expect(abpaMail?.sender).toBe('followup@heurion.com')
    expect(abpaMail?.recipient).toBe('dr.wang@heurion.com')

    // 科研邮件包含真实 DAPA-HF 课题与 PSM 质控进展
    const dapaMail = list.find(m => m.study_id === 'DAPA-HF-RCT-2019')
    expect(dapaMail).toBeDefined()
    expect(dapaMail?.subject).toContain('DAPA-HF')
    expect(dapaMail?.body).toContain('NCT03036124')
    expect(dapaMail?.body).toContain('1,420 例')
    expect(dapaMail?.body).toContain('SMD 均已收敛至 < 0.05')

    // 标记已读与全标已读
    expect(abpaMail?.read).toBe(0)
    mail.markRead('u1', abpaMail!.id, true)
    expect(mail.get('u1', abpaMail!.id)?.read).toBe(1)

    mail.markAllRead('u1')
    const allRead = mail.list('u1', 'wang')
    expect(allRead.every(m => m.read === 1)).toBe(true)

    // 发送新邮件
    const sent = mail.send({
      userId: 'u1',
      recipient: 'colleague@heurion.com',
      subject: '关于 PT-IPF-004 的吡非尼酮随访反馈',
      body: '患者目前耐受良好，未见明显光敏反应。',
      category: 'followup',
      patientId: 'PT-IPF-004',
      patientCode: 'PT-IPF-004',
    })
    expect(sent.id).toBeDefined()
    expect(sent.subject).toContain('PT-IPF-004')

    // 删除邮件
    mail.delete('u1', sent.id)
    expect(mail.get('u1', sent.id)).toBeUndefined()
  })

  it('2. CalendarService: 随访门诊日程、科研评审会排期与邮件联动创建', () => {
    const store = new Store(':memory:')
    const mail = new MailService(store)
    const calendar = new CalendarService(store, mail)

    // 首次访问自动载入临床日程与科研里程碑
    const events = calendar.list('u2', { username: 'zhao' })
    expect(events.length).toBe(5)

    const ptEvent = events.find(e => e.patient_code === 'PT-BRONCHO-001')
    expect(ptEvent).toBeDefined()
    expect(ptEvent?.title).toContain('PT-BRONCHO-001')
    expect(ptEvent?.category).toBe('followup')
    expect(ptEvent?.location).toContain('呼吸专科')

    const dapaEvent = events.find(e => e.study_id === 'DAPA-HF-RCT-2019')
    expect(dapaEvent).toBeDefined()
    expect(dapaEvent?.title).toContain('DAPA-HF')
    expect(dapaEvent?.category).toBe('research')

    // 创建新日程并联动发送通知邮件
    const newEvent = calendar.create({
      userId: 'u2',
      username: 'zhao',
      title: '【随访】PT-SARCO-003 营养预康复二期访视',
      startTime: '2026-10-20 10:00',
      endTime: '2026-10-20 11:00',
      category: 'followup',
      patientId: 'PT-SARCO-003',
      patientCode: 'PT-SARCO-003',
      location: '营养门诊',
      sendEmail: true,
    })
    expect(newEvent.id).toBeDefined()

    // 确认联动生成了一封随访提醒邮件
    const mails = mail.list('u2', 'zhao')
    const matchedMail = mails.find(m => m.subject.includes('PT-SARCO-003 营养预康复二期访视'))
    expect(matchedMail).toBeDefined()
    expect(matchedMail?.calendar_event_id).toBe(newEvent.id)
    expect(matchedMail?.recipient).toBe('dr.zhao@heurion.com')

    // 更新日程状态（完成）
    const updated = calendar.update('u2', newEvent.id, { status: 'completed' })
    expect(updated?.status).toBe('completed')

    // 删除日程
    calendar.delete('u2', newEvent.id)
    expect(calendar.get('u2', newEvent.id)).toBeUndefined()
  })

  it('3. HTTP API: /api/mail/* 与 /api/calendar/* 端到端 REST 接口健全性', async () => {
    const api = makeTestApp()

    // 1. 获取邮件列表
    const mailRes = await api.get('/api/mail/messages')
    expect(mailRes.status).toBe(200)
    const mails = await mailRes.json() as any[]
    expect(mails.length).toBeGreaterThanOrEqual(5)

    const firstMail = mails[0]
    expect(firstMail.id).toBeDefined()
    expect(firstMail.recipient).toContain('@heurion.com')

    // 2. 查单封邮件
    const singleRes = await api.get(`/api/mail/messages/${firstMail.id}`)
    expect(singleRes.status).toBe(200)
    const single = await singleRes.json() as any
    expect(single.id).toBe(firstMail.id)

    // 3. 标记已读
    const readRes = await api.patch(`/api/mail/messages/${firstMail.id}/read`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    })
    expect(readRes.status).toBe(200)

    // 4. 全部标为已读
    const allReadRes = await api.post('/api/mail/read-all')
    expect(allReadRes.status).toBe(200)

    // 5. 发送新邮件
    const composeRes = await api.post('/api/mail/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: 'test@heurion.com',
        subject: 'API 发送测试随访计划',
        body: '这是通过 API 发送的测试邮件正文',
        category: 'followup',
        patient_code: 'PT-001',
      }),
    })
    expect(composeRes.status).toBe(201)
    const composed = await composeRes.json() as any
    expect(composed.id).toBeDefined()
    expect(composed.sender).toContain('@heurion.com')

    // 6. 获取日历事件列表
    const calRes = await api.get('/api/calendar/events')
    expect(calRes.status).toBe(200)
    const events = await calRes.json() as any[]
    expect(events.length).toBeGreaterThanOrEqual(5)

    // 7. 新建日历事件
    const createEvRes = await api.post('/api/calendar/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '【科研】DAPA-HF 终点事件盲态审核',
        start_time: '2026-10-25 15:00',
        end_time: '2026-10-25 17:00',
        category: 'research',
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF (NCT03036124)',
        location: '第一会议室',
        send_email: true,
      }),
    })
    expect(createEvRes.status).toBe(201)
    const createdEv = await createEvRes.json() as any
    expect(createdEv.id).toBeDefined()

    // 8. 更新日历事件
    const updateEvRes = await api.patch(`/api/calendar/events/${createdEv.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(updateEvRes.status).toBe(200)
    const updatedEv = await updateEvRes.json() as any
    expect(updatedEv.status).toBe('completed')

    // 9. 删除日历事件
    const delEvRes = await api.delete(`/api/calendar/events/${createdEv.id}`)
    expect(delEvRes.status).toBe(200)
  })
})
