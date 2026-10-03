/**
 * 患者（第二期）：左栏「患者」页签、患者页（概览 / 化验 / 报告 / 待确认）、上传报告与审核、诊疗组、紧急访问、访问记录。
 * 患者在平台里只有代号；「代号 → 姓名」的备注只存在这台电脑的浏览器里（localStorage），平台不保存。
 */
import { askConfirm, askText } from './dialogs.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

interface Patient {
  id: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]; status: string
  role?: string; labs?: number; last_lab?: string | null; pending?: number
}
interface Lab {
  id: string; record_id: string | null; test_key: string; test_name: string; value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null; collected_on: string | null
  status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: string; locator: { page?: number; verified?: boolean } | null
  collected_at: string | null; replaces: string | null
  std_value: number | null; std_unit: string | null; std_ref_low: number | null; std_ref_high: number | null; converted: boolean; unknown_unit: boolean
  same_day?: Lab[]
}
interface RecordRow {
  id: string; kind: string; title: string; report_date: string | null; file_id: string | null; status: 'pending' | 'confirmed' | 'rejected'
  extraction: string | null; extraction_note: string | null; created_at: string
}
interface Detail extends Patient {
  access: 'owner' | 'member' | 'tenant' | 'break_glass'; summary: string | null
  documents: Array<{ doc_id: string; kind: string; title: string; author: string; linked_at: string; updated_at: string; can_open: boolean }>
  care_team: Array<{ user_id: string; role: string; name: string }>; records: RecordRow[]; latest_labs: Lab[]
  pending_proposals: Array<{ id: string; kind: string; payload: Record<string, unknown>; reason: string; created_at: string }>
}

