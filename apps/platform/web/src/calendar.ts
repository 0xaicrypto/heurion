/**
 * 日历与排期工作空间 (Heurion Clinical & Research Calendar)
 * 
 * 专为临床医生与医学科研工作者设计：
 * 1. 随访复查排期 (Follow-up Plans): 靶向药耐药监测、气道三维容积复查、化疗间歇期评估
 * 2. 临床科研进度 (Research Progress): 方案讨论、伦理提交、PSM倾向评分匹配评审、DSMB独立数据监察会议
 * 3. 深度联动：
 *    - 一键直达患者全景档案 (PT-*) 或临床研究课题 (ST-*)
 *    - 日程创建支持同步通知医生专属 @heurion.com 邮箱
 */

import { icon } from './icons.ts'
import { askConfirm } from './dialogs.ts'

export type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
export type Notice = (msg: string, error?: boolean) => void

export interface CalendarHooks {
  leaveDoc(): void
  openPatient?(idOrCode: string): Promise<void>
  openStudy?(idOrTitle: string): Promise<void>
  openMail?(category?: string): Promise<void>
}

export interface CalendarEvent {
  id: string
  owner: string
  title: string
  start_time: string
  end_time: string
  category: 'followup' | 'research' | 'meeting' | 'general'
  patient_id?: string | null
  patient_code?: string | null
  study_id?: string | null
  study_title?: string | null
  location?: string | null
  notes?: string | null
  status: 'scheduled' | 'completed' | 'cancelled'
  created_at: string
  updated_at: string
}

