import { describe, it, expect } from 'vitest'
import { Store } from '../src/store/db.ts'
import { MailService } from '../src/mail/service.ts'
import { CalendarService } from '../src/calendar/service.ts'
import type { Mailer, SendMailOptions } from '../src/auth/mailer.ts'
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
  store.createUser({ id: 'dev', username: 'dev', display_name: '开发者', password_hash: 'x', role: 'admin', email: 'dev@heurion.org' })
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

    // 域名使用 heurion.org (支持每个医生专属邮箱，如 hui@heurion.org)
    expect(mail.userEmail('wang')).toBe('wang@heurion.org')
    expect(mail.userEmail('hui')).toBe('hui@heurion.org')
    expect(mail.userEmail('Dr_Zhao')).toBe('dr_zhao@heurion.org')

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
    expect(abpaMail?.recipient).toBe('wang@heurion.org')

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
    expect(matchedMail?.recipient).toBe('zhao@heurion.org')

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
    expect(firstMail.recipient).toMatch(/@(heurion\.org|heurion\.com)/)

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
        recipient: 'test@heurion.org',
        subject: 'API 发送测试随访计划',
        body: '这是通过 API 发送的测试邮件正文',
        category: 'followup',
        patient_code: 'PT-001',
      }),
    })
    expect(composeRes.status).toBe(201)
    const composed = await composeRes.json() as any
    expect(composed.id).toBeDefined()
    expect(composed.sender).toMatch(/@(heurion\.org|heurion\.com)/)

    // 6. 外部来信 Inbound Webhook 投递测试 (例如外部患者发往 dev@heurion.org)
    const inboundRes = await api.post('/api/mail/inbound', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'patient.external@gmail.com',
        from_name: '外部患者张先生',
        to: 'dev@heurion.org',
        subject: '口服吡非尼酮后轻微乏力咨询',
        body: '李医生您好，最近服药后有些乏力，是否需要调整剂量？',
      }),
    })
    expect(inboundRes.status).toBe(201)
    const inboundJson = await inboundRes.json() as any
    expect(inboundJson.ok).toBe(true)
    expect(inboundJson.id).toBeDefined()

    // 确认该邮件已即时投递到医生 dev 的收件箱
    const checkMailRes = await api.get(`/api/mail/messages/${inboundJson.id}`)
    expect(checkMailRes.status).toBe(200)
    const received = await checkMailRes.json() as any
    expect(received.sender).toBe('patient.external@gmail.com')
    expect(received.recipient).toBe('dev@heurion.org')
    expect(received.subject).toContain('口服吡非尼酮后轻微乏力咨询')
    expect(received.folder).toBe('inbox')

    // 7. 获取日历事件列表
    const calRes = await api.get('/api/calendar/events')
    expect(calRes.status).toBe(200)
    const events = await calRes.json() as any[]
    expect(events.length).toBeGreaterThanOrEqual(5)

    // 8. 新建日历事件
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

    // 9. 更新日历事件
    const updateEvRes = await api.patch(`/api/calendar/events/${createdEv.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(updateEvRes.status).toBe(200)
    const updatedEv = await updateEvRes.json() as any
    expect(updatedEv.status).toBe('completed')

    // 10. 删除日历事件
    const delEvRes = await api.delete(`/api/calendar/events/${createdEv.id}`)
    expect(delEvRes.status).toBe(200)
  })

  it('4. 方案3实施验证：外部来信 Webhook 投递入库，并自动向医生个人邮箱转发副本', async () => {
    const store = new Store(':memory:')
    // 创建医生用户，并绑定其真实的外部个人邮箱（如 zhaojimmy13@gmail.com）
    const doctor = store.createUser({
      id: 'dr_hui',
      username: 'hui',
      display_name: '赵辉 主任医师',
      password_hash: 'x',
      email: 'zhaojimmy13@gmail.com',
    })

    const forwardedMails: Array<{ to: string; subject: string; text: string; opts?: any }> = []
    const mockMailer: any = {
      configured: true,
      available: true,
      mode: 'smtp',
      send: async (to: string, subject: string, text: string, _html?: string, opts?: any) => {
        forwardedMails.push({ to, subject, text, opts })
        return { success: true, mode: 'smtp' }
      },
    }

    const mail = new MailService(store, mockMailer, { domain: 'heurion.org' })
    expect(mail.userEmail('hui')).toBe('hui@heurion.org')

    // 外部患者发信到 hui@heurion.org
    const res = await mail.receiveInbound({
      from: 'patient.li@163.com',
      fromName: '李患者',
      to: 'hui@heurion.org',
      subject: '关于术后复查 CT 时间预约咨询',
      body: '赵主任您好，我刚做完术后第一疗程，请问下周二能预约做薄层 CT 吗？',
    })

    expect(res.success).toBe(true)
    expect(res.message).toBeDefined()
    expect(res.forwardedTo).toBe('zhaojimmy13@gmail.com')

    // 1. 验证工作台【📥 收件箱】已正确归档
    const inbox = mail.list('dr_hui', 'hui', { folder: 'inbox' })
    const saved = inbox.find(m => m.id === res.message?.id)
    expect(saved).toBeDefined()
    expect(saved?.sender).toBe('patient.li@163.com')
    expect(saved?.recipient).toBe('hui@heurion.org')
    expect(saved?.subject).toBe('关于术后复查 CT 时间预约咨询')

    // 2. 验证自动向医生的个人邮箱转发了一份副本
    expect(forwardedMails.length).toBe(1)
    const forward = forwardedMails[0]!
    expect(forward.to).toBe('zhaojimmy13@gmail.com')
    expect(forward.subject).toContain('关于术后复查 CT 时间预约咨询')
    expect(forward.text).toContain('赵主任您好')
    expect(forward.opts?.replyTo).toBe('patient.li@163.com')
    expect(forward.opts?.senderAddress).toBe('hui@heurion.org')
  })

  it('5. 邮件与日历的分页 (Paging) 与批量操作 (Batch Operations) 端到端接口验证', async () => {
    const api = makeTestApp()

    // 1. 测试邮件分页接口
    const pagedRes = await api.get('/api/mail/messages?page=1&page_size=2&folder=inbox')
    expect(pagedRes.status).toBe(200)
    const pagedData = await pagedRes.json() as any
    expect(pagedData.items).toBeDefined()
    expect(pagedData.items.length).toBe(2)
    expect(pagedData.total).toBeGreaterThanOrEqual(5)
    expect(pagedData.page).toBe(1)
    expect(pagedData.page_size).toBe(2)
    expect(pagedData.total_pages).toBeGreaterThanOrEqual(3)

    const [mail1, mail2] = pagedData.items
    expect(mail1.id).toBeDefined()
    expect(mail2.id).toBeDefined()

    // 2. 测试邮件标星接口
    const starRes = await api.patch(`/api/mail/messages/${mail1.id}/star`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    })
    expect(starRes.status).toBe(200)

    // 3. 测试批量标为已读与批量标星
    const batchReadRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', ids: [mail1.id, mail2.id] }),
    })
    expect(batchReadRes.status).toBe(200)
    const batchReadData = await batchReadRes.json() as any
    expect(batchReadData.ok).toBe(true)
    expect(batchReadData.count).toBe(2)

    // 4. 测试批量移入废纸篓 (trash) 与批量恢复 (restore)
    const batchTrashRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trash', ids: [mail1.id] }),
    })
    expect(batchTrashRes.status).toBe(200)

    const checkTrashRes = await api.get('/api/mail/messages?folder=trash')
    const trashItems = await checkTrashRes.json() as any[]
    expect(trashItems.some(m => m.id === mail1.id)).toBe(true)

    // 恢复
    const batchRestoreRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore', ids: [mail1.id] }),
    })
    expect(batchRestoreRes.status).toBe(200)

    // 5. 测试日历分页接口
    const calPagedRes = await api.get('/api/calendar/events?page=1&page_size=2')
    expect(calPagedRes.status).toBe(200)
    const calPagedData = await calPagedRes.json() as any
    expect(calPagedData.items.length).toBe(2)
    expect(calPagedData.total).toBeGreaterThanOrEqual(5)

    // 6. 测试日历批量设为已完成与批量恢复待办
    const [ev1, ev2] = calPagedData.items
    const calBatchRes = await api.post('/api/calendar/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', ids: [ev1.id, ev2.id] }),
    })
    expect(calBatchRes.status).toBe(200)
    const calBatchData = await calBatchRes.json() as any
    expect(calBatchData.ok).toBe(true)

    const checkEv1 = await api.get(`/api/calendar/events/${ev1.id}`)
    const ev1Data = await checkEv1.json() as any
    expect(ev1Data.status).toBe('completed')
  })

  it('6. 外部发信边界健全性：向个人互联网邮箱 (Gmail/163) 发信，即使该邮箱已绑定站内用户，也必须作为外部邮件调用 mailer.send 真实发送', async () => {
    const store = new Store(':memory:')
    const sentExternalMails: Array<{ to: string; subject: string; text: string; senderAddress?: string }> = []
    const mockMailer: Mailer = {
      configured: true,
      available: true,
      mode: 'resend',
      async send(to: string, subject: string, text: string, _html?: string, opts?: SendMailOptions) {
        sentExternalMails.push({ to, subject, text, senderAddress: opts?.senderAddress })
        return { success: true, mode: 'resend', messageId: 'msg-external-123', info: '通过 Resend 发送成功' }
      },
    }

    // 模拟注册医生账户并绑定外部个人邮箱（如 zhaojimmy13@gmail.com）
    const user = store.createUser({
      username: 'hz',
      display_name: 'Dr. HZ',
      password_hash: 'hash',
      email: 'zhaojimmy13@gmail.com',
    })

    const mailService = new MailService(store, mockMailer, { domain: 'heurion.org' })

    // 医生在平台发信给自己的个人 Gmail 邮箱进行测试
    const result = await mailService.sendAsync({
      userId: user.id,
      recipient: 'zhaojimmy13@gmail.com',
      subject: '临床诊断随访测试',
      body: '测试正文内容',
      category: 'general',
    })

    // 核心验证：
    // 1. 必须判定为外部邮件 (external: true)
    expect(result.delivery.external).toBe(true)
    // 2. 投递状态必须为 external_sent，而非内部协同
    expect(result.delivery.status).toBe('external_sent')
    expect(result.delivery.note).toContain('RESEND')
    // 3. 真实调用了 mockMailer.send 并发送给 zhaojimmy13@gmail.com
    expect(sentExternalMails.length).toBe(1)
    expect(sentExternalMails[0]?.to).toBe('zhaojimmy13@gmail.com')
    // 4. 发件地址规范化为 @heurion.org
    expect(sentExternalMails[0]?.senderAddress).toBe('hz@heurion.org')
    // 5. 不会在自己的站内 inbox 里虚假生成一封「院内即时协同送达」邮件
    const inboxMails = mailService.list(user.id, user.username, { folder: 'inbox' })
    expect(inboxMails.some(m => m.subject === '临床诊断随访测试')).toBe(false)
  })
})

