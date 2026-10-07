/**
 * 医疗与科研邮件工作空间 (Heurion Clinical & Research Mailbox)
 * 
 * 专为临床医生与医学科研工作者设计：
 * 1. 邮箱域名：@heurion.org (如 <username>@heurion.org)
 * 2. 随访提醒邮件：患者影像 3D 容积复查、耐药基因突变监测、恶病质恶化警示
 * 3. 科研进度邮件：多中心 RCT 倾向评分匹配 (PSM) 质控报告、DSMB 盲态审核
 * 4. 完备的收件箱管理体系：
 *    - 分页导航 (Paging & Page Size)
 *    - 批量操作 (Batch Read / Unread / Star / Trash / Restore / Delete)
 *    - 星标收藏 (Starred) 与废纸篓 (Trash)
 *    - 列表管理视图 (Mail Table) 与统计看板 (Dashboard) 自由切换
 * 5. 深度交互联动：
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
  owner?: string
  user_id?: string
  sender: string
  sender_name?: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'notification' | 'general'
  patient_id?: string | null
  patient_code?: string | null
  study_id?: string | null
  study_title?: string | null
  read: number | boolean
  starred?: number | boolean
  created_at: string
  folder?: 'inbox' | 'sent' | 'trash'
  delivery_status?: 'delivered' | 'external_sent' | 'simulated' | 'failed'
  delivery_note?: string | null
  calendar_event_id?: string | null
  thread_id?: string | null
  in_reply_to?: string | null
  thread?: MailMessage[]
}

export interface ComposeInitial {
  recipient?: string
  subject?: string
  body?: string
  category?: 'followup' | 'research' | 'notification' | 'general'
  patient_code?: string
  study_id?: string
  thread_id?: string
  in_reply_to?: string
}

export interface MailStatus {
  configured: boolean
  mode: 'smtp' | 'resend' | 'dev-mock'
  user_email: string
}

export interface MailSummaryItem {
  id: string
  subject: string
  sender: string
  recipient: string
  created_at: string
  category: string
  patient_code?: string
  study_id?: string
}

export interface MailSummaryResult {
  hours: number
  total: number
  count?: number
  unread: number
  followup_count: number
  research_count: number
  source_mails: MailSummaryItem[]
  items?: MailSummaryItem[]
  summary: string
  generated_at: string
}

function renderDeliveryPill(status?: string): string {
  switch (status) {
    case 'external_sent':
      return `<span class="mail-delivery-pill ok" title="已成功通过外网 SMTP 发出">${icon('check', { size: 10, class: 'mail-pill-icon' })} 外网已发</span>`
    case 'delivered':
      return `<span class="mail-delivery-pill ok" title="已送达院内专邮收件箱">${icon('check', { size: 10, class: 'mail-pill-icon' })} 站内送达</span>`
    case 'simulated':
      return `<span class="mail-delivery-pill sim" title="本地开发模拟，未配置外网发信服务">${icon('info', { size: 10, class: 'mail-pill-icon' })} 本地模拟</span>`
    case 'failed':
      return `<span class="mail-delivery-pill fail" title="发信失败">${icon('close', { size: 10, class: 'mail-pill-icon' })} 发送失败</span>`
    default:
      return ''
  }
}

const CATEGORY_NAMES: Record<string, string> = {
  followup: '随访提醒',
  research: '科研进展',
  notification: '系统通知',
  general: '综合沟通',
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** 浏览器端 RFC 2047 MIME 头部解码 (如 =?UTF-8?B?...?= 或 =?UTF-8?Q?...?=) */
export function decodeMimeWords(str: string): string {
  if (!str || !str.includes('=?')) return str
  const cleaned = str.replace(/(\?=\s+=\?)/g, '?==?')
  return cleaned.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const enc = encoding.toUpperCase()
      const cs = (charset || 'utf-8').toLowerCase()
      if (enc === 'B') {
        const bin = atob(text)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8').decode(bytes)
      } else if (enc === 'Q') {
        const replaced = text.replace(/_/g, ' ')
        const bytes: number[] = []
        for (let i = 0; i < replaced.length; i++) {
          if (replaced[i] === '=' && i + 2 < replaced.length && /^[0-9A-Fa-f]{2}$/.test(replaced.slice(i + 1, i + 3))) {
            bytes.push(parseInt(replaced.slice(i + 1, i + 3), 16))
            i += 2
          } else {
            bytes.push(replaced.charCodeAt(i))
          }
        }
        return new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8').decode(new Uint8Array(bytes))
      }
    } catch {
      return text
    }
    return text
  })
}

/** 浏览器端 Quoted-Printable 正文解码 */
export function decodeQuotedPrintable(str: string): string {
  if (!str) return ''
  const s = str.replace(/=\r?\n/g, '')
  if (!/=[0-9A-Fa-f]{2}/.test(s)) return s

  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const code = s.charCodeAt(i)
      if (code < 128) {
        bytes.push(code)
      } else {
        const enc = new TextEncoder().encode(s[i])
        for (const b of enc) bytes.push(b)
      }
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  } catch {
    return s
  }
}

/** 智能探测并解码 Base64 编码的邮件正文（如 Gmail / 外部客户端以 Base64 方式发送的邮件） */
export function decodeBase64Text(raw: string): string {
  if (!raw) return raw
  const trimmed = raw.trim()
  const nonB64 = trimmed.replace(/[A-Za-z0-9+/=\r\n]/g, '')
  if (nonB64.length > 0) return raw

  const compact = trimmed.replace(/\s+/g, '')
  if (compact.length < 16) return raw

  try {
    const padLen = (4 - (compact.length % 4)) % 4
    const padded = compact + '='.repeat(padLen)
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const decoded = new TextDecoder('utf-8').decode(bytes)

    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) return raw
    if (/[\u4e00-\u9fa5\w]/.test(decoded)) {
      return decoded
    }
  } catch {
    // not valid base64
  }
  return raw
}

export function decodeEmailBody(body: string): string {
  if (!body) return ''
  let text = body
  // 1. 优先尝试 Base64 智能解码（适配外部 Gmail/Outlook 的 UTF-8 Base64 转码邮件）
  text = decodeBase64Text(text)
  // 2. 尝试 Quoted-Printable 解码
  if (/=[0-9A-Fa-f]{2}/.test(text) || /=\r?\n/.test(text)) {
    text = decodeQuotedPrintable(text)
  }
  text = text.replace(/--[a-zA-Z0-9_\-=]+--?\s*$/g, '').trim()
  return text
}

/** 移除字符串中的所有 Emoji 彩色表情符号，保证临床科研工作站专业严谨的视觉体系 */
export function stripEmojis(str: string): string {
  if (!str) return ''
  return str
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B50}-\u{2B55}\u{FE00}-\u{FE0F}]/gu, '')
    .trim()
}

function formatSenderDisplay(senderName?: string, sender?: string): string {
  const cleanSender = (sender || '').trim()
  const rawName = (senderName || '').trim()
  const decodedName = decodeMimeWords(rawName)
  if (!decodedName || decodedName.toLowerCase() === cleanSender.toLowerCase()) {
    return cleanSender
  }
  return `${decodedName} <${cleanSender}>`
}

export function extractPureEmail(str?: string): string {
  if (!str) return ''
  const m = str.match(/<([^>]+)>/)
  if (m && m[1]) return m[1].trim()
  return str.trim()
}

export function normalizeSubject(sub?: string): string {
  const decoded = decodeMimeWords(sub || '')
  return decoded.replace(/^(?:(?:\s*(?:re|fwd|fw|回复|转发)[：:]\s*)+)/i, '').trim()
}

export function getAvatarInitial(nameOrEmail?: string): string {
  if (!nameOrEmail) return 'M'
  const clean = nameOrEmail.replace(/<[^>]+>/g, '').trim()
  const first = clean[0] || 'M'
  return first.toUpperCase()
}

export function formatTimeShort(dateStr?: string): string {
  if (!dateStr) return ''
  const clean = dateStr.replace('T', ' ').replace(/\.\d+Z$/, '')
  return clean.length >= 16 ? clean.slice(5, 16) : clean
}

export function snippetText(str?: string, max = 80): string {
  if (!str) return ''
  const clean = str.replace(/[\r\n\t]+/g, ' ').replace(/>+[^\n]*/g, '').trim()
  return clean.length > max ? clean.slice(0, max) + '...' : clean
}

export function generateThreadQuote(msg: MailMessage): string {
  const dateStr = msg.created_at || '近期'
  const senderStr = formatSenderDisplay(msg.sender_name, msg.sender)
  const bodyText = (msg.body || '').split('\n').map(l => `> ${l}`).join('\n')
  return `\n\n------------------ 原始邮件 ------------------\n发件人: ${senderStr}\n发送时间: ${dateStr}\n收件人: ${msg.recipient}\n主题: ${decodeMimeWords(msg.subject)}\n\n${bodyText}`
}

/**
 * 格式化邮件正文为具有临床科研专业排版的 HTML
 */
function formatEmailBody(raw: string): string {
  if (!raw) return ''
  const decoded = decodeEmailBody(raw)
  const lines = decoded.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push('<div class="mail-p-gap"></div>')
      continue
    }

    if (trimmed.startsWith('【') && trimmed.endsWith('】')) {
      out.push(`<h4 class="mail-section-title">${esc(trimmed)}</h4>`)
    } else if (trimmed.startsWith('# ')) {
      out.push(`<h3 class="mail-h1">${esc(trimmed.slice(2))}</h3>`)
    } else if (trimmed.startsWith('## ')) {
      out.push(`<h4 class="mail-h2">${esc(trimmed.slice(3))}</h4>`)
    } else if (trimmed.startsWith('### ')) {
      out.push(`<h4 class="mail-h3">${esc(trimmed.slice(4))}</h4>`)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
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
  res = res.replace(/(PT-[A-Z0-9-]+)/g, '<span class="mail-hl-code">$1</span>')
  res = res.replace(/(BAR\s*=\s*[0-9.]+)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(HAM\s*=\s*[0-9.]+\s*cm³)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(SMD\s*&lt;\s*0\.05)/g, '<span class="mail-hl-metric">$1</span>')
  res = res.replace(/(\*\*(.*?)\*\*)/g, '<strong>$2</strong>')
  return res
}