const CATEGORY_NAMES: Record<string, string> = {
  followup: '患者随访',
  research: '临床科研',
  meeting: '学术研讨',
  general: '综合事务',
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function initCalendar(api: Api, notice: Notice, hooks: CalendarHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let events: CalendarEvent[] = []
  let activeFilter: 'all' | 'followup' | 'research' = 'all'
  let currentYear = new Date().getFullYear()
  let currentMonth = new Date().getMonth() // 0-11
  let selectedEventId: string | null = null
  let viewMode: 'month' | 'agenda' = 'month'

  async function loadEvents(): Promise<void> {
    try {
      const q = activeFilter !== 'all' ? `?category=${activeFilter}` : ''
      events = await api<CalendarEvent[]>(`/api/calendar/events${q}`)
      renderNavList()
      renderMain()
    } catch (err) {
      console.error('[calendar] failed to load events', err)
    }
  }

  function renderNavList(): void {
    const listEl = $('calList')
    if (!listEl) return

    const searchInput = $('docSearch') as HTMLInputElement | null
    const kw = (searchInput?.value ?? '').trim().toLowerCase()

    const filtered = events.filter(ev => {
      if (activeFilter !== 'all' && ev.category !== activeFilter) return false
      if (!kw) return true
      return (
        ev.title.toLowerCase().includes(kw) ||
        (ev.patient_code && ev.patient_code.toLowerCase().includes(kw)) ||
        (ev.study_title && ev.study_title.toLowerCase().includes(kw)) ||
        (ev.location && ev.location.toLowerCase().includes(kw))
      )
    })

    if (filtered.length === 0) {
      listEl.innerHTML = `<li class="doclist-empty"><div class="muted">无日程安排</div></li>`
      return
    }

    listEl.innerHTML = filtered.map(ev => {
      const isDone = ev.status === 'completed'
      const isSel = ev.id === selectedEventId
      const catClass = `cat-${ev.category}`
      const startShort = ev.start_time.slice(5, 16) // MM-DD HH:mm

      return `<li class="docitem cal-nav-item ${isSel ? 'selected' : ''} ${isDone ? 'done' : ''}" data-ev-id="${ev.id}">
        <div class="cal-nav-line">
          <span class="cal-badge ${catClass}">${CATEGORY_NAMES[ev.category] || '日程'}</span>
          <span class="cal-nav-time">${startShort}</span>
        </div>
        <div class="cal-nav-title ${isDone ? 'strikethrough' : ''}">${esc(ev.title)}</div>
        ${ev.patient_code ? `<div class="cal-nav-tag tag-pt">${icon('users', { size: 12 })} ${esc(ev.patient_code)}</div>` : ''}
        ${ev.study_title ? `<div class="cal-nav-tag tag-st">${icon('microscope', { size: 12 })} ${esc(ev.study_title)}</div>` : ''}
      </li>`
    }).join('')
  }

  function renderMain(): void {
    const page = $('page')
    if (!page) return
    page.className = 'page calendar-page'

    const monthStr = `${currentYear} 年 ${currentMonth + 1} 月`

    page.innerHTML = `
      <div class="cal-header">
        <div class="cal-header-left">
          <div class="cal-title-wrap">
            <span class="cal-icon">${icon('calendar', { size: 24 })}</span>
            <h1 class="cal-main-title">临床与科研日程排期</h1>
          </div>
          <p class="cal-subtitle">规划患者随访复查周期、科研项目评审节点与学术研讨会，无缝联动 @heurion.com 邮件通知</p>
        </div>
        <div class="cal-header-actions">
          <button class="cal-btn ghost" id="calTodayBtn">今天</button>
          <div class="cal-btn-group">
            <button class="cal-btn icon-only" id="calPrevMonth" title="上个月">‹</button>
            <span class="cal-current-label">${monthStr}</span>
            <button class="cal-btn icon-only" id="calNextMonth" title="下个月">›</button>
          </div>
          <div class="cal-btn-group">
            <button class="cal-btn ${viewMode === 'month' ? 'active' : ''}" id="calViewMonth">月视图</button>
            <button class="cal-btn ${viewMode === 'agenda' ? 'active' : ''}" id="calViewAgenda">列表</button>
          </div>
          <button class="cal-btn primary" id="calAddEventBtn">＋ 新建排期</button>
        </div>
      </div>

      <div class="cal-body">
        ${viewMode === 'month' ? renderMonthGrid() : renderAgendaView()}
      </div>

      <div id="calEventModalAnchor"></div>
    `

    bindMainEvents()
  }

  function renderMonthGrid(): string {
    const firstDay = new Date(currentYear, currentMonth, 1).getDay() // 0 = Sunday
    // Monday as first column (0 = Mon, ..., 6 = Sun)
    const startOffset = (firstDay + 6) % 7
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate()
    const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate()

    const today = new Date()
    const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth
    const todayDate = today.getDate()

    const weekHeaders = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    let html = `<div class="cal-grid">`

    // Week header
    html += `<div class="cal-grid-header">`
    for (const h of weekHeaders) {
      html += `<div class="cal-grid-col-title">${h}</div>`
    }
    html += `</div>`

    // Days grid
    html += `<div class="cal-grid-cells">`

    // Previous month trailing days
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i
      html += `<div class="cal-day-cell other-month"><div class="cal-day-num">${d}</div></div>`
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const isToday = isCurrentMonth && d === todayDate
      const dayEvents = events.filter(ev => ev.start_time.startsWith(dateStr))

      html += `<div class="cal-day-cell ${isToday ? 'today' : ''}" data-date="${dateStr}">
        <div class="cal-day-cell-top">
          <span class="cal-day-num ${isToday ? 'today-badge' : ''}">${d}</span>
          <button class="cal-day-add" data-add-date="${dateStr}" title="在该日添加排期">＋</button>
        </div>
        <div class="cal-day-events">
          ${dayEvents.map(ev => {
            const timeStr = ev.start_time.slice(11, 16)
            return `<div class="cal-chip cat-${ev.category} ${ev.status === 'completed' ? 'done' : ''}" data-ev-id="${ev.id}" title="${esc(ev.title)}">
              <span class="cal-chip-time">${timeStr}</span>
              <span class="cal-chip-title">${esc(ev.title)}</span>
            </div>`
          }).join('')}
        </div>
      </div>`
    }

    // Trailing days of next month to fill 35 or 42 grid cells
    const totalFilled = startOffset + daysInMonth
    const remaining = (7 - (totalFilled % 7)) % 7
    for (let d = 1; d <= remaining; d++) {
      html += `<div class="cal-day-cell other-month"><div class="cal-day-num">${d}</div></div>`
    }

    html += `</div></div>`
    return html
  }

  function renderAgendaView(): string {
    const sorted = [...events].sort((a, b) => a.start_time.localeCompare(b.start_time))
    if (sorted.length === 0) {
      return `<div class="cal-empty-view">
        <div class="cal-empty-icon">${icon('calendar', { size: 36 })}</div>
        <h3>当前无排期事件</h3>
        <p class="muted">点击右上角「＋ 新建排期」安排患者复查与科研里程碑</p>
      </div>`
    }

    return `<div class="cal-agenda-list">
      ${sorted.map(ev => {
        const catClass = `cat-${ev.category}`
        const isDone = ev.status === 'completed'
        return `<div class="cal-agenda-card ${catClass} ${isDone ? 'done' : ''}" data-ev-id="${ev.id}">
          <div class="cal-agenda-side">
            <span class="cal-agenda-date">${ev.start_time.slice(5, 10)}</span>
            <span class="cal-agenda-time">${ev.start_time.slice(11, 16)} - ${ev.end_time.slice(11, 16)}</span>
            <span class="cal-badge ${catClass}">${CATEGORY_NAMES[ev.category]}</span>
          </div>
          <div class="cal-agenda-content">
            <div class="cal-agenda-title ${isDone ? 'strikethrough' : ''}">${esc(ev.title)}</div>
            ${ev.location ? `<div class="cal-agenda-loc">${icon('hospital', { size: 13 })} ${esc(ev.location)}</div>` : ''}
            ${ev.notes ? `<div class="cal-agenda-notes">${esc(ev.notes)}</div>` : ''}
            <div class="cal-agenda-tags">
              ${ev.patient_code ? `<button class="cal-link-btn pt-btn" data-nav-pt="${esc(ev.patient_code)}">${icon('users', { size: 12 })} 患者 ${esc(ev.patient_code)}</button>` : ''}
              ${ev.study_title ? `<button class="cal-link-btn st-btn" data-nav-st="${esc(ev.study_id || ev.study_title)}">${icon('microscope', { size: 12 })} 课题: ${esc(ev.study_title)}</button>` : ''}
            </div>
          </div>
          <div class="cal-agenda-actions">
            <button class="cal-action-btn" data-toggle-done="${ev.id}" title="${isDone ? '设为未完成' : '设为已完成'}">${isDone ? '恢复待办' : '完成'}</button>
            <button class="cal-action-btn danger" data-del-ev="${ev.id}" title="删除日程">删除</button>
          </div>
        </div>`
      }).join('')}
    </div>`
  }

  function bindMainEvents(): void {
    const page = $('page')

    // Navigation buttons
    $('calPrevMonth')?.addEventListener('click', () => {
      currentMonth--
      if (currentMonth < 0) {
        currentMonth = 11
        currentYear--
      }
      renderMain()
    })

    $('calNextMonth')?.addEventListener('click', () => {
      currentMonth++
      if (currentMonth > 11) {
        currentMonth = 0
        currentYear++
      }
      renderMain()
    })

    $('calTodayBtn')?.addEventListener('click', () => {
      const now = new Date()
      currentYear = now.getFullYear()
      currentMonth = now.getMonth()
      renderMain()
    })

    $('calViewMonth')?.addEventListener('click', () => {
      viewMode = 'month'
      renderMain()
    })

    $('calViewAgenda')?.addEventListener('click', () => {
      viewMode = 'agenda'
      renderMain()
    })

    $('calAddEventBtn')?.addEventListener('click', () => {
      showEventDialog()
    })

    // Delegation on page
    page.addEventListener('click', async e => {
      const target = e.target as HTMLElement

      // Click on event chip or nav item
      const chip = target.closest<HTMLElement>('[data-ev-id]')
      if (chip && !target.closest('button')) {
        const id = chip.dataset.evId
        if (id) {
          selectedEventId = id
          renderNavList()
          showEventDetailModal(id)
        }
        return
      }

      // Add on specific date
      const addBtn = target.closest<HTMLElement>('[data-add-date]')
      if (addBtn) {
        const d = addBtn.dataset.addDate
        showEventDialog(d)
        return
      }

      // Patient navigation
      const ptBtn = target.closest<HTMLElement>('[data-nav-pt]')
      if (ptBtn && hooks.openPatient) {
        const code = ptBtn.dataset.navPt!
        await hooks.openPatient(code)
        return
      }

      // Study navigation
      const stBtn = target.closest<HTMLElement>('[data-nav-st]')
      if (stBtn && hooks.openStudy) {
        const study = stBtn.dataset.navSt!
        await hooks.openStudy(study)
        return
      }

      // Toggle done
      const doneBtn = target.closest<HTMLElement>('[data-toggle-done]')
      if (doneBtn) {
        const id = doneBtn.dataset.toggleDone!
        const ev = events.find(x => x.id === id)
        if (ev) {
          const newStatus = ev.status === 'completed' ? 'scheduled' : 'completed'
          await api(`/api/calendar/events/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus }),
          })
          notice(newStatus === 'completed' ? '日程已标为完成' : '已恢复待办状态')
          await loadEvents()
        }
        return
      }

      // Delete event
      const delBtn = target.closest<HTMLElement>('[data-del-ev]')
      if (delBtn) {
        const id = delBtn.dataset.delEv!
        const ok = await askConfirm({
          title: '删除排期日程',
          message: '确定要删除该日程记录吗？',
          confirm: '确认删除',
          danger: true,
        })
        if (ok) {
          await api(`/api/calendar/events/${id}`, { method: 'DELETE' })
          notice('已删除日程')
          await loadEvents()
        }
      }
    })
  }

  function showEventDetailModal(id: string): void {
    const ev = events.find(x => x.id === id)
    if (!ev) return

    const anchor = $('calEventModalAnchor')
    if (!anchor) return

    const catClass = `cat-${ev.category}`
    const isDone = ev.status === 'completed'

    anchor.innerHTML = `
      <div class="cal-modal-scrim" id="calDetailScrim">
        <div class="cal-modal-card" role="dialog" aria-modal="true">
          <div class="cal-modal-head">
            <div class="cal-modal-head-left">
              <span class="cal-badge ${catClass}">${CATEGORY_NAMES[ev.category]}</span>
              <span class="cal-modal-status ${isDone ? 'done' : 'scheduled'}">${isDone ? '已完成' : '待执行'}</span>
            </div>
            <button class="cal-modal-close" id="calDetailClose">✕</button>
          </div>
          <div class="cal-modal-body">
            <h2 class="cal-detail-title ${isDone ? 'strikethrough' : ''}">${esc(ev.title)}</h2>
            <div class="cal-detail-row">
              <span class="cal-detail-icon">${icon('clock', { size: 15 })}</span>
              <span class="cal-detail-text">${ev.start_time} 至 ${ev.end_time}</span>
            </div>
            ${ev.location ? `
              <div class="cal-detail-row">
                <span class="cal-detail-icon">${icon('hospital', { size: 15 })}</span>
                <span class="cal-detail-text">${esc(ev.location)}</span>
              </div>
            ` : ''}

            ${ev.patient_code ? `
              <div class="cal-detail-box pt-box">
                <div class="cal-box-label">关联临床患者档案</div>
                <div class="cal-box-content">
                  <span class="cal-box-code">${icon('users', { size: 14 })} ${esc(ev.patient_code)}</span>
                  <button class="cal-box-jump-btn" id="calJumpPt" data-code="${esc(ev.patient_code)}">打开患者全景 →</button>
                </div>
              </div>
            ` : ''}

            ${ev.study_title ? `
              <div class="cal-detail-box st-box">
                <div class="cal-box-label">关联临床科研项目</div>
                <div class="cal-box-content">
                  <span class="cal-box-code">${icon('microscope', { size: 14 })} ${esc(ev.study_title)}</span>
                  <button class="cal-box-jump-btn" id="calJumpSt" data-study="${esc(ev.study_id || ev.study_title)}">进入研究项目 →</button>
                </div>
              </div>
            ` : ''}

            ${ev.notes ? `
              <div class="cal-detail-notes">
                <div class="cal-notes-label">排期详情与临床要点：</div>
                <div class="cal-notes-body">${esc(ev.notes)}</div>
              </div>
            ` : ''}

            <div class="cal-mail-synced-hint">
              <span class="cal-mail-icon">${icon('mail', { size: 14 })}</span>
              <span>排期提醒已同步在邮箱列表，随时支持多端跟进</span>
            </div>
          </div>
          <div class="cal-modal-foot">
            <button class="cal-btn ghost danger" id="calDetailDelete">删除日程</button>
            <div class="grow"></div>
            <button class="cal-btn ghost" id="calDetailToggleDone">${isDone ? '恢复为待办' : '标记为已完成'}</button>
          </div>
        </div>
      </div>
    `

    const scrim = $('calDetailScrim')
    const close = () => { scrim?.remove() }
    $('calDetailClose')?.addEventListener('click', close)
    scrim?.addEventListener('click', e => { if (e.target === scrim) close() })

    $('calJumpPt')?.addEventListener('click', async e => {
      const code = (e.currentTarget as HTMLElement).dataset.code!
      close()
      if (hooks.openPatient) await hooks.openPatient(code)
    })

    $('calJumpSt')?.addEventListener('click', async e => {
      const study = (e.currentTarget as HTMLElement).dataset.study!
      close()
      if (hooks.openStudy) await hooks.openStudy(study)
    })

    $('calDetailToggleDone')?.addEventListener('click', async () => {
      const newStatus = isDone ? 'scheduled' : 'completed'
      await api(`/api/calendar/events/${ev.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      notice(newStatus === 'completed' ? '已标记为完成' : '已恢复待办')
      close()
      await loadEvents()
    })

    $('calDetailDelete')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: '删除排期',
        message: '确定要删除这条日程记录吗？',
        confirm: '确认删除',
        danger: true,
      })
      if (ok) {
        await api(`/api/calendar/events/${ev.id}`, { method: 'DELETE' })
        notice('已删除日程')
        close()
        await loadEvents()
      }
    })
  }

  function showEventDialog(prefilledDate?: string): void {
    const anchor = $('calEventModalAnchor')
    if (!anchor) return

    const defaultDate = prefilledDate || new Date().toISOString().slice(0, 10)
    const startTimeDefault = `${defaultDate} 09:30`
    const endTimeDefault = `${defaultDate} 11:30`

    anchor.innerHTML = `
      <div class="cal-modal-scrim" id="calFormScrim">
        <div class="cal-modal-card form-card" role="dialog" aria-modal="true">
          <div class="cal-modal-head">
            <h2>＋ 安排新的排期日程</h2>
            <button class="cal-modal-close" id="calFormClose">✕</button>
          </div>
          <form id="calCreateForm" class="cal-form">
            <div class="form-row">
              <label>排期标题 *</label>
              <input type="text" id="evTitle" required placeholder="如：PT-BRONCHO-001 支气管高密度栓塞复查评估" autocomplete="off" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>业务类型</label>
                <select id="evCategory">
                  <option value="followup">患者随访复查 (Follow-up)</option>
                  <option value="research">科研项目推进 (Research)</option>
                  <option value="meeting">科室研讨会 (Meeting)</option>
                  <option value="general">综合事务 (General)</option>
                </select>
              </div>
              <div class="form-row">
                <label>地点 / 会议室</label>
                <input type="text" id="evLocation" placeholder="如：门诊三楼呼吸介入科 302 诊室" />
              </div>
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>开始时间 *</label>
                <input type="text" id="evStart" required value="${startTimeDefault}" placeholder="YYYY-MM-DD HH:mm" />
              </div>
              <div class="form-row">
                <label>结束时间 *</label>
                <input type="text" id="evEnd" required value="${endTimeDefault}" placeholder="YYYY-MM-DD HH:mm" />
              </div>
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>关联患者代号 (可选)</label>
                <input type="text" id="evPtCode" placeholder="如：PT-BRONCHO-001" />
              </div>
              <div class="form-row">
                <label>关联科研项目 (可选)</label>
                <input type="text" id="evStudyTitle" placeholder="如：DAPA-HF (NCT03036124)" />
              </div>
            </div>

            <div class="form-row">
              <label>随访/科研要点备注</label>
              <textarea id="evNotes" rows="3" placeholder="填写需重点核查的高危指标、检查单据、用药依从性或统计复核事项…"></textarea>
            </div>

            <div class="form-checkbox-row">
              <label class="checkbox-label">
                <input type="checkbox" id="evSendEmail" checked />
                <span>同步向我的 <b class="brand-domain">@heurion.com</b> 医生工作邮箱发送日程提醒</span>
              </label>
            </div>

            <div class="cal-modal-foot">
              <button type="button" class="cal-btn ghost" id="calFormCancel">取消</button>
              <button type="submit" class="cal-btn primary" id="calFormSubmit">确认创建并同步</button>
            </div>
          </form>
        </div>
      </div>
    `

    const scrim = $('calFormScrim')
    const close = () => { scrim?.remove() }
    $('calFormClose')?.addEventListener('click', close)
    $('calFormCancel')?.addEventListener('click', close)
    scrim?.addEventListener('click', e => { if (e.target === scrim) close() })

    const form = $('calCreateForm') as HTMLFormElement
    form.onsubmit = async e => {
      e.preventDefault()
      const title = ($('evTitle') as HTMLInputElement).value.trim()
      const category = ($('evCategory') as HTMLSelectElement).value as CalendarEvent['category']
      const location = ($('evLocation') as HTMLInputElement).value.trim()
      const start_time = ($('evStart') as HTMLInputElement).value.trim()
      const end_time = ($('evEnd') as HTMLInputElement).value.trim()
      const patient_code = ($('evPtCode') as HTMLInputElement).value.trim() || undefined
      const study_title = ($('evStudyTitle') as HTMLInputElement).value.trim() || undefined
      const notes = ($('evNotes') as HTMLTextAreaElement).value.trim() || undefined
      const send_email = ($('evSendEmail') as HTMLInputElement).checked

      try {
        await api('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            category,
            location,
            start_time,
            end_time,
            patient_code,
            study_title,
            notes,
            send_email,
          }),
        })
        notice(send_email ? '排期创建成功，已同步通知医生邮箱' : '排期创建成功')
        close()
        await loadEvents()
      } catch (err) {
        notice((err as Error).message, true)
      }
    }
  }

  // Wire action filters in nav-panel
  function initActionPills(): void {
    const fAll = $('calFilterAll')
    const fFollowup = $('calFilterFollowup')
    const fResearch = $('calFilterResearch')
    const newBtn = $('newCalEvent')

    newBtn?.addEventListener('click', () => showEventDialog())

    const updatePills = (active: 'all' | 'followup' | 'research') => {
      activeFilter = active
      fAll?.classList.toggle('on', active === 'all')
      fFollowup?.classList.toggle('on', active === 'followup')
      fResearch?.classList.toggle('on', active === 'research')
      void loadEvents()
    }

    fAll?.addEventListener('click', () => updatePills('all'))
    fFollowup?.addEventListener('click', () => updatePills('followup'))
    fResearch?.addEventListener('click', () => updatePills('research'))

    $('docSearch')?.addEventListener('input', () => {
      if (!$('calList')?.hidden) renderNavList()
    })

    // Left nav item selection
    $('calList')?.addEventListener('click', e => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('.cal-nav-item')
      if (li) {
        const id = li.dataset.evId
        if (id) {
          selectedEventId = id
          renderNavList()
          showEventDetailModal(id)
        }
      }
    })
  }

  initActionPills()

  return {
    async enter(): Promise<void> {
      hooks.leaveDoc()
      await loadEvents()
    },
    leave(): void {
      selectedEventId = null
    },
    async createEvent(eventData: Partial<CalendarEvent> & { send_email?: boolean }): Promise<void> {
      await api('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
      })
      await loadEvents()
    },
  }
}
