/**
 * 医疗与科研邮件工作空间 (Heurion Clinical & Research Mailbox)
 * 
 * 专为临床医生与医学科研工作者设计：
 * 1. 邮箱域名：@heurion.com (如 dr.<username>@heurion.com)
 * 2. 随访提醒邮件：患者影像 3D 容积复查、耐药基因突变监测、恶病质恶化警示
 * 3. 科研进度邮件：多中心 RCT 倾向评分匹配 (PSM) 质控报告、DSMB 盲态审核
 * 4. 深度交互联动：
 *    - 邮件一键「添加到日历」
 *    - 随访邮件一键直达「患者档案」
 *    - 科研邮件一键进入「科研课题」
 */

import { icon } from './icons.ts'
import { askConfirm } from './dialogs.ts'

export type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
export type Notice = (msg: string, error?: boolean) => void

export interface MailHooks {
  leaveDoc(): void
  openPatient?(idOrCode: string): Promise<void>
  openStudy?(idOrTitle: string): Promise<void>
  openCalendar?(eventId?: string): Promise<void>
}

export interface MailMessage {
  id: string
  owner: string
  sender: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'general'
  patient_id?: string | null
  patient_code?: string | null
  study_id?: string | null
  read: number | boolean
  created_at: string
  folder?: 'inbox' | 'sent' | 'trash'
  delivery_status?: 'delivered' | 'external_sent' | 'simulated' | 'failed'
  delivery_note?: string | null
}

export interface MailStatus {
  configured: boolean
  mode: 'smtp' | 'resend' | 'dev-mock'
  user_email: string
}

function renderDeliveryPill(status?: string): string {
  switch (status) {
    case 'external_sent':
      return '<span class="mail-delivery-pill ok" title="已成功通过外网 SMTP 发出">✓ 外网已发</span>'
    case 'delivered':
      return '<span class="mail-delivery-pill ok" title="已送达院内专邮收件箱">✓ 站内送达</span>'
    case 'simulated':
      return '<span class="mail-delivery-pill sim" title="本地开发模拟，未配置外网发信服务">⚡ 本地模拟</span>'
    case 'failed':
      return '<span class="mail-delivery-pill fail" title="发信失败">✕ 发送失败</span>'
    default:
      return ''
  }
}

const CATEGORY_NAMES: Record<string, string> = {
  followup: '随访提醒',
  research: '科研进展',
  general: '综合沟通',
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * 格式化邮件正文为具有临床科研专业排版的 HTML
 */
function formatEmailBody(raw: string): string {
  if (!raw) return ''
  const lines = raw.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push('<div class="mail-p-gap"></div>')
      continue
    }

    // 标题识别
    if (trimmed.startsWith('【') && trimmed.endsWith('】')) {
      out.push(`<h4 class="mail-section-title">${esc(trimmed)}</h4>`)
    } else if (trimmed.startsWith('# ')) {
      out.push(`<h3 class="mail-h1">${esc(trimmed.slice(2))}</h3>`)
    } else if (trimmed.startsWith('## ')) {
      out.push(`<h4 class="mail-h2">${esc(trimmed.slice(3))}</h4>`)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      // 强调临床重点指标
      const content = trimmed.slice(2)
      out.push(`<div class="mail-bullet"><span class="mail-bullet-dot">▪</span><span>${formatHighlights(content)}</span></div>`)
    } else {
      out.push(`<p class="mail-p">${formatHighlights(trimmed)}</p>`)
    }
  }

  return out.join('')
}

function formatHighlights(text: string): string {
  let res = esc(text)
  // 高亮代号与指标
  res = res.replace(/(PT-[A-Z0-9-]+)/g, '<span class="mail-hl-code">$1</span>')
  res = res.replace(/(BAR\s*=\s*[0-9.]+)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(HAM\s*=\s*[0-9.]+\s*cm³)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(SMD\s*&lt;\s*0\.05)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(\*\*(.*?)\*\*)/g, '<strong>$2</strong>')
  return res
}