function renderBriefingTableBlock(tableLines: string[]): string {
  const rows = tableLines.map(line => {
    const cells = line.split('|')
    if (cells.length > 2) {
      return cells.slice(1, -1).map(c => stripEmojis(c.trim()))
    }
    return [stripEmojis(line.trim())]
  })

  if (rows.length < 2) {
    return rows.map(r => `<p class="mail-briefing-p">${formatBriefingInline(r.join(' '))}</p>`).join('')
  }

  const headers = rows[0]!
  const isSeparator = rows[1]!.every(c => /^:?-+:?$/.test(c))
  const dataRows = isSeparator ? rows.slice(2) : rows.slice(1)

  // 1. 如果表格包含结构化实体代号（如患者、课题、项目），优先在窄侧边栏渲染为精致卡片列表
  const hasEntityCol = headers.some(h => /代号|患者|课题|项目|编号|ID/i.test(h))
  if (hasEntityCol && dataRows.length > 0) {
    const cardHtml = dataRows.map(row => {
      const titleVal = row[0] || '详情'
      const otherFields = row.slice(1)
      const otherHeaders = headers.slice(1)

      const fieldsHtml = otherFields.map((val, idx) => {
        const label = otherHeaders[idx] || '内容'
        const isAction = /建议|待办|处置|行动|门诊|复查/.test(label)
        return `
          <div class="mail-briefing-record-field ${isAction ? 'action' : ''}">
            <span class="record-k">${esc(label)}：</span>
            <span class="record-v">${formatBriefingInline(val)}</span>
          </div>
        `
      }).join('')

      return `
        <div class="mail-briefing-record-card">
          <div class="mail-briefing-record-head">
            <span class="mail-briefing-record-title">${formatBriefingInline(titleVal)}</span>
          </div>
          <div class="mail-briefing-record-fields">${fieldsHtml}</div>
        </div>
      `
    }).join('')

    return `<div class="mail-briefing-record-list">${cardHtml}</div>`
  }

  // 2. 通用 Markdown 表格渲染
  return `
    <div class="mail-briefing-table-wrap">
      <table class="mail-briefing-table">
        <thead>
          <tr>
            ${headers.map(h => `<th>${esc(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${dataRows.map(row => `
            <tr>
              ${row.map(cell => `<td>${formatBriefingInline(cell)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
}

function formatBriefingMarkdown(raw: string): string {
  if (!raw) return ''
  const decoded = decodeEmailBody(raw)
  const lines = decoded.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) {
      out.push('<div class="mail-briefing-gap"></div>')
      continue
    }

    // 探测并解析 Markdown 表格
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        tableLines.push(lines[i]!.trim())
        i++
      }
      i--
      out.push(renderBriefingTableBlock(tableLines))
      continue
    }

    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      const headingRaw = trimmed.replace(/^#+\s*/, '')
      const cleanHeading = stripEmojis(headingRaw)

      // 忽略多余的顶层文档大标题（如「主诊医师 48h 邮件摘要」），卡片头部已有「AI 动态速报 · 近48h」
      if (/^(?:主诊医师)?(?:近)?(?:48h|48小时)?(?:邮件)?(?:摘要|动态|速报|研判|报告)$/i.test(cleanHeading.replace(/\s+/g, ''))) {
        continue
      }

      let headingIcon = icon('sparkles', { size: 13, class: 'briefing-sec-icon info' })
      let secClass = ''
      if (cleanHeading.includes('随访') || cleanHeading.includes('预警') || cleanHeading.includes('风险') || cleanHeading.includes('急需') || cleanHeading.includes('警示')) {
        headingIcon = icon('warning', { size: 13, class: 'briefing-sec-icon warn' })
        secClass = 'warn'
      } else if (cleanHeading.includes('科研') || cleanHeading.includes('试验') || cleanHeading.includes('课题') || cleanHeading.includes('方案') || cleanHeading.includes('入组')) {
        headingIcon = icon('microscope', { size: 13, class: 'briefing-sec-icon research' })
        secClass = 'research'
      } else if (cleanHeading.includes('行动') || cleanHeading.includes('待办') || cleanHeading.includes('建议') || cleanHeading.includes('处置') || cleanHeading.includes('总结')) {
        headingIcon = icon('report', { size: 13, class: 'briefing-sec-icon action' })
        secClass = 'action'
      }

      out.push(`<div class="mail-briefing-sec-title ${secClass}">
        ${headingIcon}
        <span class="mail-briefing-sec-text">${esc(cleanHeading)}</span>
      </div>`)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const content = stripEmojis(trimmed.slice(2))
      out.push(`<div class="mail-briefing-bullet">
        <span class="mail-briefing-bullet-dot"></span>
        <div class="mail-briefing-bullet-body">${formatBriefingInline(content)}</div>
      </div>`)
    } else if (/^\d+\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\d+)\.\s+(.*)$/)
      if (match) {
        const content = stripEmojis(match[2] || '')
        out.push(`<div class="mail-briefing-bullet">
          <span class="mail-briefing-bullet-num">${match[1]}</span>
          <div class="mail-briefing-bullet-body">${formatBriefingInline(content)}</div>
        </div>`)
      } else {
        out.push(`<p class="mail-briefing-p">${formatBriefingInline(stripEmojis(trimmed))}</p>`)
      }
    } else {
      out.push(`<p class="mail-briefing-p">${formatBriefingInline(stripEmojis(trimmed))}</p>`)
    }
  }

  return out.join('')
}

function formatBriefingInline(text: string): string {
  let s = esc(stripEmojis(text))
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong class="mail-briefing-bold">$1</strong>')
  s = s.replace(/(PT-[A-Z0-9-]+)/g, '<span class="mail-briefing-pill" data-pt-code="$1" title="点击查看患者 $1 全景档案">$1</span>')
  s = s.replace(/((?:RCT|STUDY)-[A-Z0-9-]+)/g, '<span class="mail-briefing-study-pill" data-study-id="$1" title="点击查看科研项目 $1">$1</span>')
  s = s.replace(/(HAM\s*=\s*[0-9.]+\s*cm³?)/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(BAR\s*=\s*[0-9.]+)/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(RECIST\s*1\.[01])/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(SMD\s*&lt;\s*0\.05)/g, '<span class="mail-briefing-metric">$1</span>')
  return s
}