export interface PatientHooks {
  /** 离开当前文档（关掉编辑器、清空中间区域） */
  leaveDoc(): void
  openDoc(id: string): Promise<void>
  /** 把指令填进对话框（不发送） */
  prefillChat(text: string): void
  /** 文档模式的欢迎页 */
  showDocWelcome(): void
  tenantId(): string | null
  token(): string
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const KIND: Record<string, string> = { lab_report: '化验', discharge: '出院小结', pathology: '病理', imaging: '影像', note: '记录', other: '报告' }
const SEX: Record<string, string> = { M: '男', F: '女' }
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx,.txt'
const value = (l: Lab) => l.value_num ?? l.value_text ?? ''
const ref = (l: Lab) => l.ref_low !== null || l.ref_high !== null ? `${l.ref_low ?? ''}–${l.ref_high ?? ''}` : (l.ref_text ?? '')
/** 标准单位下的值（化验表、趋势用）；换算过的带「*」，悬停看原值 */
const stdValue = (l: Lab) => l.std_value ?? l.value_text ?? ''
const stdRef = (l: Lab) => l.std_ref_low !== null || l.std_ref_high !== null ? `${l.std_ref_low ?? ''}–${l.std_ref_high ?? ''}` : (l.ref_text ?? '')
const origNote = (l: Lab) => l.converted ? `原值 ${l.value_num} ${l.unit ?? ''}，已换算` : l.unknown_unit ? `单位 ${l.unit} 无法换算，不能与其他次直接比较` : ''
const when = (l: Lab) => l.collected_at ?? l.collected_on ?? ''

export function initPatients(api: Api, notice: Notice, hooks: PatientHooks) {
  let list: Patient[] = []
  let current: string | null = null
  let tab: 'overview' | 'labs' | 'records' | 'docs' | 'review' = 'overview'
  let poll: ReturnType<typeof setTimeout> | null = null
  const $ = (id: string) => document.getElementById(id)!

  // —— 本机备注名 ——
  const namesKey = () => `heurion.ptnames.${hooks.tenantId() ?? 'x'}`
  const names = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(namesKey()) ?? '{}') } catch { return {} } }
  const setName = (id: string, name: string) => { try { const n = names(); if (name.trim()) n[id] = name.trim().slice(0, 40); else delete n[id]; localStorage.setItem(namesKey(), JSON.stringify(n)) } catch { /* 无痕模式 */ } }
  const label = (p: Patient) => names()[p.id] ? `${p.code} · ${names()[p.id]}` : p.code
  const age = (p: Patient) => p.birth_year ? `${new Date().getFullYear() - p.birth_year} 岁` : ''

  // —— 左栏 ——

  async function loadList(): Promise<void> {
    try { list = await api<Patient[]>('/api/patients') } catch (err) {
      $('patientList').innerHTML = `<li class="nav-empty">${esc((err as Error).message)}</li>`
      return
    }
    renderList()
  }

  function renderList(): void {
    const q = (document.getElementById('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = list.filter(p => !q || label(p).toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)))
    $('patientList').innerHTML = shown.map(p => `<li data-pt="${p.id}" class="${p.id === current ? 'active' : ''}" title="${esc(p.tags.join('、'))}">
        <span class="pt-code">${esc(p.code)}</span><span class="label">${esc(names()[p.id] ?? p.tags.slice(0, 2).join('、'))}</span>
        ${p.pending ? `<span class="count" title="待确认">${p.pending}</span>` : ''}${p.role === 'break_glass' ? '<span class="pill off" title="紧急访问">紧急</span>' : ''}</li>`).join('')
      + (list.length === 0 ? '<li class="nav-empty">还没有患者。点「＋患者」新建；患者在系统里只用代号。</li>' : shown.length === 0 ? `<li class="nav-empty">没有找到「${esc(q)}」</li>` : '')
      + '<li class="nav-empty pt-glass-row"><button class="nav-add" id="breakGlassBtn" hidden>紧急访问…</button></li>'
    void api('/api/tenant').then(t => { const b = document.getElementById('breakGlassBtn'); if (b) b.hidden = t.role !== 'admin' }).catch(() => {})
  }

  async function createPatient(): Promise<void> {
    const sex = await askText({ title: '新建患者', label: '性别（男 / 女，可留空）', placeholder: '男', confirm: '下一步', hint: '患者在系统里只有代号（P-0001…），不要填姓名。姓名可以在患者页「本机备注」里记，只存在这台电脑上。' })
    if (sex === null) return
    const year = await askText({ title: '新建患者', label: '出生年份（可留空）', placeholder: '1962', confirm: '下一步' })
    if (year === null) return
    const tags = await askText({ title: '新建患者', label: '诊断标签（用逗号分开，可留空）', placeholder: '2型糖尿病，CKD3', confirm: '创建' })
    if (tags === null) return
    try {
      const p = await api<Patient>('/api/patients', { method: 'POST', body: JSON.stringify({ sex: sex.trim(), birth_year: year.trim() || null, tags: tags.split(/[,，、;；]/).map(x => x.trim()).filter(Boolean) }) })
      await loadList()
      await openPatient(p.id)
    } catch (err) { notice((err as Error).message, true) }
  }

  async function breakGlass(): Promise<void> {
    const dir = await api<Array<{ id: string; code: string }>>('/api/patients-directory')
    const visible = new Set(list.map(p => p.id))
    const others = dir.filter(d => !visible.has(d.id))
    if (others.length === 0) { notice('本机构所有患者你都已能看到'); return }
    const code = await askText({ title: '紧急访问', label: `患者代号（可访问的：${others.map(o => o.code).slice(0, 12).join('、')}${others.length > 12 ? ' …' : ''}）`, placeholder: 'P-0001', confirm: '下一步' })
    const target = others.find(o => o.code === code?.trim().toUpperCase())
    if (!target) { if (code) notice('没有这个代号', true); return }
    const reason = await askText({ title: `紧急访问 ${target.code}`, label: '理由（至少 10 个字，会记入访问日志并留痕）', placeholder: '例如：患者夜间急诊，主治医生不在，需要查看既往肾功能', confirm: '申请 24 小时只读访问' })
    if (!reason) return
    try {
      await api(`/api/patients/${target.id}/break-glass`, { method: 'POST', body: JSON.stringify({ reason }) })
      notice('已获得 24 小时只读访问，已记入访问日志')
      await loadList()
      await openPatient(target.id)
    } catch (err) { notice((err as Error).message, true) }
  }

  // —— 患者页 ——

  async function openPatient(id: string, keepTab = false): Promise<void> {
    if (current !== id) hooks.leaveDoc()
    current = id
    if (!keepTab) tab = 'overview'
    if (poll) { clearTimeout(poll); poll = null }
    let d: Detail
    try { d = await api<Detail>(`/api/patients/${id}`) } catch (err) { notice((err as Error).message, true); current = null; return }
    const page = $('page')
    page.className = 'page patient-page'
    $('docTitle').textContent = label(d)
    renderList()
    const pendingLabs = tab === 'review' || tab === 'labs' ? await api<Lab[]>(`/api/patients/${id}/labs?pending=1`) : []
    const confirmedLabs = tab === 'labs' ? pendingLabs.filter(l => l.status === 'confirmed') : []
    const pendingCount = d.records.filter(r => r.status === 'pending').length + d.pending_proposals.length
    const canEdit = d.access === 'owner' || d.access === 'member'
    page.innerHTML = `
      <div class="pt-head">
        <div class="pt-id"><span class="pt-code big">${esc(d.code)}</span>
          <button class="quiet small-btn" data-act="alias" title="只存在这台电脑的浏览器里，平台不保存">${names()[d.id] ? `本机备注：${esc(names()[d.id])}` : '＋ 本机备注姓名'}</button></div>
        <div class="pt-meta">${[d.sex ? SEX[d.sex] : '', d.birth_year ? `${d.birth_year} 年生（${age(d)}）` : ''].filter(Boolean).join(' · ') || '<span class="muted">未填性别 / 年龄</span>'}
          ${d.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}${canEdit ? '<button class="quiet small-btn" data-act="tags">编辑</button>' : ''}</div>
        ${d.access === 'break_glass' ? '<div class="notice">紧急访问（只读，24 小时内有效，已记入访问日志）</div>' : d.access === 'tenant' ? '<div class="muted small">机构设置为全员可见：你可以查看，修改需要加入诊疗组</div>' : ''}
        <div class="row pt-actions">
          ${canEdit ? `<button class="primary" data-act="upload" title="化验单、出院小结、病理报告（PDF、扫描件、手机照片）：自动提取，审核后进入化验表">上传化验单 / 报告</button><input type="file" id="ptUpload" accept="${ACCEPT}" multiple hidden>` : ''}
          <button data-act="report" title="新建一份病例报告并关联到这位患者；对话框里会填好建议的指令，由你确认后发送">写病例报告</button>
          ${d.access === 'owner' ? '<button data-act="team">诊疗组</button><button data-act="log">访问记录</button><button class="danger" data-act="delete">删除</button>' : ''}
        </div>
        ${pendingCount ? `<div class="banner pt-pending"><span class="dot"></span>${d.records.filter(r => r.status === 'pending').length} 份报告、${d.pending_proposals.length} 条 AI 提议待确认<button data-tab="review">去审核</button></div>` : ''}
      </div>
      <div class="tabs pt-tabs">${(['overview', 'labs', 'records', 'docs', 'review'] as const).map(t => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ overview: '概览', labs: '化验', records: '原始报告', docs: `病例报告${d.documents.length ? ` (${d.documents.length})` : ''}`, review: `待确认${pendingCount ? ` (${pendingCount})` : ''}` }[t]}</button>`).join('')}</div>
      <div class="pt-body">${tab === 'overview' ? overview(d, canEdit) : tab === 'labs' ? labsView(confirmedLabs) : tab === 'records' ? recordsView(d) : tab === 'docs' ? docsView(d) : reviewView(d, pendingLabs, canEdit)}</div>`
    // 还在提取的报告：隔几秒刷新
    if (d.records.some(r => r.extraction === 'queued' || r.extraction === 'running')) poll = setTimeout(() => { if (current === id) void openPatient(id, true) }, 3000)
  }

  function overview(d: Detail, canEdit: boolean): string {
    return `<section><h3 class="mem-h">摘要</h3>
        ${canEdit ? `<textarea id="ptSummary" rows="4" placeholder="病史要点、用药、随访计划（只用代号，不写姓名）">${esc(d.summary ?? '')}</textarea>` : `<div class="pt-summary">${esc(d.summary ?? '（无）')}</div>`}</section>
      <section><h3 class="mem-h">最近化验</h3>${d.latest_labs.length === 0 ? '<div class="muted">还没有已确认的化验。点「上传化验单 / 报告」，自动提取后在「待确认」里审核。</div>' : `<table class="users pt-labs">
        <thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th></tr></thead><tbody>
        ${d.latest_labs.map(l => `<tr data-trend="${esc(l.test_key)}"><td>${esc(l.test_name)}</td><td class="flag-${l.flag ?? 'n'}" title="${esc(origNote(l))}">${esc(stdValue(l))} ${esc(l.std_unit ?? '')}${l.flag === 'H' ? ' ↑' : l.flag === 'L' ? ' ↓' : ''}${l.converted || l.unknown_unit ? '<sup>*</sup>' : ''}</td><td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td></tr>`).join('')}
        </tbody></table><div class="muted small">点一行看趋势。</div>`}</section>
      <section><h3 class="mem-h">诊疗组</h3><div>${d.care_team.map(m => `<span class="chip">${esc(m.name)}${m.role === 'owner' ? '（负责人）' : ''}</span>`).join(' ')}</div></section>`
  }

  function labsView(labs: Lab[]): string {
    if (labs.length === 0) return '<div class="muted">还没有已确认的化验。</div>'
    const dates = [...new Set(labs.map(l => l.collected_on!))].sort().reverse().slice(0, 12)
    const tests = [...new Map(labs.map(l => [l.test_key, l])).values()]
    // 同一天多次：显示最新一次 + ×N，悬停列出每一次（时间、值、原单位）
    const cell = (key: string, date: string) => {
      const day = labs.filter(x => x.test_key === key && x.collected_on === date)
      const l = day.at(-1)
      if (!l) return '<td></td>'
      const tip = day.map(x => `${x.collected_at ?? x.collected_on}：${stdValue(x)} ${x.std_unit ?? ''}${x.converted ? `（原值 ${x.value_num} ${x.unit}）` : ''}`).join('\n') + (origNote(l) && day.length === 1 ? '' : '')
      return `<td class="flag-${l.flag ?? 'n'}" title="${esc(day.length > 1 ? tip : origNote(l))}">${esc(stdValue(l))}${l.flag === 'H' ? '↑' : l.flag === 'L' ? '↓' : ''}${l.converted || l.unknown_unit ? '<sup>*</sup>' : ''}${day.length > 1 ? `<span class="pt-multi">×${day.length}</span>` : ''}</td>`
    }
    const unitOf = (key: string) => {
      const units = [...new Set(labs.filter(l => l.test_key === key).map(l => l.std_unit ?? ''))]
      return units.length > 1 ? `<span class="flag-L" title="有无法换算的单位，不同次不能直接比较">${esc(units.join(' / '))} ⚠</span>` : esc(units[0] ?? '')
    }
    const anyConverted = labs.some(l => l.converted)
    return `<div class="ds-scroll"><table class="chart-grid pt-pivot"><thead><tr><th>项目</th><th>单位</th>${dates.map(d => `<th>${esc(d)}</th>`).join('')}</tr></thead>
      <tbody>${tests.map(t => `<tr data-trend="${esc(t.test_key)}"><td>${esc(t.test_name)}</td><td class="muted">${unitOf(t.test_key)}</td>${dates.map(d => cell(t.test_key, d)).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="muted small">只显示已确认的化验，最近 12 个检查日；同一天多次显示最新一次（×N，悬停看每次）。${anyConverted ? '带 * 的是从其他单位换算的（悬停看原值）。' : ''}点一行看趋势。</div><div id="ptTrend"></div>`
  }

  /** 病例报告历史：「写病例报告」新建的文档都关联在这里，新的在前。 */
  function docsView(d: Detail): string {
    const KINDS: Record<string, string> = { case_report: '病例报告', followup: '随访小结', discussion: '病例讨论', other: '文档' }
    return `<div class="row"><span class="muted small">依据这位患者已确认的数据写的报告都保存在这里；每份报告在文档里也有自己的版本历史。</span><span class="grow"></span><button class="primary" data-act="report">写新的病例报告</button></div>
      ${d.documents.length === 0 ? '<div class="muted pt-empty">还没有病例报告。</div>' : `<table class="users"><thead><tr><th>标题</th><th>类型</th><th>作者</th><th>创建</th><th>最近修改</th><th></th></tr></thead><tbody>
      ${d.documents.map(x => `<tr><td><b>${esc(x.title)}</b></td><td>${esc(KINDS[x.kind] ?? x.kind)}</td><td>${esc(x.author)}</td>
        <td class="muted">${new Date(x.linked_at).toLocaleString('zh-CN', { hour12: false })}</td><td class="muted">${new Date(x.updated_at).toLocaleString('zh-CN', { hour12: false })}</td>
        <td class="actions">${x.can_open ? `<button data-opendoc="${x.doc_id}">打开</button>` : '<span class="muted small">只有作者能打开</span>'}</td></tr>`).join('')}</tbody></table>`}`
  }

  function recordsView(d: Detail): string {
    if (d.records.length === 0) return '<div class="muted">还没有上传原始报告。点「上传化验单 / 报告」。</div>'
    const STATUS: Record<string, string> = { pending: '待确认', confirmed: '已确认', rejected: '已驳回' }
    const EXTRACT: Record<string, string> = { queued: '排队提取', running: '提取中…', done: '', failed: '提取失败', skipped: '' }
    return `<table class="users"><thead><tr><th>报告日期</th><th>类型</th><th>标题</th><th>状态</th><th></th></tr></thead><tbody>
      ${d.records.map(r => `<tr data-rec="${r.id}"><td>${esc(r.report_date ?? '—')}</td><td>${esc(KIND[r.kind] ?? r.kind)}</td>
        <td>${esc(r.title)}${r.extraction_note ? `<div class="muted small">${esc(r.extraction_note)}</div>` : ''}</td>
        <td><span class="pill ${r.status === 'confirmed' ? 'ok' : 'off'}">${STATUS[r.status]}</span> <span class="muted small">${EXTRACT[r.extraction ?? ''] ?? ''}</span></td>
        <td class="actions">${r.file_id ? `<button data-file="${r.file_id}">原件</button>` : ''}</td></tr>`).join('')}</tbody></table>`
  }

  function reviewView(d: Detail, labs: Lab[], canEdit: boolean): string {
    const pendingRecs = d.records.filter(r => r.status === 'pending')
    if (pendingRecs.length === 0 && d.pending_proposals.length === 0) return '<div class="muted">没有待确认的内容。</div>'
    const fileUrl = (fid: string) => `/api/patients/${d.id}/files/${fid}?token=${encodeURIComponent(hooks.token())}`
    const recHtml = pendingRecs.map(r => {
      const rows = labs.filter(l => l.record_id === r.id && l.status === 'pending')
      const busy = r.extraction === 'queued' || r.extraction === 'running'
      return `<div class="pt-review" data-rec="${r.id}">
        <div class="pt-review-file">${r.file_id ? `<iframe title="原件" src="${fileUrl(r.file_id)}"></iframe><a href="${fileUrl(r.file_id)}" target="_blank" rel="noreferrer" class="small">在新标签页打开原件</a>` : ''}</div>
        <div class="pt-review-data">
          <div class="row"><b>${esc(r.title)}</b><span class="muted small">${esc(KIND[r.kind] ?? r.kind)}</span><span class="grow"></span>
            <label class="small">报告日期 <input type="date" class="pt-date" value="${esc(r.report_date ?? '')}" ${canEdit ? '' : 'disabled'}></label></div>
          ${busy ? '<div class="muted">正在提取，稍候…</div>' : r.extraction_note ? `<div class="muted small">${esc(r.extraction_note)}</div>` : ''}
          ${rows.length ? `<table class="chart-grid pt-edit"><thead><tr><th>项目</th><th>结果</th><th>单位</th><th>参考低</th><th>参考高</th><th>页</th><th></th></tr></thead><tbody>
            ${rows.map(l => `<tr data-lab="${l.id}" class="${l.locator?.verified === false ? 'pt-unverified' : ''}">
              <td><input data-f="test_name" value="${esc(l.test_name)}" ${canEdit ? '' : 'disabled'}></td><td><input data-f="value" value="${esc(value(l))}" ${canEdit ? '' : 'disabled'}></td>
              <td><input data-f="unit" value="${esc(l.unit ?? '')}" ${canEdit ? '' : 'disabled'}></td><td><input data-f="ref_low" value="${esc(l.ref_low ?? '')}" ${canEdit ? '' : 'disabled'}></td>
              <td><input data-f="ref_high" value="${esc(l.ref_high ?? '')}" ${canEdit ? '' : 'disabled'}></td><td class="muted">${l.locator?.page ?? ''}${l.locator?.verified === false ? ' <span title="原文里没找到这个数，请对照原件">⚠</span>' : ''}</td>
              <td>${canEdit ? '<button class="quiet small-btn" data-labx="reject" title="删除这一项">✕</button>' : ''}</td></tr>
              ${l.same_day?.length ? `<tr class="pt-sameday" data-lab="${l.id}"><td colspan="7">同一天已确认：${l.same_day.map(o => `${esc(stdValue(o))} ${esc(o.std_unit ?? '')}${o.collected_at ? `（${esc(o.collected_at.slice(11))}）` : ''}`).join('、')}
                ${canEdit ? `<select data-replaces><option value="">两个都保留</option>${l.same_day.map(o => `<option value="${o.id}"${l.replaces === o.id ? ' selected' : ''}>这是更正：替换 ${esc(stdValue(o))}</option>`).join('')}</select>` : ''}</td></tr>` : ''}`).join('')}</tbody></table>` : busy ? '' : '<div class="muted small">没有提取到化验项。</div>'}
          ${canEdit && !busy ? '<button class="quiet small-btn" data-recx="addrow" title="自动提取漏了某项，或不能自动提取时：对照左边的原件补上">＋ 对照原件补一项</button>' : ''}
          ${canEdit && !busy ? '<div class="row end"><button class="danger" data-recx="reject">驳回整份</button><button class="primary" data-recx="confirm">确认这份报告</button></div>' : ''}
        </div></div>`
    }).join('')
    const props = d.pending_proposals.map(p => `<li class="mem" data-prop="${p.id}"><div class="mem-text"><span class="mem-kind">AI 提议</span>${esc(p.kind === 'lab' ? `化验：${p.payload.test_name} ${p.payload.value} ${p.payload.unit ?? ''}（${p.payload.collected_on}）` : p.kind === 'tag' ? `诊断标签：${p.payload.tag}` : `摘要补充：${p.payload.text}`)}</div>
        <div class="muted small">依据：${esc(p.reason)}</div>${canEdit ? '<div class="actions-row"><button class="primary" data-propx="accept">采纳</button><button data-propx="reject">不采纳</button></div>' : ''}</li>`).join('')
    return recHtml + (props ? `<h3 class="mem-h">AI 的提议</h3><ul class="mem-list">${props}</ul>` : '')
  }

  /** 趋势：一条折线 + 参考范围色带（SVG）。 */
  async function showTrend(key: string, after: HTMLElement): Promise<void> {
    const all = (await api<Lab[]>(`/api/patients/${current}/labs?tests=${encodeURIComponent(key)}`)).filter(l => l.std_value !== null && l.collected_on)
    document.getElementById('ptTrendBox')?.remove()
    // 单位无法换算的点不画（和其他次不可比），在图下说明
    const labs = all.filter(l => !l.unknown_unit)
    const skipped = all.length - labs.length
    if (labs.length === 0) return
    const W = 560, H = 180, P = 36
    const t = (l: Lab) => Date.parse((l.collected_at ?? l.collected_on!).replace(' ', 'T'))
    const xs = labs.map(t), ys = labs.map(l => l.std_value!)
    const lows = labs.map(l => l.std_ref_low).filter((v): v is number => v !== null), highs = labs.map(l => l.std_ref_high).filter((v): v is number => v !== null)
    const lo = Math.min(...ys, ...lows), hi = Math.max(...ys, ...highs)
    const pad = (hi - lo) * 0.15 || 1
    const [y0, y1] = [lo - pad, hi + pad]
    const x = (ts: number) => xs.length === 1 || xs.at(-1) === xs[0] ? W / 2 : P + (ts - xs[0]!) / (xs.at(-1)! - xs[0]!) * (W - 2 * P)
    const y = (v: number) => H - P / 2 - (v - y0) / (y1 - y0) * (H - P)
    // 参考范围色带：每段用该段起点那次化验的参考范围（不同医院范围不同）
    const seg = (l: Lab, x0: number, x1: number) => l.std_ref_low === null && l.std_ref_high === null ? ''
      : `<rect x="${x0}" width="${Math.max(2, x1 - x0)}" y="${y(l.std_ref_high ?? y1)}" height="${y(l.std_ref_low ?? y0) - y(l.std_ref_high ?? y1)}" class="trend-band"/>`
    const band = labs.length === 1 ? seg(labs[0]!, P, W - P) : labs.slice(0, -1).map((l, i) => seg(l, x(xs[i]!), x(xs[i + 1]!))).join('') + seg(labs.at(-1)!, x(xs.at(-1)!) - 1, W - P)
    const pts = labs.map(l => `${x(t(l))},${y(l.std_value!)}`).join(' ')
    const box = document.createElement('div')
    box.id = 'ptTrendBox'
    box.className = 'pt-trend'
    box.innerHTML = `<div class="row"><b>${esc(labs[0]!.test_name)}</b><span class="muted small">${esc(labs[0]!.std_unit ?? '')}${labs.some(l => l.converted) ? ' · 部分数值已从其他单位换算' : ''} · 色带为各次报告的参考范围</span><span class="grow"></span><button class="quiet small-btn" data-trend-close>✕</button></div>
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg">${band}<polyline points="${pts}" class="trend-line"/>
        ${labs.map(l => `<circle cx="${x(t(l))}" cy="${y(l.std_value!)}" r="3.5" class="trend-dot flag-${l.flag ?? 'n'}"><title>${esc(when(l))}：${l.std_value} ${esc(l.std_unit ?? '')}${l.converted ? `（原值 ${l.value_num} ${esc(l.unit ?? '')}）` : ''}</title></circle>
          <text x="${x(t(l))}" y="${y(l.std_value!) - 8}" class="trend-label">${l.std_value}</text>`).join('')}
        <text x="${P}" y="${H - 4}" class="trend-axis">${esc(labs[0]!.collected_on)}</text><text x="${W - P}" y="${H - 4}" class="trend-axis" text-anchor="end">${esc(labs.at(-1)!.collected_on)}</text></svg>
      ${skipped ? `<div class="muted small">另有 ${skipped} 次的单位无法换算，没有画进趋势（见化验表）。</div>` : ''}`
    after.after(box)
  }

  /** 写病例报告：新建文档并关联到患者，打开后把建议的指令填进对话框（不自动发送，由医生改好后自己发送）。 */
  async function writeReport(d: Patient): Promise<void> {
    try {
      const doc = await api<{ id: string }>('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${d.code} 病例报告 ${new Date().toLocaleDateString('sv-SE')}` }) })
      await api(`/api/patients/${d.id}/docs`, { method: 'POST', body: JSON.stringify({ doc_id: doc.id, kind: 'case_report' }) })
      current = null
      await hooks.openDoc(doc.id)
      hooks.prefillChat(`请依据患者 ${d.code} 的已确认数据写一份病例报告（参考 CARE 指南：病史、检查、诊断、治疗与随访、讨论）。化验值写明日期并标出异常；只用代号或去标识写法，不写姓名；数据里没有的内容留「待补充」，不要编造。需要时画关键化验的趋势图。`)
      notice('已新建病例报告并关联到患者。对话框里填好了建议的指令，可以修改后点「发送」')
    } catch (err) { notice((err as Error).message, true) }
  }

  // —— 事件 ——

  document.getElementById('page')!.addEventListener('click', async e => {
    if (!current || !document.getElementById('page')!.classList.contains('patient-page')) return
    const t = e.target as HTMLElement
    const id = current
    const d = await (async () => list.find(p => p.id === id) ?? await api<Patient>(`/api/patients/${id}`))()
    const tabBtn = t.closest<HTMLElement>('[data-tab]')
    if (tabBtn) { tab = tabBtn.dataset.tab as typeof tab; void openPatient(id, true); return }
    const trend = t.closest<HTMLElement>('tr[data-trend]')
    if (trend) { void showTrend(trend.dataset.trend!, trend.closest('table')!); return }
    if (t.closest('[data-trend-close]')) { document.getElementById('ptTrendBox')?.remove(); return }
    const opendoc = t.closest<HTMLElement>('[data-opendoc]')
    if (opendoc) { current = null; await hooks.openDoc(opendoc.dataset.opendoc!); return }
    const file = t.closest<HTMLElement>('[data-file]')
    if (file) { window.open(`/api/patients/${id}/files/${file.dataset.file}?token=${encodeURIComponent(hooks.token())}`, '_blank'); return }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    try {
      if (act === 'alias') {
        const n = await askText({ title: '本机备注姓名', label: `${d.code} 的姓名（只存在这台电脑的浏览器里，平台不保存、不发给 AI）`, value: names()[id] ?? '', confirm: '保存' })
        if (n !== null) { setName(id, n); void openPatient(id, true) }
      } else if (act === 'tags') {
        const v = await askText({ title: '诊断标签', label: '用逗号分开', value: d.tags.join('，'), confirm: '保存' })
        if (v !== null) { await api(`/api/patients/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: v.split(/[,，、;；]/).map(x => x.trim()).filter(Boolean) }) }); await loadList(); void openPatient(id, true) }
      } else if (act === 'upload') {
        (document.getElementById('ptUpload') as HTMLInputElement).click()
      } else if (act === 'report') {
        await writeReport(d)
      } else if (act === 'team') {
        const [colleagues, detail] = await Promise.all([api<any[]>('/api/tenant/colleagues'), api<Detail>(`/api/patients/${id}`)])
        const inTeam = new Set(detail.care_team.map(m => m.user_id))
        const add = colleagues.filter(c => !inTeam.has(c.id))
        const who = await askText({ title: '诊疗组', label: `现在：${detail.care_team.map(m => m.name).join('、')}。加入谁？（用户名）`, placeholder: add.map(c => c.username).slice(0, 5).join(' / '), confirm: '加入', hint: '诊疗组成员能查看和修改这位患者；要移出某人，在用户名前加「-」，例如 -nurse_li' })
        if (!who) return
        const name = who.trim().replace(/^-/, '')
        const target = colleagues.find(c => c.username === name || c.display_name === name)
        if (!target) { notice('本机构没有这位成员', true); return }
        if (who.trim().startsWith('-')) await api(`/api/patients/${id}/team/${target.id}`, { method: 'DELETE' })
        else await api(`/api/patients/${id}/team`, { method: 'POST', body: JSON.stringify({ user_id: target.id }) })
        notice('诊疗组已更新'); void openPatient(id, true)
      } else if (act === 'log') {
        const rows = await api<any[]>(`/api/patients/${id}/access-log`)
        const ACTION: Record<string, string> = { create: '新建', view: '查看', update: '修改', labs_read: '读化验', lab_add: '补录化验项', doc_link: '关联报告', doc_unlink: '取消关联', lab_confirm: '确认化验', lab_reject: '删除化验', lab_edit: '修改化验', file_upload: '上传报告', file_download: '查看原件', record_confirm: '确认报告', record_reject: '驳回报告', propose: '提议', proposal_accept: '采纳提议', proposal_reject: '不采纳提议', team_add: '加入诊疗组', team_remove: '移出诊疗组', break_glass: '紧急访问', delete: '删除' }
        const dlg = document.getElementById('dialog')!
        dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="访问记录"><div class="dialog-head"><h2>${esc(d.code)} 访问记录</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
          <div class="dialog-body"><table class="users audit-table"><thead><tr><th>时间</th><th>谁</th><th>操作</th><th>说明</th></tr></thead><tbody>
          ${rows.map(r => `<tr${r.action === 'break_glass' ? ' class="audit-failed"' : ''}><td class="muted">${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}</td><td>${esc(r.user)}${r.via === 'ai' ? ' <span class="pill">AI</span>' : ''}</td><td>${esc(ACTION[r.action] ?? r.action)}</td><td class="muted">${esc(r.action === 'break_glass' ? r.detail : '')}</td></tr>`).join('')}</tbody></table></div></div>`
        dlg.hidden = false
        dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
      } else if (act === 'delete') {
        if (await askConfirm({ title: `删除 ${d.code}`, message: '删除这位患者的全部记录、化验和上传的报告，不可恢复。', confirm: '删除', danger: true })) {
          await api(`/api/patients/${id}`, { method: 'DELETE' }); setName(id, ''); current = null; await loadList(); hooks.leaveDoc(); showWelcome()
        }
      }
      // 审核
      const recBox = t.closest<HTMLElement>('[data-rec]')
      const recx = t.closest<HTMLElement>('[data-recx]')?.dataset.recx
      if (recBox && recx === 'addrow') {
        const line = await askText({ title: '对照原件补一项', label: '项目 结果 单位 参考范围（空格分开，单位和参考范围可省略）', placeholder: '肌酐 168 µmol/L 57-111', confirm: '添加', hint: '日期取这份报告的日期。添加后和自动提取的项一样，确认整份报告时一起生效。' })
        if (!line) return
        const m = /^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(-?[\d.]+)\s*[-–~]\s*(-?[\d.]+))?\s*$/.exec(line.trim())
        if (!m) { notice('格式：项目 结果 单位 参考范围，例如「肌酐 168 µmol/L 57-111」', true); return }
        await api(`/api/patients/${id}/records/${recBox.dataset.rec}/labs`, { method: 'POST', body: JSON.stringify({ test_name: m[1], value: m[2], unit: m[3] ?? null, ref_low: m[4] ?? null, ref_high: m[5] ?? null }) })
        void openPatient(id, true)
        return
      }
      if (recBox && recx) {
        const date = (recBox.querySelector('.pt-date') as HTMLInputElement | null)?.value || undefined
        await api(`/api/patients/${id}/records/${recBox.dataset.rec}/${recx}`, { method: 'POST', body: JSON.stringify({ report_date: date }) })
        notice(recx === 'confirm' ? '已确认，化验已进入化验表' : '已驳回'); await loadList(); void openPatient(id, true)
      }
      const labRow = t.closest<HTMLElement>('tr[data-lab]')
      if (labRow && t.closest('[data-labx]')) { await api(`/api/patients/${id}/labs/${labRow.dataset.lab}/reject`, { method: 'POST' }); labRow.remove() }
      const prop = t.closest<HTMLElement>('[data-prop]')
      const propx = t.closest<HTMLElement>('[data-propx]')?.dataset.propx
      if (prop && propx) { await api(`/api/patients/${id}/proposals/${prop.dataset.prop}/${propx}`, { method: 'POST' }); await loadList(); void openPatient(id, true) }
    } catch (err) { notice((err as Error).message, true) }
  })

  // 审核表里改字段：失焦即保存（只改待确认的）
  document.getElementById('page')!.addEventListener('change', async e => {
    if (!current) return
    const input = e.target as HTMLInputElement
    const id = current
    if (input.id === 'ptUpload' && input.files?.length) {
      const failed: string[] = []
      let ok = 0
      for (const f of Array.from(input.files)) {
        const fd = new FormData()
        fd.append('file', f)
        try { await api(`/api/patients/${id}/files`, { method: 'POST', body: fd }); ok++ } catch (err) { failed.push(`${f.name}：${(err as Error).message}`) }
      }
      input.value = ''
      // 被拦下的（重复上传等）单独说清楚，不被「已上传」覆盖
      if (failed.length) notice((ok ? `已上传 ${ok} 份，正在自动提取。` : '') + failed.join('；'), true)
      else notice('已上传，正在自动提取，完成后在「待确认」里审核')
      if (!ok) return
      tab = 'review'
      void openPatient(id, true)
      return
    }
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-replaces]')
    const srow = sel?.closest<HTMLElement>('tr[data-lab]')
    if (sel && srow) {
      try { await api(`/api/patients/${id}/labs/${srow.dataset.lab}`, { method: 'PATCH', body: JSON.stringify({ replaces: sel.value || null }) }); notice(sel.value ? '确认这份报告时，旧值会标为已被更正' : '两个都保留') }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const row = input.closest<HTMLElement>('tr[data-lab]')
    if (row && input.dataset.f) {
      try { await api(`/api/patients/${id}/labs/${row.dataset.lab}`, { method: 'PATCH', body: JSON.stringify({ [input.dataset.f]: input.value }) }); row.classList.remove('pt-unverified') }
      catch (err) { notice((err as Error).message, true) }
    }
  })
  document.getElementById('page')!.addEventListener('blur', async e => {
    const ta = e.target as HTMLTextAreaElement
    if (ta.id !== 'ptSummary' || !current) return
    try { await api(`/api/patients/${current}`, { method: 'PATCH', body: JSON.stringify({ summary: ta.value }) }) } catch (err) { notice((err as Error).message, true) }
  }, true)

  /** 患者模式下还没选患者：中间显示患者模块的引导（不显示文档的欢迎页）。 */
  function showWelcome(): void {
    const page = $('page')
    page.className = 'page patient-page pt-welcome'
    $('docTitle').textContent = '患者'
    page.innerHTML = `<div class="pt-welcome-body">
      <span class="pt-code big">P-····</span>
      <h1>${list.length ? '选择一位患者' : '新建第一位患者'}</h1>
      <p class="muted">患者在系统里只有代号，不存姓名；姓名可以在患者页「本机备注」里记，只保存在这台电脑上。</p>
      <ol class="pt-steps">
        <li><b>新建患者</b><span>填性别、出生年份、诊断标签。</span></li>
        <li><b>上传化验单 / 报告</b><span>PDF、扫描件、手机照片都行；自动识别报告日期和化验项，异常值自动标出。</span></li>
        <li><b>审核</b><span>在「待确认」里对照原件核对，确认后进入化验表和趋势。</span></li>
        <li><b>写病例报告</b><span>依据已确认的数据起草，报告保存在患者的「病例报告」里。</span></li>
      </ol>
      <div class="row"><button class="primary" data-pw="new">＋ 新建患者</button>${list[0] ? `<button data-pw="open">打开 ${esc(label(list[0]))}</button>` : ''}</div>
    </div>`
  }

  document.getElementById('page')!.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pw]')
    if (!b || !document.getElementById('page')!.classList.contains('pt-welcome')) return
    if (b.dataset.pw === 'new') void createPatient()
    else if (list[0]) void openPatient(list[0].id)
  })

  // —— 左栏页签 ——

  const setMode = (mode: 'docs' | 'patients') => {
    $('navDocs').classList.toggle('on', mode === 'docs')
    $('navPatients').classList.toggle('on', mode === 'patients')
    $('navDocs').setAttribute('aria-selected', String(mode === 'docs'))
    $('navPatients').setAttribute('aria-selected', String(mode === 'patients'))
    $('navLabel').textContent = mode === 'docs' ? '文档' : '患者'
    $('docList').hidden = mode !== 'docs'
    $('patientList').hidden = mode !== 'patients'
    $('newProject').hidden = mode !== 'docs'
    $('docActions').hidden = mode !== 'docs'
    $('ptActions').hidden = mode !== 'patients'
    ;(document.getElementById('docSearch') as HTMLInputElement).placeholder = mode === 'docs' ? '搜索文档（标题与正文）' : '按代号、本机备注、标签筛选'
    try { localStorage.setItem('heurion.navMode', mode) } catch { /* 忽略 */ }
    const page = $('page')
    const idle = page.classList.contains('welcome-page') || page.classList.contains('pt-welcome') || page.childElementCount === 0
    if (mode === 'patients') void loadList().then(() => { if (idle && !current) showWelcome() })
    else if (idle || (page.classList.contains('patient-page') && current)) { current = null; hooks.showDocWelcome() }
  }
  $('navDocs').onclick = () => setMode('docs')
  $('navPatients').onclick = () => setMode('patients')
  $('newPatientBig').onclick = () => void createPatient()
  $('patientList').onclick = e => {
    const t = e.target as HTMLElement
    if (t.closest('#breakGlassBtn')) { void breakGlass(); return }
    const li = t.closest<HTMLElement>('li[data-pt]')
    if (li) void openPatient(li.dataset.pt!)
  }
  document.getElementById('docSearch')!.addEventListener('input', () => { if (!$('patientList').hidden) renderList() })
  try { if (localStorage.getItem('heurion.navMode') === 'patients') setMode('patients') } catch { /* 忽略 */ }

  return {
    /** 打开文档时：患者页失效 */
    leave(): void { current = null; if (poll) { clearTimeout(poll); poll = null } if (!$('patientList').hidden) renderList() },
    /** 打开患者页（从病例报告回到患者） */
    async open(id: string): Promise<void> { setMode('patients'); await openPatient(id) },
    /** 当前左栏是不是患者页签（启动时决定显示哪个欢迎页） */
    isPatientMode(): boolean { return !$('patientList').hidden },
    /** 机构没开患者模块时隐藏页签 */
    setEnabled(on: boolean): void { $('navPatients').closest<HTMLElement>('.nav-switch')!.hidden = !on; if (!on) setMode('docs') },
  }
}