export function initMail(api: Api, notice: Notice, hooks: MailHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let messages: MailMessage[] = []
  let activeFolder: 'inbox' | 'sent' = 'inbox'
  let activeFilter: 'all' | 'followup' | 'research' = 'all'
  let selectedMailId: string | null = null
  let currentUserEmail = 'dr.user@heurion.com'
  let mailStatus: MailStatus | null = null

  async function loadStatus(): Promise<void> {
    try {
      mailStatus = await api<MailStatus>('/api/mail/status')
      if (mailStatus?.user_email) {
        currentUserEmail = mailStatus.user_email
      }
    } catch (err) {
      console.error('[mail] failed to load status', err)
    }
  }

  async function loadMessages(): Promise<void> {
    try {
      if (!mailStatus) {
        await loadStatus()
      }
      const params = new URLSearchParams()
      params.set('folder', activeFolder)
      if (activeFilter !== 'all') params.set('category', activeFilter)
      messages = await api<MailMessage[]>(`/api/mail/messages?${params.toString()}`)
      if (messages[0]?.recipient && activeFolder === 'inbox') {
        currentUserEmail = messages[0].recipient
      }
      renderNavList()
      renderMain()
    } catch (err) {
      console.error('[mail] failed to load messages', err)
    }
  }

  function renderNavList(): void {
    const listEl = $('mailList')
    if (!listEl) return

    const searchInput = $('docSearch') as HTMLInputElement | null
    const kw = (searchInput?.value ?? '').trim().toLowerCase()

    const filtered = messages.filter(m => {
      if (activeFilter !== 'all' && m.category !== activeFilter) return false
      if (!kw) return true
      return (
        m.subject.toLowerCase().includes(kw) ||
        m.sender.toLowerCase().includes(kw) ||
        m.recipient.toLowerCase().includes(kw) ||
        (m.patient_code && m.patient_code.toLowerCase().includes(kw)) ||
        (m.study_id && m.study_id.toLowerCase().includes(kw))
      )
    })

    if (filtered.length === 0) {
      const emptyText = activeFolder === 'sent' ? '已发送邮件箱为空' : '收件箱为空'
      listEl.innerHTML = `<li class="doclist-empty"><div class="muted">${emptyText}</div></li>`
      return
    }

    listEl.innerHTML = filtered.map(m => {
      const isUnread = !m.read && activeFolder === 'inbox'
      const isSel = m.id === selectedMailId
      const catClass = `cat-${m.category}`
      const dateShort = m.created_at.slice(5, 16)
      const snippet = m.body.slice(0, 48).replace(/\n/g, ' ')
      const party = activeFolder === 'sent'
        ? `至: ${esc(m.recipient.split('@')[0])}`
        : esc(m.sender.split('@')[0])

      return `<li class="docitem mail-nav-item ${isSel ? 'selected' : ''} ${isUnread ? 'unread' : ''}" data-mail-id="${m.id}">
        <div class="mail-nav-top">
          <span class="mail-nav-sender">${party}</span>
          <span class="mail-nav-time">${dateShort}</span>
        </div>
        <div class="mail-nav-subject">
          ${isUnread ? '<span class="mail-unread-dot" title="未读"></span>' : ''}
          <span class="mail-subject-text">${esc(m.subject)}</span>
        </div>
        <div class="mail-nav-snippet">${esc(snippet)}…</div>
        <div class="mail-nav-bottom">
          <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
          ${renderDeliveryPill(m.delivery_status)}
          ${m.patient_code ? `<span class="mail-nav-tag">${esc(m.patient_code)}</span>` : ''}
        </div>
      </li>`
    }).join('')
  }

  function renderMain(): void {
    const page = $('page')
    if (!page) return
    page.className = 'page mail-page'

    const selectedMail = messages.find(m => m.id === selectedMailId)
    if (selectedMail) {
      renderMailDetail(selectedMail)
    } else {
      renderMailDashboard()
    }

    bindMainEvents()
  }

  function renderMailDashboard(): string {
    const unreadCount = messages.filter(m => !m.read).length
    const followupCount = messages.filter(m => m.category === 'followup').length
    const researchCount = messages.filter(m => m.category === 'research').length
    const deliveredCount = messages.filter(m => m.delivery_status === 'delivered' || m.delivery_status === 'external_sent').length
    const simulatedCount = messages.filter(m => m.delivery_status === 'simulated').length

    const isSent = activeFolder === 'sent'
    const page = $('page')
    page.innerHTML = `
      <div class="mail-dashboard">
        <div class="mail-dash-hero">
          <div class="mail-dash-hero-left">
            <div class="mail-dash-icon-wrap">${icon('mail', { size: 28 })}</div>
            <div>
              <h1 class="mail-dash-title">${isSent ? 'Heurion 邮件工作台 · 已发送 (Outbox / Sent)' : 'Heurion 医疗与科研工作站邮箱'}</h1>
              <p class="mail-dash-sub">${isSent ? '记录所有外发随访提醒、科研进展通报与外网 SMTP / 本地模拟投递状态' : '专属临床随访跟踪通知、真实世界研究 (RWE) 质控与跨中心科研协作专邮'}</p>
            </div>
          </div>
          <div class="mail-doctor-badge">
            <span class="mail-doc-label">当前医生专属邮箱</span>
            <span class="mail-doc-address" id="copyMailAddress" title="点击复制邮箱地址">
              ${esc(currentUserEmail)}
              <span class="mail-copy-icon">${icon('copy', { size: 13 })}</span>
            </span>
          </div>
        </div>

        <div class="mail-stats-grid">
          <div class="mail-stat-card" data-filter="all">
            <div class="mail-stat-num">${messages.length}</div>
            <div class="mail-stat-label">${isSent ? '全部已发送 (Sent)' : '全部邮件 (Total)'}</div>
          </div>
          ${isSent ? `
            <div class="mail-stat-card accent-followup" data-filter="followup">
              <div class="mail-stat-num">${deliveredCount}</div>
              <div class="mail-stat-label">已成功送达 (Delivered)</div>
            </div>
            <div class="mail-stat-card accent-unread" data-filter="unread">
              <div class="mail-stat-num">${simulatedCount}</div>
              <div class="mail-stat-label">本地模拟记录 (Simulated)</div>
            </div>
            <div class="mail-stat-card accent-research" data-filter="research">
              <div class="mail-stat-num">${followupCount}</div>
              <div class="mail-stat-label">随访复查预警 (Follow-up)</div>
            </div>
          ` : `
            <div class="mail-stat-card accent-unread" data-filter="unread">
              <div class="mail-stat-num">${unreadCount}</div>
              <div class="mail-stat-label">未读待阅 (Unread)</div>
            </div>
            <div class="mail-stat-card accent-followup" data-filter="followup">
              <div class="mail-stat-num">${followupCount}</div>
              <div class="mail-stat-label">患者随访计划 (Follow-up)</div>
            </div>
            <div class="mail-stat-card accent-research" data-filter="research">
              <div class="mail-stat-num">${researchCount}</div>
              <div class="mail-stat-label">科研进度通报 (Research)</div>
            </div>
          `}
        </div>

        <div class="mail-dash-sections">
          <div class="mail-dash-panel">
            <div class="mail-panel-head">
              <h3>${icon('users', { size: 16 })} 近期重点随访提醒</h3>
              <span class="muted">自动匹配患者影像量化指标与复查窗口</span>
            </div>
            <div class="mail-card-list">
              ${messages.filter(m => m.category === 'followup').slice(0, 3).map(m => `
                <div class="mail-preview-card" data-mail-id="${m.id}">
                  <div class="mail-preview-top">
                    <span class="mail-badge cat-followup">随访通知</span>
                    ${renderDeliveryPill(m.delivery_status)}
                    ${m.patient_code ? `<span class="mail-preview-pt">${icon('users', { size: 12 })} ${esc(m.patient_code)}</span>` : ''}
                    <span class="grow"></span>
                    <span class="mail-preview-date">${m.created_at.slice(5, 16)}</span>
                  </div>
                  <div class="mail-preview-sub">${esc(m.subject)}</div>
                  <div class="mail-preview-snippet">${esc(m.body.slice(0, 90))}…</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="mail-dash-panel">
            <div class="mail-panel-head">
              <h3>${icon('microscope', { size: 16 })} 科研课题推进与统计审核</h3>
              <span class="muted">涵盖多中心 RCT、PSM 质控与 DSMB 会议纪要</span>
            </div>
            <div class="mail-card-list">
              ${messages.filter(m => m.category === 'research').slice(0, 3).map(m => `
                <div class="mail-preview-card" data-mail-id="${m.id}">
                  <div class="mail-preview-top">
                    <span class="mail-badge cat-research">科研进展</span>
                    ${renderDeliveryPill(m.delivery_status)}
                    ${m.study_id ? `<span class="mail-preview-st">${icon('microscope', { size: 12 })} ${esc(m.study_id)}</span>` : ''}
                    <span class="grow"></span>
                    <span class="mail-preview-date">${m.created_at.slice(5, 16)}</span>
                  </div>
                  <div class="mail-preview-sub">${esc(m.subject)}</div>
                  <div class="mail-preview-snippet">${esc(m.body.slice(0, 90))}…</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `
    return ''
  }

  function renderMailDetail(m: MailMessage): void {
    const page = $('page')
    const catClass = `cat-${m.category}`
    const isUnread = !m.read && activeFolder === 'inbox'
    const isSent = m.folder === 'sent' || activeFolder === 'sent'

    page.innerHTML = `
      <div class="mail-detail-wrap">
        <div class="mail-toolbar">
          <button class="mail-btn ghost" id="mailBackBtn">${isSent ? '‹ 返回已发送' : '‹ 返回收件箱'}</button>
          <span class="grow"></span>
          ${!isSent ? `<button class="mail-btn ghost" id="mailToggleRead">${isUnread ? '标为已读' : '标为未读'}</button>` : ''}
          <button class="mail-btn ghost" id="mailAddToCal" title="将邮件关联的复查或会议添加到日历">
            ${icon('calendar', { size: 14 })} 添加到日历
          </button>
          <button class="mail-btn ghost danger" id="mailDelete">删除</button>
        </div>

        <div class="mail-content-card">
          <div class="mail-card-header">
            <div class="mail-header-badge-row">
              <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
              ${renderDeliveryPill(m.delivery_status)}
              ${m.patient_code ? `<span class="mail-header-tag tag-pt">${icon('users', { size: 13 })} 患者代号: ${esc(m.patient_code)}</span>` : ''}
              ${m.study_id ? `<span class="mail-header-tag tag-st">${icon('microscope', { size: 13 })} 课题代号: ${esc(m.study_id)}</span>` : ''}
              <span class="grow"></span>
              <span class="mail-header-time">${m.created_at}</span>
            </div>
            <h1 class="mail-subject-display">${esc(m.subject)}</h1>
            <div class="mail-meta-info">
              <div class="mail-meta-row">
                <span class="mail-meta-k">发件人:</span>
                <span class="mail-meta-v"><b class="mail-sender-name">${esc(m.sender)}</b></span>
              </div>
              <div class="mail-meta-row">
                <span class="mail-meta-k">收件人:</span>
                <span class="mail-meta-v">${esc(m.recipient)}</span>
              </div>
            </div>

            ${(m.delivery_status || isSent) ? `
              <div class="mail-delivery-notice ${m.delivery_status === 'external_sent' || m.delivery_status === 'delivered' ? 'ok' : m.delivery_status === 'simulated' ? 'simulated' : 'fail'}">
                <div class="mail-delivery-title">
                  ${m.delivery_status === 'external_sent' ? '✓ 外网邮件投递成功 (SMTP)' :
                    m.delivery_status === 'delivered' ? '✓ 站内信件投递成功' :
                    m.delivery_status === 'simulated' ? '⚡ 本地开发模拟（未配置外网发信服务）' :
                    m.delivery_status === 'failed' ? '✕ 外网发信失败' : '投递状态已记录'}
                </div>
                <div class="mail-delivery-text">
                  ${m.delivery_note ? esc(m.delivery_note) : (
                    m.delivery_status === 'external_sent' ? `已通过外网 SMTP 服务成功推送给收件人 ${esc(m.recipient)}。` :
                    m.delivery_status === 'delivered' ? `收件人系院内专邮工作站用户，已投递至其收件箱。` :
                    m.delivery_status === 'simulated' ? `当前环境未配置 SMTP_HOST / RESEND_API_KEY，系统在本地已模拟记录。如需真正发送至外部邮箱，请在 .env 中设置 SMTP 参数。` :
                    '外发状态已记录。'
                  )}
                </div>
              </div>
            ` : ''}
          </div>

          ${(m.patient_code || m.study_id) ? `
            <div class="mail-fast-actions-bar">
              <span class="fast-action-hint">临床与科研直达通道：</span>
              ${m.patient_code ? `
                <button class="fast-action-btn pt-action" id="mailJumpPatient" data-code="${esc(m.patient_code)}">
                  ${icon('users', { size: 14 })} 查看患者全景档案 (${esc(m.patient_code)}) →
                </button>
              ` : ''}
              ${m.study_id ? `
                <button class="fast-action-btn st-action" id="mailJumpStudy" data-study="${esc(m.study_id)}">
                  ${icon('microscope', { size: 14 })} 进入科研课题 (${esc(m.study_id)}) →
                </button>
              ` : ''}
            </div>
          ` : ''}

          <div class="mail-body-render">
            ${formatEmailBody(m.body)}
          </div>

          <div class="mail-footer-signature">
            <div class="mail-sig-line">Heurion Clinical Intelligence & Research Gateway</div>
            <div class="mail-sig-sub">电子邮箱通知专函 · 统一身份与多中心科研系统</div>
          </div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `

    // Mark as read automatically when opening
    if (isUnread) {
      void api(`/api/mail/messages/${m.id}/read`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }).then(() => {
        m.read = 1
        renderNavList()
      })
    }
  }

  function bindMainEvents(): void {
    const page = $('page')

    // Copy doctor email address
    $('copyMailAddress')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(currentUserEmail)
      notice('已复制医生工作邮箱地址: ' + currentUserEmail)
    })

    // Back to dashboard
    $('mailBackBtn')?.addEventListener('click', () => {
      selectedMailId = null
      renderNavList()
      renderMain()
    })

    // Click on preview card
    page.addEventListener('click', async e => {
      const target = e.target as HTMLElement

      const card = target.closest<HTMLElement>('[data-mail-id]')
      if (card && !target.closest('button')) {
        const id = card.dataset.mailId
        if (id) {
          selectedMailId = id
          renderNavList()
          renderMain()
        }
        return
      }

      // Patient jump
      const ptJump = target.closest<HTMLElement>('#mailJumpPatient')
      if (ptJump && hooks.openPatient) {
        const code = ptJump.dataset.code!
        await hooks.openPatient(code)
        return
      }

      // Study jump
      const stJump = target.closest<HTMLElement>('#mailJumpStudy')
      if (stJump && hooks.openStudy) {
        const study = stJump.dataset.study!
        await hooks.openStudy(study)
        return
      }

      // Add to calendar
      const calBtn = target.closest<HTMLElement>('#mailAddToCal')
      if (calBtn && selectedMailId) {
        const mail = messages.find(x => x.id === selectedMailId)
        if (mail) {
          await addEmailToCalendar(mail)
        }
        return
      }

      // Toggle read
      const readBtn = target.closest<HTMLElement>('#mailToggleRead')
      if (readBtn && selectedMailId) {
        const mail = messages.find(x => x.id === selectedMailId)
        if (mail) {
          const newRead = !mail.read
          await api(`/api/mail/messages/${mail.id}/read`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: newRead }),
          })
          mail.read = newRead ? 1 : 0
          notice(newRead ? '已标记为已读' : '已标记为未读')
          renderNavList()
          renderMain()
        }
        return
      }

      // Delete
      const delBtn = target.closest<HTMLElement>('#mailDelete')
      if (delBtn && selectedMailId) {
        const ok = await askConfirm({
          title: '删除邮件',
          message: '确定要删除此邮件吗？',
          confirm: '确认删除',
          danger: true,
        })
        if (ok) {
          await api(`/api/mail/messages/${selectedMailId}`, { method: 'DELETE' })
          notice('邮件已删除')
          selectedMailId = null
          await loadMessages()
        }
      }
    })
  }

  async function addEmailToCalendar(mail: MailMessage): Promise<void> {
    const today = new Date()
    const nextWeek = new Date(today.getTime() + 7 * 86400000)
    const dateStr = nextWeek.toISOString().slice(0, 10)
    const startTime = `${dateStr} 10:00`
    const endTime = `${dateStr} 11:30`

    try {
      await api('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `【${CATEGORY_NAMES[mail.category]}】${mail.subject}`,
          category: mail.category === 'research' ? 'research' : 'followup',
          start_time: startTime,
          end_time: endTime,
          patient_code: mail.patient_code || undefined,
          study_title: mail.study_id || undefined,
          notes: `由邮件《${mail.subject}》一键转化生成：\n${mail.body.slice(0, 140)}...`,
          send_email: false,
        }),
      })
      notice('已成功将此事项添加到日历排期！')
      if (hooks.openCalendar) {
        await hooks.openCalendar()
      }
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  function showComposeModal(): void {
    const anchor = $('mailModalAnchor')
    if (!anchor) return

    anchor.innerHTML = `
      <div class="mail-modal-scrim" id="mailComposeScrim">
        <div class="mail-modal-card compose-card" role="dialog" aria-modal="true">
          <div class="mail-modal-head">
            <h2>＋ 起草并发送医疗通知专邮</h2>
            <button class="mail-modal-close" id="mailComposeClose">✕</button>
          </div>
          <div class="mail-smtp-status-tip ${mailStatus?.configured ? 'configured' : 'mock'}">
            ${mailStatus?.configured
              ? `<span class="smtp-dot ok"></span> <strong>发信服务已连接 (${mailStatus.mode === 'smtp' ? '标准 SMTP' : 'Resend'})</strong>：支持直接向外部真实邮箱（如 Gmail、网易、QQ 邮箱等）真实发信。`
              : `<span class="smtp-dot warn"></span> <strong>本地开发模拟模式</strong>：当前未配置外网发信服务 (SMTP)。发往外部邮箱时将在本地保留记录并模拟成功。如需真实发送至外部邮箱，请在 <code>.env</code> 中配置 <code>SMTP_HOST</code>。`
            }
          </div>
          <form id="mailComposeForm" class="mail-form">
            <div class="form-row">
              <label>收件人邮箱 (Recipient) *</label>
              <input type="email" id="composeTo" required value="colleague@heurion.com" placeholder="someone@heurion.com" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>邮件分类</label>
                <select id="composeCategory">
                  <option value="followup">患者随访计划 (Follow-up)</option>
                  <option value="research">科研项目进展 (Research)</option>
                  <option value="general">临床综合沟通 (General)</option>
                </select>
              </div>
              <div class="form-row">
                <label>发件人身份</label>
                <input type="text" disabled value="${esc(currentUserEmail)}" class="disabled-input" />
              </div>
            </div>

            <div class="form-row">
              <label>邮件主题 (Subject) *</label>
              <input type="text" id="composeSubject" required placeholder="如：PT-BRONCHO-001 气道高密度栓塞第12周三维影像随访计划" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>关联患者代号 (可选)</label>
                <input type="text" id="composePtCode" placeholder="如：PT-BRONCHO-001" />
              </div>
              <div class="form-row">
                <label>关联科研项目 (可选)</label>
                <input type="text" id="composeStudy" placeholder="如：DAPA-HF (NCT03036124)" />
              </div>
            </div>

            <div class="form-row">
              <label>正文内容 (Body) *</label>
              <textarea id="composeBody" rows="8" required placeholder="输入详细随访计划、影像复查指引、临床指标预警或科研推进通知…"></textarea>
            </div>

            <div class="mail-modal-foot">
              <button type="button" class="mail-btn ghost" id="mailComposeCancel">取消</button>
              <button type="submit" class="mail-btn primary" id="mailComposeSubmit">发送邮件</button>
            </div>
          </form>
        </div>
      </div>
    `

    const scrim = $('mailComposeScrim')
    const close = () => { scrim?.remove() }
    $('mailComposeClose')?.addEventListener('click', close)
    $('mailComposeCancel')?.addEventListener('click', close)
    scrim?.addEventListener('click', e => { if (e.target === scrim) close() })

    const form = $('mailComposeForm') as HTMLFormElement
    form.onsubmit = async e => {
      e.preventDefault()
      const recipient = ($('composeTo') as HTMLInputElement).value.trim()
      const category = ($('composeCategory') as HTMLSelectElement).value as MailMessage['category']
      const subject = ($('composeSubject') as HTMLInputElement).value.trim()
      const patient_code = ($('composePtCode') as HTMLInputElement).value.trim() || undefined
      const study_id = ($('composeStudy') as HTMLInputElement).value.trim() || undefined
      const body = ($('composeBody') as HTMLTextAreaElement).value.trim()

      try {
        const res = await api<{ id?: string; delivery?: { status?: string; note?: string } }>('/api/mail/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient,
            category,
            subject,
            patient_code,
            study_id,
            body,
          }),
        })

        if (res?.delivery?.status === 'external_sent') {
          notice('邮件已通过外网 SMTP 成功发出！')
        } else if (res?.delivery?.status === 'simulated') {
          notice('邮件已保存为已发送（本地模拟记录，未配置外网 SMTP）')
        } else if (res?.delivery?.status === 'failed') {
          notice('外网邮件发送失败：' + (res.delivery.note || '请检查 SMTP 配置'), true)
        } else {
          notice('邮件已成功投递！')
        }

        close()
        // Switch to Sent folder and auto select newly sent message
        activeFolder = 'sent'
        updateFolderButtons()
        selectedMailId = res?.id || null
        await loadMessages()
      } catch (err) {
        notice((err as Error).message, true)
      }
    }
  }

  function updateFolderButtons(): void {
    const btnInbox = $('mailFolderInbox')
    const btnSent = $('mailFolderSent')
    btnInbox?.classList.toggle('on', activeFolder === 'inbox')
    btnSent?.classList.toggle('on', activeFolder === 'sent')
  }

  // Wire action buttons in nav-panel
  function initActionPills(): void {
    const fAll = $('mailFilterAll')
    const fFollowup = $('mailFilterFollowup')
    const fResearch = $('mailFilterResearch')
    const composeBtn = $('composeMailBtn')
    const btnInbox = $('mailFolderInbox')
    const btnSent = $('mailFolderSent')

    composeBtn?.addEventListener('click', () => showComposeModal())

    btnInbox?.addEventListener('click', () => {
      if (activeFolder !== 'inbox') {
        activeFolder = 'inbox'
        selectedMailId = null
        updateFolderButtons()
        void loadMessages()
      }
    })

    btnSent?.addEventListener('click', () => {
      if (activeFolder !== 'sent') {
        activeFolder = 'sent'
        selectedMailId = null
        updateFolderButtons()
        void loadMessages()
      }
    })

    const updatePills = (active: 'all' | 'followup' | 'research') => {
      activeFilter = active
      fAll?.classList.toggle('on', active === 'all')
      fFollowup?.classList.toggle('on', active === 'followup')
      fResearch?.classList.toggle('on', active === 'research')
      void loadMessages()
    }

    fAll?.addEventListener('click', () => updatePills('all'))
    fFollowup?.addEventListener('click', () => updatePills('followup'))
    fResearch?.addEventListener('click', () => updatePills('research'))

    $('docSearch')?.addEventListener('input', () => {
      if (!$('mailList')?.hidden) renderNavList()
    })

    // Left nav item selection
    $('mailList')?.addEventListener('click', e => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('.mail-nav-item')
      if (li) {
        const id = li.dataset.mailId
        if (id) {
          selectedMailId = id
          renderNavList()
          renderMain()
        }
      }
    })
  }

  initActionPills()

  return {
    async enter(): Promise<void> {
      hooks.leaveDoc()
      await loadMessages()
    },
    leave(): void {
      selectedMailId = null
    },
    async openMail(id: string): Promise<void> {
      selectedMailId = id
      await loadMessages()
    },
    async sendMail(mailData: Partial<MailMessage>): Promise<void> {
      await api('/api/mail/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mailData),
      })
      await loadMessages()
    },
  }
}