export function initMail(api: Api, notice: Notice, hooks: MailHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let messages: MailMessage[] = []
  let activeFolder: 'inbox' | 'sent' | 'trash' = 'inbox'
  let activeFilter: 'all' | 'unread' | 'starred' | 'followup' | 'research' = 'all'
  let selectedMailId: string | null = null
  let currentUserEmail = 'doctor@heurion.org'
  let mailStatus: MailStatus | null = null

  // 最近 48 小时 AI 邮件摘要状态
  let summaryResult: MailSummaryResult | null = null
  let summaryLoading = false

  // 视图与分页状态
  let mainViewMode: 'list' | 'dashboard' = 'list'
  let currentPage = 1
  let pageSize = 15
  const selectedIds = new Set<string>()

  async function loadStatus(): Promise<void> {
    try {
      mailStatus = await api<MailStatus>('/api/mail/status')
      if (mailStatus?.user_email) {
        let email = mailStatus.user_email.replace(/@heurion\.com$/, '@heurion.org')
        email = email.replace(/^dr[._-]/i, '')
        currentUserEmail = email
      }
    } catch (err) {
      console.error('[mail] failed to load status', err)
    }
  }

  document.addEventListener('heurion:user-updated', ((e: CustomEvent<any>) => {
    if (e.detail?.work_email) {
      currentUserEmail = e.detail.work_email
      if (selectedMailId) {
        const cur = messages.find(x => x.id === selectedMailId)
        if (cur) renderMailDetail(cur)
      } else {
        renderMain()
      }
    }
  }) as EventListener)

  async function loadSummary(force = false): Promise<void> {
    summaryLoading = true
    renderNavSummary()
    try {
      summaryResult = await api<MailSummaryResult>(`/api/mail/summary?hours=48${force ? '&force=true' : ''}`)
    } catch (err) {
      console.error('[mail] failed to load summary', err)
    } finally {
      summaryLoading = false
      renderNavSummary()
    }
  }

  async function loadMessages(): Promise<void> {
    try {
      if (!mailStatus) {
        await loadStatus()
      }
      const params = new URLSearchParams()
      params.set('folder', activeFolder)
      const loaded = await api<MailMessage[]>(`/api/mail/messages?${params.toString()}`)
      messages = (loaded || []).map(m => ({
        ...m,
        subject: decodeMimeWords(m.subject),
        body: decodeEmailBody(m.body),
        sender_name: m.sender_name ? decodeMimeWords(m.sender_name) : m.sender_name,
      }))
      // 清理已不在列表中的选中项
      const currentIds = new Set(messages.map(m => m.id))
      for (const id of Array.from(selectedIds)) {
        if (!currentIds.has(id)) selectedIds.delete(id)
      }
      renderNavSummary()
      renderMain()
    } catch (err) {
      console.error('[mail] failed to load messages', err)
    }
  }

  function getFilteredMessages(): MailMessage[] {
    const searchInput = $('docSearch') as HTMLInputElement | null
    const kw = (searchInput?.value ?? '').trim().toLowerCase()

    return messages.filter(m => {
      if (activeFilter === 'unread' && (m.read || activeFolder !== 'inbox')) return false
      if (activeFilter === 'starred' && !m.starred) return false
      if (activeFilter === 'followup' && m.category !== 'followup') return false
      if (activeFilter === 'research' && m.category !== 'research') return false

      if (!kw) return true
      return (
        m.subject.toLowerCase().includes(kw) ||
        m.sender.toLowerCase().includes(kw) ||
        m.recipient.toLowerCase().includes(kw) ||
        m.body.toLowerCase().includes(kw) ||
        (m.patient_code && m.patient_code.toLowerCase().includes(kw)) ||
        (m.study_id && m.study_id.toLowerCase().includes(kw))
      )
    })
  }

  function renderNavSummary(): void {
    const listEl = $('mailList')
    if (!listEl) return

    if (summaryLoading && !summaryResult) {
      listEl.innerHTML = `
        <li class="mail-briefing-loading-card">
          <div class="mail-briefing-spinner"></div>
          <div class="mail-briefing-loading-title">AI 正在研判最近 48 小时邮件...</div>
          <div class="mail-briefing-loading-desc">DeepSeek 临床大模型正在聚合随访预警与科研进展</div>
        </li>
      `
      return
    }

    const rawTotal = summaryResult ? (summaryResult.total ?? summaryResult.count ?? ((summaryResult as any).items ? (summaryResult as any).items.length : 0)) : 0
    if (!summaryResult || rawTotal === 0) {
      listEl.innerHTML = `
        <li class="mail-briefing-card empty">
          <div class="mail-briefing-head">
            <div class="mail-briefing-head-left">
              <span class="mail-ai-chip">${icon('sparkles', { size: 12 })} AI 动态速报</span>
              <span class="mail-time-pill">近 48h</span>
            </div>
            <button class="mail-refresh-btn ${summaryLoading ? 'loading' : ''}" id="mailRefreshSummaryBtn" title="刷新 AI 摘要">
              ${icon('refresh', { size: 12, class: 'mail-refresh-svg' })}
              <span>${summaryLoading ? '生成中...' : '刷新'}</span>
            </button>
          </div>
          <div class="mail-briefing-empty-body">
            <div class="mail-briefing-empty-icon">${icon('mail', { size: 28 })}</div>
            <div class="mail-briefing-empty-title">近 48 小时内无新流入邮件</div>
            <div class="mail-briefing-empty-text">新收到的临床随访复查与科研进展邮件将在此处由 AI 自动聚合研判</div>
          </div>
        </li>
      `
      return
    }

    const { hours, total, count, unread, followup_count, research_count, source_mails, items, summary, generated_at } = summaryResult as any
    const totalCount = total ?? count ?? (items ? items.length : 0)
    const unreadCount = unread ?? 0
    const followupCount = followup_count ?? 0
    const researchCount = research_count ?? 0
    const sourceMails = source_mails || items || []

    listEl.innerHTML = `
      <li class="mail-briefing-card">
        <!-- 头部标题栏与刷新 -->
        <div class="mail-briefing-head">
          <div class="mail-briefing-head-left">
            <span class="mail-ai-chip">${icon('sparkles', { size: 12 })} AI 动态速报</span>
            <span class="mail-time-pill">近 ${hours || 48}h</span>
          </div>
          <button class="mail-refresh-btn ${summaryLoading ? 'loading' : ''}" id="mailRefreshSummaryBtn" title="点击由 DeepSeek 重新聚合分析">
            ${icon('refresh', { size: 12, class: 'mail-refresh-svg' })}
            <span>${summaryLoading ? '研判中...' : '刷新'}</span>
          </button>
        </div>

        <!-- 核心计数徽章 (2x2 网格，紧凑专业) -->
        <div class="mail-briefing-stats-row">
          <div class="mail-briefing-stat-pill" title="近48小时共收到邮件">
            <span class="stat-k">收件总计</span>
            <span class="stat-v">${totalCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${unreadCount > 0 ? 'unread' : ''}" title="未读待阅邮件">
            <span class="stat-k">待阅邮件</span>
            <span class="stat-v">${unreadCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${followupCount > 0 ? 'followup' : ''}" title="重点随访预警">
            <span class="stat-k">重点随访</span>
            <span class="stat-v">${followupCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${researchCount > 0 ? 'research' : ''}" title="科研进展通报">
            <span class="stat-k">科研进展</span>
            <span class="stat-v">${researchCount}</span>
          </div>
        </div>

        <!-- AI 研判正文 -->
        <div class="mail-briefing-body">
          ${formatBriefingMarkdown(summary)}
        </div>

        <!-- 底部生成元数据 -->
        <div class="mail-briefing-foot">
          <span>AI 研判 · ${generated_at ? new Date(generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '刚刚'}</span>
          <span class="mail-briefing-ai-tag">DeepSeek Engine</span>
        </div>
      </li>
    `
  }

  // 保持兼容性别名
  const renderNavList = renderNavSummary


  function renderMain(): void {
    const page = $('page')
    if (!page) return
    page.className = 'page mail-page'

    const selectedMail = messages.find(m => m.id === selectedMailId)
    if (selectedMail) {
      renderMailDetail(selectedMail)
    } else if (mainViewMode === 'dashboard') {
      renderMailDashboard()
    } else {
      renderMailListView()
    }

    bindMainEvents()
  }

  /**
   * 现代化临床收件箱表格管理视图 (带批量操作、全选、标星、分页)
   */
  function renderMailListView(): void {
    const page = $('page')
    const filtered = getFilteredMessages()
    const totalItems = filtered.length
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    if (currentPage > totalPages) currentPage = totalPages
    if (currentPage < 1) currentPage = 1

    const startIdx = (currentPage - 1) * pageSize
    const pageItems = filtered.slice(startIdx, startIdx + pageSize)

    const allPageSelected = pageItems.length > 0 && pageItems.every(m => selectedIds.has(m.id))
    const hasSelection = selectedIds.size > 0

    const unreadCount = messages.filter(m => !m.read && m.folder !== 'sent' && m.folder !== 'trash').length
    const starredCount = messages.filter(m => m.starred).length
    const isSent = activeFolder === 'sent'
    const isTrash = activeFolder === 'trash'

    const folderTitle = isSent ? '已发送邮件 (Sent)' : isTrash ? '废纸篓 (Trash)' : '收件箱 (Inbox)'

    page.innerHTML = `
      <div class="mail-list-view">
        <!-- 顶部信息与快速操作条 -->
        <div class="mail-list-topbar">
          <div class="mail-list-title-group">
            <div class="mail-title-icon">${icon('mail', { size: 24 })}</div>
            <div>
              <h1 class="mail-main-heading">${folderTitle}</h1>
              <div class="mail-subheading">
                <span>医生专属接收信箱：<strong id="copyMailAddress" class="mail-copyable" title="点击复制">${esc(currentUserEmail)}</strong></span>
                <span class="mail-sep">·</span>
                <span>共 <strong>${totalItems}</strong> 封邮件</span>
                ${unreadCount > 0 ? `<span class="mail-sep">·</span><span class="mail-unread-alert">${unreadCount} 封未读待阅</span>` : ''}
              </div>
            </div>
          </div>

          <div class="mail-top-actions">
            <button class="mail-btn ghost icon-text" id="mailRefreshBtn" title="从服务器重新获取最新邮件与状态">
              ${icon('refresh', { size: 14 })} 刷新收取
            </button>
            <div class="cal-btn-group">
              <button class="cal-btn ${mainViewMode === 'list' ? 'active' : ''}" id="mailViewListBtn">邮件列表</button>
              <button class="cal-btn ${mainViewMode === 'dashboard' ? 'active' : ''}" id="mailViewDashBtn">统计看板</button>
            </div>
            <button class="mail-btn primary" id="mailComposeActionBtn">${icon('write', { size: 14 })} 写邮件</button>
          </div>
        </div>

        <!-- 文件夹切换标签 -->
        <div class="mail-folder-bar">
          <div class="mail-folder-tabs">
            <button class="mail-folder-tab ${activeFolder === 'inbox' ? 'active' : ''}" data-folder="inbox">
              ${icon('mail', { size: 14 })} 收件箱 ${unreadCount > 0 ? `<span class="mail-tab-count">${unreadCount}</span>` : ''}
            </button>
            <button class="mail-folder-tab ${activeFolder === 'sent' ? 'active' : ''}" data-folder="sent">
              ${icon('send', { size: 14 })} 已发送
            </button>
            <button class="mail-folder-tab ${activeFolder === 'trash' ? 'active' : ''}" data-folder="trash">
              ${icon('trash', { size: 14 })} 废纸篓
            </button>
          </div>

          <!-- 快速分类与过滤筛选 -->
          <div class="mail-filter-pills">
            <button class="mail-filter-chip ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">全部</button>
            ${!isSent && !isTrash ? `<button class="mail-filter-chip ${activeFilter === 'unread' ? 'active' : ''}" data-filter="unread">未读 (${unreadCount})</button>` : ''}
            <button class="mail-filter-chip ${activeFilter === 'starred' ? 'active' : ''}" data-filter="starred">${icon('star', { size: 12, class: 'mail-star-icon-filled' })} 星标 (${starredCount})</button>
            <button class="mail-filter-chip ${activeFilter === 'followup' ? 'active' : ''}" data-filter="followup">随访通知</button>
            <button class="mail-filter-chip ${activeFilter === 'research' ? 'active' : ''}" data-filter="research">科研进展</button>
          </div>
        </div>

        <!-- 批量操作工具条 (当有勾选时高亮吸顶显示) -->
        <div class="mail-batch-bar ${hasSelection ? 'visible' : ''}">
          <div class="mail-batch-left">
            <label class="mail-checkbox-wrap">
              <input type="checkbox" id="mailSelectAllPage" ${allPageSelected ? 'checked' : ''} />
              <span class="mail-checkbox-label">全选本页 (${pageItems.length} 封)</span>
            </label>
            <span class="mail-batch-selected-count">已选择 <strong>${selectedIds.size}</strong> 封邮件</span>
          </div>
          <div class="mail-batch-actions">
            ${activeFolder !== 'sent' ? `
              <button class="mail-btn ghost sm" id="batchMarkReadBtn">
                ${icon('check', { size: 13 })} 标为已读
              </button>
              <button class="mail-btn ghost sm" id="batchMarkUnreadBtn">${icon('mail', { size: 13 })} 标为未读</button>
            ` : ''}
            <button class="mail-btn ghost sm" id="batchStarBtn">${icon('star', { size: 13, class: 'mail-star-icon-filled' })} 标星</button>
            <button class="mail-btn ghost sm" id="batchUnstarBtn">${icon('star', { size: 13 })} 取消星标</button>
            ${isTrash ? `
              <button class="mail-btn ghost sm ok" id="batchRestoreBtn">${icon('refresh', { size: 13 })} 恢复至收件箱</button>
              <button class="mail-btn ghost sm danger" id="batchDeletePermanentBtn">${icon('trash', { size: 13 })} 彻底删除</button>
            ` : `
              <button class="mail-btn ghost sm danger" id="batchMoveTrashBtn">
                ${icon('trash', { size: 13 })} 移入废纸篓
              </button>
            `}
            <button class="mail-btn ghost sm" id="batchClearSelection">取消选择</button>
          </div>
        </div>

        <!-- 邮件列表表格区 -->
        <div class="mail-table-container">
          ${pageItems.length === 0 ? `
            <div class="mail-empty-state">
              <div class="mail-empty-icon">${icon('mail', { size: 36 })}</div>
              <h3>${isTrash ? '废纸篓为空' : isSent ? '已发送邮件箱为空' : '暂无匹配邮件'}</h3>
              <p class="muted">当前分类或搜索条件下没有找到任何邮件</p>
            </div>
          ` : `
            <div class="mail-rows-list">
              ${pageItems.map(m => {
                const isUnread = !m.read && activeFolder === 'inbox'
                const isStarred = Boolean(m.starred)
                const isChecked = selectedIds.has(m.id)
                const catClass = `cat-${m.category}`
                const party = isSent ? `至: ${m.recipient}` : formatSenderDisplay(m.sender_name, m.sender)
                const snippet = m.body.slice(0, 64).replace(/\n/g, ' ')

                return `
                  <div class="mail-row ${isUnread ? 'unread' : ''} ${isChecked ? 'checked' : ''}" data-mail-id="${m.id}">
                    <div class="mail-row-check" onclick="event.stopPropagation()">
                      <input type="checkbox" class="mail-item-checkbox" data-id="${m.id}" ${isChecked ? 'checked' : ''} />
                    </div>
                    <button class="mail-row-star ${isStarred ? 'starred' : ''}" data-star-id="${m.id}" title="${isStarred ? '取消星标' : '标记星标'}" onclick="event.stopPropagation()">
                      ${icon('star', { size: 14, class: isStarred ? 'mail-star-icon-filled' : 'mail-star-icon-outline' })}
                    </button>
                    <div class="mail-row-sender" title="${esc(party)}">${esc(party)}</div>
                    <div class="mail-row-body-info">
                      <div class="mail-row-badges">
                        <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
                        ${renderDeliveryPill(m.delivery_status)}
                        ${m.patient_code ? `<span class="mail-nav-tag tag-pt">${esc(m.patient_code)}</span>` : ''}
                        ${m.study_id ? `<span class="mail-nav-tag tag-st">${esc(m.study_id)}</span>` : ''}
                      </div>
                      <div class="mail-row-subject">
                        ${isUnread ? '<span class="mail-unread-dot" title="未读"></span>' : ''}
                        <span class="mail-subject-title">${esc(m.subject)}</span>
                        <span class="mail-subject-snippet">— ${esc(snippet)}</span>
                      </div>
                    </div>
                    <div class="mail-row-right">
                      <span class="mail-row-time">${m.created_at.slice(5, 16)}</span>
                      <div class="mail-row-hover-actions" onclick="event.stopPropagation()">
                        ${!isSent ? `
                          <button class="mail-hover-btn" data-toggle-read="${m.id}" title="${isUnread ? '标为已读' : '标为未读'}">
                            ${isUnread ? icon('check', { size: 13 }) : icon('mail', { size: 13 })}
                          </button>
                        ` : ''}
                        <button class="mail-hover-btn" data-add-cal="${m.id}" title="加入日历排期">
                          ${icon('calendar', { size: 13 })}
                        </button>
                        <button class="mail-hover-btn danger" data-del-mail="${m.id}" title="${isTrash ? '彻底删除' : '移入废纸篓'}">
                          ${icon('trash', { size: 13 })}
                        </button>
                      </div>
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          `}
        </div>

        <!-- 完备分页控制栏 (Paging Bar) -->
        <div class="mail-paging-bar">
          <div class="mail-paging-info">
            显示 <strong>${totalItems === 0 ? 0 : startIdx + 1}</strong> - <strong>${Math.min(startIdx + pageSize, totalItems)}</strong> 条 / 共 <strong>${totalItems}</strong> 封邮件
          </div>
          <div class="mail-paging-controls">
            <div class="mail-page-size-wrap">
              <span class="muted">每页</span>
              <select id="mailPageSizeSelect" class="mail-select-sm">
                <option value="15" ${pageSize === 15 ? 'selected' : ''}>15 条</option>
                <option value="30" ${pageSize === 30 ? 'selected' : ''}>30 条</option>
                <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条</option>
              </select>
            </div>
            <div class="mail-page-btn-group">
              <button class="mail-btn ghost sm" id="mailFirstPage" ${currentPage <= 1 ? 'disabled' : ''}>« 首页</button>
              <button class="mail-btn ghost sm" id="mailPrevPage" ${currentPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
              <span class="mail-page-indicator">第 <strong>${currentPage}</strong> / ${totalPages} 页</span>
              <button class="mail-btn ghost sm" id="mailNextPage" ${currentPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
              <button class="mail-btn ghost sm" id="mailLastPage" ${currentPage >= totalPages ? 'disabled' : ''}>末页 »</button>
            </div>
          </div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `
  }

  function renderMailDashboard(): void {
    const unreadCount = messages.filter(m => !m.read && m.folder !== 'sent' && m.folder !== 'trash').length
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
          <div class="mail-dash-hero-right">
            <div class="mail-doctor-badge">
              <span class="mail-doc-label">当前医生专属邮箱</span>
              <span class="mail-doc-address" id="copyMailAddress" title="点击复制邮箱地址">
                ${esc(currentUserEmail)}
                <span class="mail-copy-icon">${icon('copy', { size: 13 })}</span>
              </span>
            </div>
            <div class="mail-dash-nav-btns">
              <button class="mail-btn primary" id="mailEnterListBtn">进入邮件管理列表 →</button>
            </div>
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
  }

  function renderMailDetail(m: MailMessage): void {
    const page = $('page')
    const catClass = `cat-${m.category}`
    const isUnread = !m.read && activeFolder === 'inbox'
    const isSent = m.folder === 'sent' || activeFolder === 'sent'
    const isTrash = m.folder === 'trash' || activeFolder === 'trash'
    const isStarred = Boolean(m.starred)

    // 计算上一封/下一封
    const filtered = getFilteredMessages()
    const currentIdx = filtered.findIndex(x => x.id === m.id)
    const prevMail = currentIdx > 0 ? filtered[currentIdx - 1] : null
    const nextMail = currentIdx >= 0 && currentIdx < filtered.length - 1 ? filtered[currentIdx + 1] : null

    // 会话流列表 (Gmail Threads)
    let threadMessages: MailMessage[] = (m.thread && m.thread.length > 0) ? [...m.thread] : [m]

    // 默认展开的邮件 ID 集合（当前查看的邮件和最新一封邮件默认展开，其余折叠）
    const expandedIds = new Set<string>()
    expandedIds.add(m.id)
    if (threadMessages.length > 0) {
      expandedIds.add(threadMessages[threadMessages.length - 1]!.id)
    }

    let inlineComposerActive = false
    let currentReplyTargetId: string = threadMessages[threadMessages.length - 1]!.id
    let quoteExpanded = false

    const cleanSubject = normalizeSubject(m.subject) || '邮件'
    const displaySubject = decodeMimeWords(m.subject)

    page.innerHTML = `
      <div class="mail-detail-wrap" id="mailDetailWrap">
        <!-- 顶部操作工具栏 (Top Toolbar) -->
        <div class="mail-toolbar">
          <button class="mail-btn ghost" id="mailBackBtn">
            ‹ 返回列表
          </button>
          <div class="mail-toolbar-nav">
            <button class="mail-btn ghost sm icon-only" id="mailPrevDetailBtn" ${!prevMail ? 'disabled' : ''} title="上一封邮件">‹</button>
            <button class="mail-btn ghost sm icon-only" id="mailNextDetailBtn" ${!nextMail ? 'disabled' : ''} title="下一封邮件">›</button>
          </div>
          <span class="grow"></span>

          <!-- Google Email 核心：快捷回复与转发按钮 -->
          <button class="mail-btn ghost" id="mailReplyTopBtn" title="快捷回复最新邮件">
            ${icon('reply', { size: 14 })} 回复
          </button>
          <button class="mail-btn ghost" id="mailForwardTopBtn" title="转发此会话">
            ${icon('forward', { size: 14 })} 转发
          </button>

          <button class="mail-btn ghost" id="mailToggleStar" title="${isStarred ? '取消星标' : '标记星标'}">
            ${icon('star', { size: 14, class: isStarred ? 'mail-star-icon-filled' : '' })} ${isStarred ? '已标星' : '标星'}
          </button>
          ${!isSent && !isTrash ? `<button class="mail-btn ghost" id="mailToggleRead">${isUnread ? icon('check', { size: 14 }) + ' 标为已读' : icon('mail', { size: 14 }) + ' 标为未读'}</button>` : ''}
          <button class="mail-btn ghost" id="mailAddToCal" title="将邮件关联的复查或会议添加到日历">
            ${icon('calendar', { size: 14 })} 添加到日历
          </button>
          ${isTrash ? `
            <button class="mail-btn ghost ok" id="mailRestoreBtn">${icon('refresh', { size: 14 })} 恢复到收件箱</button>
            <button class="mail-btn ghost danger" id="mailDeletePermanentBtn">${icon('trash', { size: 14 })} 彻底删除</button>
          ` : `
            <button class="mail-btn ghost danger" id="mailDelete">${icon('trash', { size: 14 })} 移入废纸篓</button>
          `}
        </div>

        <!-- 邮件会话头部卡片 (Thread Header) -->
        <div class="mail-thread-header-card">
          <div class="mail-header-badge-row">
            <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
            ${renderDeliveryPill(m.delivery_status)}
            ${isStarred ? `<span class="mail-badge cat-general">${icon('star', { size: 11, class: 'mail-star-icon-filled' })} 星标收藏</span>` : ''}
            ${m.patient_code ? `<span class="mail-header-tag tag-pt">${icon('users', { size: 13 })} 患者: ${esc(m.patient_code)}</span>` : ''}
            ${m.study_id ? `<span class="mail-header-tag tag-st">${icon('microscope', { size: 13 })} 课题: ${esc(m.study_id)}</span>` : ''}
            <span class="grow"></span>
            <span class="mail-thread-count-chip" id="mailThreadCountChip" ${threadMessages.length <= 1 ? 'style="display:none;"' : ''}>
              ${threadMessages.length} 封往来会话
            </span>
            <span class="mail-header-time">${m.created_at}</span>
          </div>

          <h1 class="mail-subject-display">${esc(displaySubject)}</h1>

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
        </div>

        <!-- 会话流列表 (Thread Stream) -->
        <div class="mail-thread-stream" id="mailThreadStream"></div>

        <!-- Gmail 风格底部内联快速回复框 -->
        <div class="mail-inline-composer-wrap" id="mailInlineComposerWrap"></div>

        <!-- 底部落款 -->
        <div class="mail-footer-signature">
          <div class="mail-sig-line">Heurion Clinical Intelligence & Research Gateway</div>
          <div class="mail-sig-sub">电子邮箱通知专函 · 统一身份与多中心科研系统 (支持与外部真实邮箱双向流转)</div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `

    const wrap = $('mailDetailWrap')
    const threadStreamEl = $('mailThreadStream')
    const composerWrapEl = $('mailInlineComposerWrap')

    function updateThreadCards(): void {
      if (!threadStreamEl) return

      threadStreamEl.innerHTML = threadMessages.map((msg, idx) => {
        const isExp = expandedIds.has(msg.id)
        const isLast = idx === threadMessages.length - 1
        const avatar = getAvatarInitial(msg.sender_name || msg.sender)
        const pureSender = extractPureEmail(msg.sender)
        const senderDisplay = formatSenderDisplay(msg.sender_name, msg.sender)
        const timeShort = formatTimeShort(msg.created_at)

        if (!isExp) {
          // 折叠摘要行 (Collapsed Summary Card)
          return `
            <div class="mail-thread-msg collapsed" data-msg-id="${esc(msg.id)}">
              <div class="thread-msg-avatar" title="${esc(senderDisplay)}">${avatar}</div>
              <div class="thread-msg-sender" title="${esc(senderDisplay)}">${esc(senderDisplay)}</div>
              <div class="thread-msg-snippet">${esc(snippetText(msg.body, 90))}</div>
              <div class="thread-msg-meta">
                ${renderDeliveryPill(msg.delivery_status)}
                <span class="thread-msg-time">${timeShort}</span>
              </div>
            </div>
          `
        }

        // 展开正文卡片 (Expanded Message Card)
        return `
          <div class="mail-thread-msg expanded" data-msg-id="${esc(msg.id)}">
            <div class="thread-msg-head" data-toggle-msg="${threadMessages.length > 1 ? esc(msg.id) : ''}">
              <div class="thread-msg-avatar lg">${avatar}</div>
              <div class="thread-msg-info">
                <div class="thread-msg-info-top">
                  <span class="thread-msg-author"><b>${esc(senderDisplay)}</b></span>
                  <span class="thread-msg-addr">&lt;${esc(pureSender)}&gt;</span>
                  <span class="grow"></span>
                  <span class="thread-msg-time">${msg.created_at}</span>
                </div>
                <div class="thread-msg-info-sub">
                  <span class="thread-msg-recipient">发送给：${esc(msg.recipient)}</span>
                  ${renderDeliveryPill(msg.delivery_status)}
                </div>
              </div>
              <div class="thread-msg-actions" onclick="event.stopPropagation()">
                <button class="mail-btn ghost sm" data-card-reply="${esc(msg.id)}" title="针对此邮件回复">
                  ${icon('reply', { size: 13 })} 回复
                </button>
                <button class="mail-btn ghost sm" data-card-forward="${esc(msg.id)}" title="转发此邮件">
                  ${icon('forward', { size: 13 })} 转发
                </button>
              </div>
            </div>

            ${(msg.delivery_status || msg.folder === 'sent') ? `
              <div class="mail-delivery-notice ${msg.delivery_status === 'external_sent' || msg.delivery_status === 'delivered' ? 'ok' : msg.delivery_status === 'simulated' ? 'simulated' : 'fail'}">
                <div class="mail-delivery-title">
                  ${msg.delivery_status === 'external_sent' ? `${icon('check', { size: 13, class: 'mail-pill-icon' })} 外网邮件投递成功 (SMTP)` :
                    msg.delivery_status === 'delivered' ? `${icon('check', { size: 13, class: 'mail-pill-icon' })} 站内信件投递成功` :
                    msg.delivery_status === 'simulated' ? `${icon('info', { size: 13, class: 'mail-pill-icon' })} 本地开发模拟（未配置外网发信服务）` :
                    msg.delivery_status === 'failed' ? `${icon('close', { size: 13, class: 'mail-pill-icon' })} 外网发信失败` : '投递状态已记录'}
                </div>
                <div class="mail-delivery-text">
                  ${msg.delivery_note ? esc(msg.delivery_note) : (
                    msg.delivery_status === 'external_sent' ? `已通过外网 SMTP 服务成功推送给收件人 ${esc(msg.recipient)}。` :
                    msg.delivery_status === 'delivered' ? `收件人系院内专邮工作站用户，已投递至其收件箱。` :
                    msg.delivery_status === 'simulated' ? `当前环境未配置 SMTP_HOST / RESEND_API_KEY，系统在本地已模拟记录。如需真正发送至外部邮箱，请在 .env 中配置发信服务。` :
                    '外发状态已记录。'
                  )}
                </div>
              </div>
            ` : ''}

            <div class="mail-body-render">
              ${formatEmailBody(msg.body)}
            </div>
          </div>
        `
      }).join('')
    }

    function updateInlineComposer(): void {
      if (!composerWrapEl) return

      const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
      const myEmail = currentUserEmail.toLowerCase()
      const pureSender = extractPureEmail(targetMsg.sender)
      const pureRecipient = extractPureEmail(targetMsg.recipient)
      const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const replySubject = `Re: ${targetCleanSub || '邮件'}`

      if (!inlineComposerActive) {
        composerWrapEl.innerHTML = `
          <div class="mail-inline-collapsed" id="inlineReplyCollapsedBar">
            <div class="thread-msg-avatar sm">${getAvatarInitial(currentUserEmail)}</div>
            <div class="inline-collapsed-text">点击此处快速回复给 <strong>${esc(replyRecipient)}</strong>...</div>
            <span class="grow"></span>
            <button class="mail-btn ghost sm" id="btnActivateReply">${icon('reply', { size: 13 })} 快速回复</button>
            <button class="mail-btn ghost sm" id="btnActivateForward">${icon('forward', { size: 13 })} 转发</button>
          </div>
        `
        return
      }

      composerWrapEl.innerHTML = `
        <div class="mail-inline-expanded" id="inlineReplyExpandedBox">
          <div class="inline-expanded-header">
            <div class="inline-to-info">
              <span class="inline-to-tag">${icon('reply', { size: 13 })} 回复：</span>
              <span class="mail-recipient-chip">${esc(replyRecipient)}</span>
              <span class="inline-subject-preview">主题：${esc(replySubject)}</span>
            </div>
            <button class="mail-btn ghost sm" id="btnPopoutModal" title="在弹窗中进行全屏编辑">
              ${icon('write', { size: 13 })} 弹窗全屏编辑
            </button>
          </div>

          <textarea id="inlineReplyTextarea" class="inline-reply-textarea" rows="4" placeholder="在此键入回复内容… 支持按 ⌘ + Enter 或 Ctrl + Enter 快捷发送"></textarea>

          <div class="inline-quote-container">
            <button type="button" class="inline-quote-toggle" id="btnToggleQuote">
              ··· ${quoteExpanded ? '收起引用的原文' : '展开引用的原文'}
            </button>
            <div class="inline-quote-body ${quoteExpanded ? '' : 'hidden'}" id="inlineQuoteBody">
              <pre>${esc(generateThreadQuote(targetMsg))}</pre>
            </div>
          </div>

          <div class="inline-expanded-footer">
            <div class="inline-footer-left">
              <button class="mail-btn primary" id="btnSubmitInlineReply">
                ${icon('send', { size: 14 })} 发送回复
              </button>
              <button class="mail-btn ghost" id="btnCancelInline">取消</button>
            </div>
            <div class="inline-footer-right">
              <span class="inline-sender-hint">以 <strong>${esc(currentUserEmail)}</strong> 身份发出</span>
            </div>
          </div>
        </div>
      `
    }

    // 初始渲染
    updateThreadCards()
    updateInlineComposer()

    // 异步加载完整会话流 (Gmail Thread)
    if (!m.thread) {
      void api<MailMessage & { thread?: MailMessage[] }>(`/api/mail/messages/${m.id}`).then(full => {
        if (full && full.thread && full.thread.length > 0) {
          m.thread = full.thread
          if (selectedMailId === m.id) {
            threadMessages = [...full.thread]
            expandedIds.add(threadMessages[threadMessages.length - 1]!.id)
            currentReplyTargetId = threadMessages[threadMessages.length - 1]!.id
            const chip = $('mailThreadCountChip')
            if (chip) {
              chip.textContent = `${threadMessages.length} 封往来会话`
              chip.style.display = threadMessages.length > 1 ? '' : 'none'
            }
            updateThreadCards()
            updateInlineComposer()
          }
        }
      }).catch(err => console.warn('[mail] load thread failed', err))
    }

    function triggerForward(targetMsg: MailMessage): void {
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const forwardSubject = `Fwd: ${targetCleanSub || '邮件'}`
      const forwardBody = `\n\n------------------ 转发邮件 ------------------\n发件人: ${formatSenderDisplay(targetMsg.sender_name, targetMsg.sender)}\n时间: ${targetMsg.created_at}\n收件人: ${targetMsg.recipient}\n主题: ${decodeMimeWords(targetMsg.subject)}\n\n${targetMsg.body}`

      showComposeModal({
        subject: forwardSubject,
        body: forwardBody,
        category: m.category,
        patient_code: m.patient_code || undefined,
        study_id: m.study_id || undefined,
      })
    }

    async function handleInlineReply(): Promise<void> {
      const textarea = $('inlineReplyTextarea') as HTMLTextAreaElement | null
      const content = textarea?.value.trim()
      if (!content) {
        notice('请输入回复内容', true)
        textarea?.focus()
        return
      }

      const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
      const myEmail = currentUserEmail.toLowerCase()
      const pureSender = extractPureEmail(targetMsg.sender)
      const pureRecipient = extractPureEmail(targetMsg.recipient)
      const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const replySubject = `Re: ${targetCleanSub || '邮件'}`

      const submitBtn = $('btnSubmitInlineReply') as HTMLButtonElement | null
      if (submitBtn) {
        submitBtn.disabled = true
        submitBtn.textContent = '发送中…'
      }

      const quoteText = generateThreadQuote(targetMsg)
      const fullBody = `${content}\n${quoteText}`

      try {
        const res = await api<{ id?: string; delivery?: { status?: string; note?: string } }>('/api/mail/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: replyRecipient,
            category: m.category,
            subject: replySubject,
            patient_code: m.patient_code || undefined,
            study_id: m.study_id || undefined,
            thread_id: m.thread_id || m.id,
            in_reply_to: targetMsg.id,
            body: fullBody,
          }),
        })

        if (res?.delivery?.status === 'external_sent') {
          notice('回复已通过外网 SMTP 服务成功发出！')
        } else if (res?.delivery?.status === 'simulated') {
          notice('回复已在本地模拟记录（未配置外网 SMTP）')
        } else if (res?.delivery?.status === 'failed') {
          notice('外发失败：' + (res.delivery.note || '请检查发信配置'), true)
        } else {
          notice('回复已成功发送！')
        }

        const newMsg: MailMessage = {
          id: res?.id || `reply-${Date.now()}`,
          sender: currentUserEmail,
          sender_name: '我',
          recipient: replyRecipient,
          subject: replySubject,
          body: fullBody,
          category: m.category,
          patient_code: m.patient_code,
          study_id: m.study_id,
          read: 1,
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          folder: 'sent',
          delivery_status: (res?.delivery?.status as any) || 'delivered',
          delivery_note: res?.delivery?.note,
          thread_id: m.thread_id || m.id,
          in_reply_to: targetMsg.id,
        }

        threadMessages.push(newMsg)
        if (!m.thread) m.thread = [m]
        m.thread.push(newMsg)
        expandedIds.add(newMsg.id)

        inlineComposerActive = false
        quoteExpanded = false

        const chip = $('mailThreadCountChip')
        if (chip) {
          chip.textContent = `${threadMessages.length} 封往来会话`
          chip.style.display = threadMessages.length > 1 ? '' : 'none'
        }

        updateThreadCards()
        updateInlineComposer()

        setTimeout(() => {
          const newEl = document.querySelector(`[data-msg-id="${newMsg.id}"]`)
          newEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }, 100)

        void loadMessages()
      } catch (err) {
        notice((err as Error).message, true)
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false
          submitBtn.innerHTML = `${icon('send', { size: 14 })} 发送回复`
        }
      }
    }

    // 绑定当前会话详情页内的交互事件
    wrap?.addEventListener('click', e => {
      const target = e.target as HTMLElement

      // 点击折叠消息卡展开
      const collapsedRow = target.closest<HTMLElement>('.mail-thread-msg.collapsed')
      if (collapsedRow) {
        const id = collapsedRow.dataset.msgId
        if (id) {
          expandedIds.add(id)
          updateThreadCards()
        }
        return
      }

      // 点击展开卡头部折叠
      const toggleHead = target.closest<HTMLElement>('[data-toggle-msg]')
      if (toggleHead && !target.closest('button')) {
        const id = toggleHead.dataset.toggleMsg
        if (id && expandedIds.size > 1) {
          expandedIds.delete(id)
          updateThreadCards()
        }
        return
      }

      // 卡片内回复按钮
      const cardReplyBtn = target.closest<HTMLElement>('[data-card-reply]')
      if (cardReplyBtn) {
        currentReplyTargetId = cardReplyBtn.dataset.cardReply || m.id
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        $('mailInlineComposerWrap')?.scrollIntoView({ behavior: 'smooth' })
        return
      }

      // 卡片内转发按钮
      const cardFwdBtn = target.closest<HTMLElement>('[data-card-forward]')
      if (cardFwdBtn) {
        const id = cardFwdBtn.dataset.cardForward
        const fwdMsg = threadMessages.find(x => x.id === id) || m
        triggerForward(fwdMsg)
        return
      }

      // 顶部回复
      if (target.closest('#mailReplyTopBtn')) {
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        $('mailInlineComposerWrap')?.scrollIntoView({ behavior: 'smooth' })
        return
      }

      // 顶部转发
      if (target.closest('#mailForwardTopBtn')) {
        const lastMsg = threadMessages[threadMessages.length - 1] || m
        triggerForward(lastMsg)
        return
      }

      // 底部折叠条激活回复
      if (target.closest('#inlineReplyCollapsedBar') || target.closest('#btnActivateReply')) {
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        return
      }

      // 底部折叠条激活转发
      if (target.closest('#btnActivateForward')) {
        const lastMsg = threadMessages[threadMessages.length - 1] || m
        triggerForward(lastMsg)
        return
      }

      // 弹窗全屏编辑
      if (target.closest('#btnPopoutModal')) {
        const text = ($('inlineReplyTextarea') as HTMLTextAreaElement)?.value || ''
        const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
        const myEmail = currentUserEmail.toLowerCase()
        const pureSender = extractPureEmail(targetMsg.sender)
        const pureRecipient = extractPureEmail(targetMsg.recipient)
        const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
        const quoteText = generateThreadQuote(targetMsg)
        showComposeModal({
          recipient: replyRecipient,
          subject: 'Re: ' + (normalizeSubject(targetMsg.subject) || '邮件'),
          body: text ? `${text}\n${quoteText}` : quoteText,
          category: m.category,
          patient_code: m.patient_code || undefined,
          study_id: m.study_id || undefined,
          thread_id: m.thread_id || m.id,
          in_reply_to: targetMsg.id,
        })
        return
      }

      // 引用折叠切换
      if (target.closest('#btnToggleQuote')) {
        quoteExpanded = !quoteExpanded
        const qb = $('inlineQuoteBody')
        if (qb) qb.classList.toggle('hidden', !quoteExpanded)
        const tbtn = $('btnToggleQuote')
        if (tbtn) tbtn.textContent = `··· ${quoteExpanded ? '收起引用的原文' : '展开引用的原文'}`
        return
      }

      // 取消内联回复
      if (target.closest('#btnCancelInline')) {
        inlineComposerActive = false
        updateInlineComposer()
        return
      }

      // 提交回复
      if (target.closest('#btnSubmitInlineReply')) {
        void handleInlineReply()
        return
      }
    })

    // 快捷键支持：⌘ + Enter 或 Ctrl + Enter 触发回复发送
    wrap?.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const textarea = $('inlineReplyTextarea')
        if (document.activeElement === textarea) {
          e.preventDefault()
          void handleInlineReply()
        }
      }
    })

    // 自动标记已读
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

    // 将会话中所有未读邮件均标为已读
    threadMessages.forEach(msg => {
      if (!msg.read && msg.folder !== 'sent' && msg.id !== m.id) {
        void api(`/api/mail/messages/${msg.id}/read`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read: true }),
        }).catch(() => {})
        msg.read = 1
      }
    })
  }

  function bindMainEvents(): void {
    const page = $('page')

    // 复制医生邮箱
    $('copyMailAddress')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(currentUserEmail)
      notice('已复制医生工作邮箱地址: ' + currentUserEmail)
    })

    // 切换到列表 / 看板
    $('mailViewListBtn')?.addEventListener('click', () => {
      mainViewMode = 'list'
      renderMain()
    })
    $('mailViewDashBtn')?.addEventListener('click', () => {
      mainViewMode = 'dashboard'
      renderMain()
    })
    $('mailEnterListBtn')?.addEventListener('click', () => {
      mainViewMode = 'list'
      renderMain()
    })

    // 刷新按钮
    $('mailRefreshBtn')?.addEventListener('click', async () => {
      notice('正在刷新收件箱...')
      await loadMessages()
      notice('收件箱已刷新！')
    })

    // 撰写邮件
    $('mailComposeActionBtn')?.addEventListener('click', () => showComposeModal())

    // 文件夹切换
    page.querySelectorAll<HTMLButtonElement>('.mail-folder-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const folder = btn.dataset.folder as 'inbox' | 'sent' | 'trash'
        if (folder && activeFolder !== folder) {
          activeFolder = folder
          selectedMailId = null
          selectedIds.clear()
          currentPage = 1
          updateFolderButtons()
          void loadMessages()
        }
      })
    })

    // 过滤药丸点击
    page.querySelectorAll<HTMLButtonElement>('.mail-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = btn.dataset.filter as any
        if (filter) {
          activeFilter = filter
          currentPage = 1
          renderNavList()
          renderMain()
        }
      })
    })

    // 分页数量改变
    const pageSizeSelect = $('mailPageSizeSelect') as HTMLSelectElement | null
    pageSizeSelect?.addEventListener('change', () => {
      pageSize = parseInt(pageSizeSelect.value, 10) || 15
      currentPage = 1
      renderMain()
    })

    // 翻页操作
    $('mailFirstPage')?.addEventListener('click', () => { currentPage = 1; renderMain() })
    $('mailPrevPage')?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderMain() } })
    $('mailNextPage')?.addEventListener('click', () => { currentPage++; renderMain() })
    $('mailLastPage')?.addEventListener('click', () => {
      const filtered = getFilteredMessages()
      currentPage = Math.max(1, Math.ceil(filtered.length / pageSize))
      renderMain()
    })

    // 全选本页复选框
    $('mailSelectAllPage')?.addEventListener('change', e => {
      const checked = (e.target as HTMLInputElement).checked
      const filtered = getFilteredMessages()
      const startIdx = (currentPage - 1) * pageSize
      const pageItems = filtered.slice(startIdx, startIdx + pageSize)
      if (checked) {
        pageItems.forEach(m => selectedIds.add(m.id))
      } else {
        pageItems.forEach(m => selectedIds.delete(m.id))
      }
      renderMain()
    })

    // 单项 Checkbox
    page.querySelectorAll<HTMLInputElement>('.mail-item-checkbox').forEach(chk => {
      chk.addEventListener('change', () => {
        const id = chk.dataset.id
        if (!id) return
        if (chk.checked) selectedIds.add(id)
        else selectedIds.delete(id)
        renderMain()
      })
    })

    // 清空选择
    $('batchClearSelection')?.addEventListener('click', () => {
      selectedIds.clear()
      renderMain()
    })

    // 批量标为已读
    $('batchMarkReadBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', ids }),
      })
      messages.forEach(m => { if (selectedIds.has(m.id)) m.read = 1 })
      notice(`已将 ${ids.length} 封邮件标记为已读`)
      selectedIds.clear()
      renderNavList()
      renderMain()
    })

    // 批量标为未读
    $('batchMarkUnreadBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unread', ids }),
      })
      messages.forEach(m => { if (selectedIds.has(m.id)) m.read = 0 })
      notice(`已将 ${ids.length} 封邮件标记为未读`)
      selectedIds.clear()
      renderNavList()
      renderMain()
    })

    // 批量标星
    $('batchStarBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'star', ids }),
      })
      messages.forEach(m => { if (selectedIds.has(m.id)) m.starred = 1 })
      notice(`已为 ${ids.length} 封邮件添加星标`)
      selectedIds.clear()
      renderNavList()
      renderMain()
    })

    // 批量取消星标
    $('batchUnstarBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unstar', ids }),
      })
      messages.forEach(m => { if (selectedIds.has(m.id)) m.starred = 0 })
      notice(`已取消 ${ids.length} 封邮件的星标`)
      selectedIds.clear()
      renderNavList()
      renderMain()
    })

    // 批量移入废纸篓
    $('batchMoveTrashBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      const ok = await askConfirm({
        title: '移入废纸篓',
        message: `确定要将选中的 ${ids.length} 封邮件移入废纸篓吗？`,
        confirm: '确认移入',
        danger: true,
      })
      if (!ok) return
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trash', ids }),
      })
      notice(`已将 ${ids.length} 封邮件移入废纸篓`)
      selectedIds.clear()
      await loadMessages()
    })

    // 批量恢复
    $('batchRestoreBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', ids }),
      })
      notice(`已恢复 ${ids.length} 封邮件至收件箱`)
      selectedIds.clear()
      await loadMessages()
    })

    // 批量彻底删除
    $('batchDeletePermanentBtn')?.addEventListener('click', async () => {
      if (selectedIds.size === 0) return
      const ids = Array.from(selectedIds)
      const ok = await askConfirm({
        title: '彻底永久删除',
        message: `彻底删除后这 ${ids.length} 封邮件将无法恢复，确定彻底删除吗？`,
        confirm: '彻底删除',
        danger: true,
      })
      if (!ok) return
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ids }),
      })
      notice(`已彻底删除 ${ids.length} 封邮件`)
      selectedIds.clear()
      await loadMessages()
    })

    // 返回列表
    $('mailBackBtn')?.addEventListener('click', () => {
      selectedMailId = null
      renderNavList()
      renderMain()
    })

    // 详情页：上一封/下一封
    $('mailPrevDetailBtn')?.addEventListener('click', () => {
      const filtered = getFilteredMessages()
      const currentIdx = filtered.findIndex(x => x.id === selectedMailId)
      if (currentIdx > 0 && filtered[currentIdx - 1]) {
        selectedMailId = filtered[currentIdx - 1]!.id
        renderNavList()
        renderMain()
      }
    })
    $('mailNextDetailBtn')?.addEventListener('click', () => {
      const filtered = getFilteredMessages()
      const currentIdx = filtered.findIndex(x => x.id === selectedMailId)
      if (currentIdx >= 0 && currentIdx < filtered.length - 1 && filtered[currentIdx + 1]) {
        selectedMailId = filtered[currentIdx + 1]!.id
        renderNavList()
        renderMain()
      }
    })

    // 详情页：星标切换
    $('mailToggleStar')?.addEventListener('click', async () => {
      if (!selectedMailId) return
      const mail = messages.find(x => x.id === selectedMailId)
      if (!mail) return
      const newStar = !mail.starred
      await api(`/api/mail/messages/${mail.id}/star`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred: newStar }),
      })
      mail.starred = newStar ? 1 : 0
      notice(newStar ? '已为邮件添加星标' : '已取消星标')
      renderNavList()
      renderMain()
    })

    // 详情页：恢复到收件箱
    $('mailRestoreBtn')?.addEventListener('click', async () => {
      if (!selectedMailId) return
      await api('/api/mail/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', ids: [selectedMailId] }),
      })
      notice('邮件已恢复至收件箱')
      selectedMailId = null
      await loadMessages()
    })

    // 详情页：彻底删除
    $('mailDeletePermanentBtn')?.addEventListener('click', async () => {
      if (!selectedMailId) return
      const ok = await askConfirm({
        title: '彻底永久删除邮件',
        message: '彻底删除后此邮件将无法找回，确认永久删除吗？',
        confirm: '永久删除',
        danger: true,
      })
      if (ok) {
        await api(`/api/mail/messages/${selectedMailId}`, { method: 'DELETE' })
        notice('邮件已彻底删除')
        selectedMailId = null
        await loadMessages()
      }
    })

    // 事件委托：行点击、快速操作
    page.addEventListener('click', async e => {
      const target = e.target as HTMLElement

      // 点击行进入详情（排除复选框、按钮）
      const row = target.closest<HTMLElement>('.mail-row')
      if (row && !target.closest('button') && !target.closest('input')) {
        const id = row.dataset.mailId
        if (id) {
          selectedMailId = id
          renderNavList()
          renderMain()
        }
        return
      }

      // 星标切换点击
      const starBtn = target.closest<HTMLElement>('[data-star-id]')
      if (starBtn) {
        const id = starBtn.dataset.starId!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          const nextStar = !mail.starred
          await api(`/api/mail/messages/${id}/star`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ starred: nextStar }),
          })
          mail.starred = nextStar ? 1 : 0
          renderNavList()
          renderMain()
        }
        return
      }

      // 行内：已读/未读切换
      const readToggle = target.closest<HTMLElement>('[data-toggle-read]')
      if (readToggle) {
        const id = readToggle.dataset.toggleRead!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          const nextRead = !mail.read
          await api(`/api/mail/messages/${id}/read`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: nextRead }),
          })
          mail.read = nextRead ? 1 : 0
          notice(nextRead ? '已标为已读' : '已标为未读')
          renderNavList()
          renderMain()
        }
        return
      }

      // 行内：添加到日历
      const addCalBtn = target.closest<HTMLElement>('[data-add-cal]')
      if (addCalBtn) {
        const id = addCalBtn.dataset.addCal!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          await addEmailToCalendar(mail)
        }
        return
      }

      // 行内：删除 / 移入废纸篓
      const delMailBtn = target.closest<HTMLElement>('[data-del-mail]')
      if (delMailBtn) {
        const id = delMailBtn.dataset.delMail!
        if (activeFolder === 'trash') {
          const ok = await askConfirm({
            title: '永久删除邮件',
            message: '确定要彻底删除该邮件吗？',
            confirm: '永久删除',
            danger: true,
          })
          if (ok) {
            await api(`/api/mail/messages/${id}`, { method: 'DELETE' })
            notice('邮件已永久删除')
            await loadMessages()
          }
        } else {
          await api('/api/mail/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trash', ids: [id] }),
          })
          notice('已移入废纸篓')
          await loadMessages()
        }
        return
      }

      // 患者跳转
      const ptJump = target.closest<HTMLElement>('#mailJumpPatient')
      if (ptJump && hooks.openPatient) {
        const code = ptJump.dataset.code!
        await hooks.openPatient(code)
        return
      }

      // 课题跳转
      const stJump = target.closest<HTMLElement>('#mailJumpStudy')
      if (stJump && hooks.openStudy) {
        const study = stJump.dataset.study!
        await hooks.openStudy(study)
        return
      }

      // 添加到日历（详情页）
      const calBtn = target.closest<HTMLElement>('#mailAddToCal')
      if (calBtn && selectedMailId) {
        const mail = messages.find(x => x.id === selectedMailId)
        if (mail) {
          await addEmailToCalendar(mail)
        }
        return
      }

      // 已读切换（详情页）
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

      // 详情页：移入废纸篓
      const delBtn = target.closest<HTMLElement>('#mailDelete')
      if (delBtn && selectedMailId) {
        const ok = await askConfirm({
          title: '移入废纸篓',
          message: '确定要将此邮件移入废纸篓吗？',
          confirm: '移入废纸篓',
          danger: true,
        })
        if (ok) {
          await api('/api/mail/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trash', ids: [selectedMailId] }),
          })
          notice('邮件已移入废纸篓')
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
          title: `【${CATEGORY_NAMES[mail.category] || '事项'}】${mail.subject}`,
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

  function showComposeModal(initial?: ComposeInitial): void {
    const anchor = $('mailModalAnchor')
    if (!anchor) return

    const initialCat = initial?.category || 'followup'

    anchor.innerHTML = `
      <div class="mail-modal-scrim" id="mailComposeScrim">
        <div class="mail-modal-card compose-card" role="dialog" aria-modal="true">
          <div class="mail-modal-head">
            <h2>${initial?.in_reply_to ? icon('reply', { size: 16 }) + ' 回复专邮' : initial?.subject?.startsWith('Fwd:') ? icon('forward', { size: 16 }) + ' 转发专邮' : icon('write', { size: 16 }) + ' 起草并发送医疗通知专邮'}</h2>
            <button class="mail-modal-close" id="mailComposeClose" aria-label="关闭">${icon('close', { size: 16 })}</button>
          </div>
          <div class="mail-smtp-status-tip ${mailStatus?.configured ? 'configured' : 'mock'}">
            ${mailStatus?.configured
              ? `<span class="smtp-dot ok"></span> <strong>发信服务已连接 (${mailStatus.mode === 'smtp' ? '标准 SMTP' : 'Resend'})</strong>：支持直接向外部真实邮箱（如 Gmail、网易、QQ 邮箱等）真实发信。`
              : `<span class="smtp-dot warn"></span> <strong>本地开发模拟模式</strong>：当前未配置外网发信服务 (SMTP)。发往外部邮箱时将在本地保留记录并模拟成功。`
            }
          </div>
          <form id="mailComposeForm" class="mail-form">
            <div class="form-row">
              <label>收件人邮箱 (Recipient) *</label>
              <input type="email" id="composeTo" required value="${esc(initial?.recipient || '')}" placeholder="如：patient@gmail.com 或 wang@heurion.org" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>邮件分类</label>
                <select id="composeCategory">
                  <option value="followup" ${initialCat === 'followup' ? 'selected' : ''}>患者随访计划 (Follow-up)</option>
                  <option value="research" ${initialCat === 'research' ? 'selected' : ''}>科研项目进展 (Research)</option>
                  <option value="general" ${initialCat === 'general' ? 'selected' : ''}>临床综合沟通 (General)</option>
                </select>
              </div>
              <div class="form-row">
                <label>发件人身份（站内专属工作信箱）</label>
                <input type="text" disabled value="${esc(currentUserEmail)}" class="disabled-input" title="发信将严格以此专属站内信箱对外发出，确保外部回复自动闭环流转入站" />
              </div>
            </div>

            <div class="form-row">
              <label>邮件主题 (Subject) *</label>
              <input type="text" id="composeSubject" required value="${esc(initial?.subject || '')}" placeholder="如：PT-BRONCHO-001 气道高密度栓塞第12周三维影像随访计划" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>关联患者代号 (可选)</label>
                <input type="text" id="composePtCode" value="${esc(initial?.patient_code || '')}" placeholder="如：PT-BRONCHO-001" />
              </div>
              <div class="form-row">
                <label>关联科研项目 (可选)</label>
                <input type="text" id="composeStudy" value="${esc(initial?.study_id || '')}" placeholder="如：DAPA-HF (NCT03036124)" />
              </div>
            </div>

            <div class="form-row">
              <label>正文内容 (Body) *</label>
              <textarea id="composeBody" rows="8" required placeholder="输入详细随访计划、影像复查指引、临床指标预警或科研推进通知…">${esc(initial?.body || '')}</textarea>
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
            thread_id: initial?.thread_id,
            in_reply_to: initial?.in_reply_to,
            body,
          }),
        })

        if (res?.delivery?.status === 'external_sent') {
          notice('邮件已通过外网发信服务成功发出！')
        } else if (res?.delivery?.status === 'simulated') {
          notice('邮件已保存为已发送（本地模拟记录，未配置外网 SMTP）')
        } else if (res?.delivery?.status === 'failed') {
          notice('外网邮件发送失败：' + (res.delivery.note || '请检查 SMTP 配置'), true)
        } else {
          notice('邮件已成功投递！')
        }

        close()
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
    const btnTrash = $('mailFolderTrash')
    btnInbox?.classList.toggle('on', activeFolder === 'inbox')
    btnSent?.classList.toggle('on', activeFolder === 'sent')
    btnTrash?.classList.toggle('on', activeFolder === 'trash')
  }

  // 绑定左侧栏交互按钮
  function initActionPills(): void {
    const fAll = $('mailFilterAll')
    const fUnread = $('mailFilterUnread')
    const fStarred = $('mailFilterStarred')
    const fFollowup = $('mailFilterFollowup')
    const fResearch = $('mailFilterResearch')
    const composeBtn = $('composeMailBtn')
    const btnInbox = $('mailFolderInbox')
    const btnSent = $('mailFolderSent')
    const btnTrash = $('mailFolderTrash')

    composeBtn?.addEventListener('click', () => showComposeModal())

    btnInbox?.addEventListener('click', () => {
      if (activeFolder !== 'inbox') {
        activeFolder = 'inbox'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        void loadMessages()
      }
    })

    btnSent?.addEventListener('click', () => {
      if (activeFolder !== 'sent') {
        activeFolder = 'sent'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        void loadMessages()
      }
    })

    btnTrash?.addEventListener('click', () => {
      if (activeFolder !== 'trash') {
        activeFolder = 'trash'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        void loadMessages()
      }
    })

    const updatePills = (active: typeof activeFilter) => {
      activeFilter = active
      currentPage = 1
      fAll?.classList.toggle('on', active === 'all')
      fUnread?.classList.toggle('on', active === 'unread')
      fStarred?.classList.toggle('on', active === 'starred')
      fFollowup?.classList.toggle('on', active === 'followup')
      fResearch?.classList.toggle('on', active === 'research')
      renderNavList()
      renderMain()
    }

    fAll?.addEventListener('click', () => updatePills('all'))
    fUnread?.addEventListener('click', () => updatePills('unread'))
    fStarred?.addEventListener('click', () => updatePills('starred'))
    fFollowup?.addEventListener('click', () => updatePills('followup'))
    fResearch?.addEventListener('click', () => updatePills('research'))

    $('docSearch')?.addEventListener('input', () => {
      if (!$('mailList')?.hidden) {
        currentPage = 1
        renderNavList()
        renderMain()
      }
    })

    // 左侧栏条目点击
    $('mailList')?.addEventListener('click', e => {
      const target = e.target as HTMLElement

      // 1. 刷新按钮
      const refreshBtn = target.closest<HTMLElement>('#mailRefreshSummaryBtn')
      if (refreshBtn) {
        e.stopPropagation()
        void loadSummary(true)
        return
      }

      // 2. 患者代号标签点击 -> 直达患者档案
      const ptPill = target.closest<HTMLElement>('.mail-briefing-pill, .mail-source-pt')
      if (ptPill) {
        e.stopPropagation()
        const code = ptPill.dataset.ptCode
        if (code && hooks.openPatient) {
          void hooks.openPatient(code)
        }
        return
      }

      // 3. 课题编号标签点击 -> 直达科研项目
      const stPill = target.closest<HTMLElement>('.mail-briefing-study-pill')
      if (stPill) {
        e.stopPropagation()
        const sid = stPill.dataset.studyId
        if (sid && hooks.openStudy) {
          void hooks.openStudy(sid)
        }
        return
      }

      // 4. 查看右侧全部邮件
      const viewAllBtn = target.closest<HTMLElement>('#mailBriefingViewAllBtn')
      if (viewAllBtn) {
        e.stopPropagation()
        selectedMailId = null
        mainViewMode = 'list'
        renderMain()
        return
      }

      // 5. 关联邮件来源项点击 -> 在右侧主视窗打开该邮件
      const sourceItem = target.closest<HTMLElement>('.mail-briefing-source-item')
      if (sourceItem) {
        const id = sourceItem.dataset.mailId
        if (id) {
          selectedMailId = id
          renderNavSummary()
          renderMain()
        }
        return
      }
    })
  }

  initActionPills()

  return {
    async enter(): Promise<void> {
      hooks.leaveDoc()
      await loadStatus()
      await Promise.all([
        loadMessages(),
        loadSummary(),
      ])
    },
    leave(): void {
      selectedMailId = null
    },
    async openMail(id: string): Promise<void> {
      selectedMailId = id
      await Promise.all([
        loadMessages(),
        loadSummary(),
      ])
    },
    async sendMail(mailData: Partial<MailMessage>): Promise<void> {
      await api('/api/mail/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mailData),
      })
      await Promise.all([
        loadMessages(),
        loadSummary(true),
      ])
    },
  }
}
