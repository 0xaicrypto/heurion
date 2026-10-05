/**
 * 患者（第二期）：左栏「患者」页签、患者页（概览 / 化验 / 报告 / 待确认）、上传报告与审核、诊疗组、紧急访问、访问记录。
 * 患者在平台里只有代号；「代号 → 姓名」的备注只存在这台电脑的浏览器里（localStorage），平台不保存。
 */
import { photoFigure } from './photos.ts'
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
  imaging_data?: {
    model_id?: string
    sample_id?: string | null
    modality?: string
    asset_id?: string
    file_id?: string
    raw_file_id?: string | null
    raw_file_name?: string | null
    raw_file_size?: number | null
    metrics?: Record<string, any>
    findings?: string[]
    analyzed_at?: string
  } | null
}
interface Detail extends Patient {
  access: 'owner' | 'member' | 'tenant' | 'break_glass'; summary: string | null
  documents: Array<{ doc_id: string; kind: string; title: string; author: string; linked_at: string; updated_at: string; can_open: boolean }>
  care_team: Array<{ user_id: string; role: string; name: string }>; records: RecordRow[]; latest_labs: Lab[]
  pending_proposals: Array<{ id: string; kind: string; payload: Record<string, unknown>; reason: string; created_at: string }>
  /** 所在研究（研究编号） */
  studies?: Array<{ study_id: string; title: string; subject_id: string; enrolled_at: string }>
}

interface ShareSummary {
  share_id: string; share_code: string; department: string; to_me: boolean; scope: { categories: string[]; since: string | null }
  allow_import: boolean; expires_at: string; shared_at: string; imported: { at: string; patient_id: string | null } | null; display_name?: string | null
}
interface ShareDetail extends ShareSummary {
  sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]; latest_labs: Lab[]; lab_count: number
  records: Array<{ id: string; kind: string; title: string; report_date: string | null; file_id: string | null }>
  documents: Array<{ doc_id: string; kind: string; title: string; updated_at: string }>
}
const SCOPE: Record<string, string> = { labs: '化验', reports: '报告原件', docs: '简报与健康档案' }
const scopeText = (s: { categories: string[]; since: string | null }) => `${s.categories.map(c => SCOPE[c] ?? c).join('、')}${s.since ? `（${s.since} 起）` : ''}`

export interface PatientHooks {
  /** 离开当前文档（关掉编辑器、清空中间区域） */
  leaveDoc(): void
  openDoc(id: string): Promise<void>
  /** 把指令填进对话框（不发送） */
  prefillChat(text: string): void
  /** 切到某个工作空间（左侧图标栏） */
  goSpace(space: 'write' | 'patients' | 'research'): void
  tenantId(): string | null
  token(): string
  /** 打开研究页（患者所在研究） */
  openStudy?(id: string): Promise<void>
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

  // —— 家庭分享（知家家人分享给本人科室 / 本人的档案，只读；docs/design/SHARING.md）——
  let shares: ShareSummary[] = []
  async function loadShares(): Promise<void> {
    try { shares = await api<ShareSummary[]>('/api/shares') } catch { shares = [] }
  }

  async function loadList(): Promise<void> {
    await loadShares()
    try { list = await api<Patient[]>('/api/patients') } catch (err) {
      $('patientList').innerHTML = `<li class="nav-empty">${esc((err as Error).message)}</li>`
      return
    }
    renderList()
  }

  function renderList(): void {
    const q = (document.getElementById('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = list.filter(p => !q || label(p).toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)))
    $('patientList').innerHTML = (shares.length ? `<li class="pt-share-row${document.getElementById('page')!.classList.contains('share-page') ? ' active' : ''}" data-shares title="知家家人分享给你所在科室的档案（只读）">
        <span class="pt-code">家庭</span><span class="label">家庭分享</span><span class="count">${shares.length}</span></li>` : '')
      + shown.map(p => `<li data-pt="${p.id}" class="${p.id === current ? 'active' : ''}" title="${esc(p.tags.join('、'))}">
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
    if (!id) return
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
          ${canEdit ? `<button class="primary" data-act="imaging" title="使用 MONAI 深度学习模型对胸部/腹部 CT 或 MRI 进行定量分析（支气管扩张、粘液栓、RECIST 1.1 靶病灶等）并沉淀至患者档案">🩺 影像分析</button>` : ''}
          ${canEdit ? `<button data-act="upload" title="化验单、出院小结、病理报告（PDF、扫描件、手机照片）：自动提取，审核后进入化验表">上传化验单 / 报告</button><input type="file" id="ptUpload" accept="${ACCEPT}" multiple hidden>` : ''}
          <button data-act="report" title="新建一份病例报告并关联到这位患者；对话框里会填好建议的指令，由你确认后发送">写病例报告</button>
          ${d.access === 'owner' ? `<span class="grow"></span><div class="menu-wrap"><button data-act="ptmore" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="ptMore" hidden><button data-act="claim">就诊认领与知家绑定</button><button data-act="team">诊疗组</button><button data-act="log">访问记录</button><button data-act="delete" class="danger-text">删除患者</button></div></div>` : ''}
        </div>
        ${pendingCount ? `<div class="banner pt-pending"><span class="dot"></span>${d.records.filter(r => r.status === 'pending').length} 份报告、${d.pending_proposals.length} 条 AI 提议待确认<button data-tab="review">去审核</button></div>` : ''}
      </div>
      <div class="tabs pt-tabs">${(['overview', 'labs', 'records', 'docs', 'review'] as const).map(t => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ overview: '概览', labs: '化验', records: `原始报告 / 影像${d.records.filter(r => r.kind === 'imaging').length ? ` (${d.records.filter(r => r.kind === 'imaging').length})` : ''}`, docs: `病例报告${d.documents.length ? ` (${d.documents.length})` : ''}`, review: `待确认${pendingCount ? ` (${pendingCount})` : ''}` }[t]}</button>`).join('')}</div>
      <div class="pt-body">${tab === 'overview' ? overview(d, canEdit) : tab === 'labs' ? labsView(confirmedLabs) : tab === 'records' ? recordsView(d) : tab === 'docs' ? docsView(d) : reviewView(d, pendingLabs, canEdit)}</div>`
    // 还在提取的报告：隔几秒刷新
    if (d.records.some(r => r.extraction === 'queued' || r.extraction === 'running')) poll = setTimeout(() => { if (current === id) void openPatient(id, true) }, 3000)
  }

  function overview(d: Detail, canEdit: boolean): string {
    const latestImg = d.records.find(r => r.kind === 'imaging')
    const imgWidget = latestImg ? `
      <section class="pt-overview-imaging">
        <div class="row" style="align-items: baseline; margin-bottom: 8px"><h3 class="mem-h" style="margin: 0">最新医学影像量化</h3><span class="grow"></span><button class="quiet small-btn" data-tab="records">查看全部影像档案 ➔</button></div>
        <div class="pt-overview-img-card" data-rec="${latestImg.id}">
          ${latestImg.file_id ? `<img src="/api/patients/${d.id}/files/${latestImg.file_id}?token=${encodeURIComponent(hooks.token())}" class="pt-overview-thumb" data-view-img="/api/patients/${d.id}/files/${latestImg.file_id}?token=${encodeURIComponent(hooks.token())}" title="点击查看大图">` : ''}
          <div class="pt-overview-img-meta">
            <div class="row" style="align-items: center; justify-content: space-between"><b>${esc(latestImg.title)}</b><span class="muted small">${esc(latestImg.report_date || '')}</span></div>
            <div class="muted small" style="margin: 6px 0 10px; line-height: 1.5">${esc(latestImg.extraction_note || '已完成三维体素分割与定量测量')}</div>
            <div class="row" style="gap: 8px">
              <button class="primary small-btn" data-img-report="${latestImg.id}">📝 基于此影像写报告</button>
              <button class="small-btn" data-img-canvas="${latestImg.id}">🎨 会诊 Slide</button>
              <button class="quiet small-btn" data-tab="records">详细指标</button>
            </div>
          </div>
        </div>
      </section>` : ''

    return `<section><h3 class="mem-h">摘要</h3>
        ${canEdit ? `<textarea id="ptSummary" rows="4" placeholder="病史要点、用药、随访计划（只用代号，不写姓名）">${esc(d.summary ?? '')}</textarea>` : `<div class="pt-summary">${esc(d.summary ?? '（无）')}</div>`}</section>
      ${imgWidget}
      <section><h3 class="mem-h">最近化验</h3>${d.latest_labs.length === 0 ? '<div class="muted">还没有已确认的化验。点「上传化验单 / 报告」，自动提取后在「待确认」里审核。</div>' : `<table class="users pt-labs">
        <thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th></tr></thead><tbody>
        ${d.latest_labs.map(l => `<tr data-trend="${esc(l.test_key)}"><td>${esc(l.test_name)}</td><td class="flag-${l.flag ?? 'n'}" title="${esc(origNote(l))}">${esc(stdValue(l))} ${esc(l.std_unit ?? '')}${l.flag === 'H' ? ' ↑' : l.flag === 'L' ? ' ↓' : ''}${l.converted || l.unknown_unit ? '<sup>*</sup>' : ''}</td><td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td></tr>`).join('')}
        </tbody></table><div class="muted small">点一行看趋势。</div>`}</section>
      ${d.studies?.length ? `<section><h3 class="mem-h">所在研究</h3><div>${d.studies.map(x => `<button class="chip pt-study" data-study="${x.study_id}" title="打开研究">${esc(x.title)} · ${esc(x.subject_id)}</button>`).join(' ')}</div></section>` : ''}
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
    const imagingRecords = d.records.filter(r => r.kind === 'imaging')
    const otherRecords = d.records.filter(r => r.kind !== 'imaging')

    if (d.records.length === 0) return '<div class="muted">还没有影像或报告。点击上方「🩺 影像分析」量化 CT/MRI，或「上传化验单 / 报告」。</div>'
    const STATUS: Record<string, string> = { pending: '待确认', confirmed: '已确认', rejected: '已驳回' }
    const EXTRACT: Record<string, string> = { queued: '排队提取', running: '提取中…', done: '', failed: '提取失败', skipped: '' }

    const imagingHtml = imagingRecords.length ? `
      <div class="pt-imaging-section">
        <div class="row pt-section-head">
          <h3 class="mem-h" style="margin: 0">🩺 医学影像量化档案 (MONAI 3D Quantitative Imaging)</h3>
          <span class="muted small">${imagingRecords.length} 份分析记录</span>
          <span class="grow"></span>
          <button class="primary small-btn" data-act="imaging">＋ 新建影像量化分析</button>
        </div>
        <div class="pt-imaging-grid">
          ${imagingRecords.map(r => {
            const data = r.imaging_data || {}
            const m = data.metrics || {}
            const aid = data.asset_id
            const sliceFid = data.file_id
            const imgUrl = sliceFid ? `/api/patients/${d.id}/files/${sliceFid}?token=${encodeURIComponent(hooks.token())}` : aid ? `/api/assets/${aid}?token=${encodeURIComponent(hooks.token())}` : ''
            const rawFid = data.raw_file_id || (r.file_id && r.file_id !== sliceFid ? r.file_id : null)
            const rawFileName = data.raw_file_name || (rawFid ? 'scan.nii.gz' : '')
            const rawSizeText = data.raw_file_size ? `${(data.raw_file_size / (1024 * 1024)).toFixed(1)} MB` : ''
            const isBronchiectasis = data.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')
            return `
              <div class="pt-imaging-card" data-rec="${r.id}">
                <div class="pt-imaging-thumb-wrap" data-view-img="${imgUrl}" title="点击查看切片大图">
                  ${imgUrl ? `<img src="${imgUrl}" alt="${esc(r.title)}" class="pt-imaging-thumb">` : '<div class="pt-imaging-no-img">暂无预览</div>'}
                  <span class="pt-imaging-badge-overlay">${esc(data.modality || 'CT')}</span>
                </div>
                <div class="pt-imaging-content">
                  <div class="pt-imaging-head">
                    <div class="pt-imaging-title">
                      <b>${esc(r.title)}</b>
                      ${rawFileName ? `<span class="pt-imaging-badge" title="原始 3D 扫描文件已加密保存在该患者档案中">📦 ${esc(rawFileName)}</span>` : ''}
                    </div>
                    <span class="muted small">${esc(r.report_date || r.created_at.slice(0, 10))}</span>
                  </div>
                  <div class="pt-imaging-metrics">
                    ${isBronchiectasis ? `
                      ${m.bar_ratio ? `<span class="pt-imaging-pill ${m.signet_ring_sign ? 'alert' : 'ok'}">BAR 印戒征: ${m.bar_ratio}${m.signet_ring_sign ? ' (阳性 ⚠)' : ''}</span>` : ''}
                      ${m.total_mucus_volume_cm3 !== undefined ? `<span class="pt-imaging-pill">粘液栓体积: ${m.total_mucus_volume_cm3} cm³</span>` : ''}
                      ${m.high_attenuation_mucus_cm3 ? `<span class="pt-imaging-pill alert">高密度粘液栓 HAM: ${m.high_attenuation_mucus_cm3} cm³ (ABPA疑诊)</span>` : ''}
                      ${m.airway_occlusion_rate_pct !== undefined ? `<span class="pt-imaging-pill">管腔阻塞率: ${m.airway_occlusion_rate_pct}%</span>` : ''}
                      ${m.wall_to_lumen_ratio ? `<span class="pt-imaging-pill">管壁/管腔比: ${m.wall_to_lumen_ratio}</span>` : ''}
                      ${m.primary_location || m.distribution_summary ? `
                        <div class="pt-imaging-location-row" style="margin-top: 6px; font-size: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                          <span style="font-weight: 600; color: var(--text)">📍 解剖定位:</span>
                          <span class="pt-imaging-badge" style="background: rgba(56,189,248,0.12); color: var(--blue); border-color: rgba(56,189,248,0.3)">${esc(m.primary_location || m.distribution_summary)}</span>
                          ${m.mucus_nodule_locations && m.mucus_nodule_locations.length > 0 ? `
                            <span class="muted small">(${m.mucus_nodule_locations.length} 个主要嵌顿团簇 · 范围 ${esc(m.mucus_nodule_locations[0].slice_range)})</span>
                          ` : ''}
                        </div>
                      ` : ''}
                    ` : `
                      ${m.longest_diameter_mm ? `<span class="pt-imaging-pill alert">RECIST 1.1 长径: ${m.longest_diameter_mm} mm</span>` : ''}
                      ${m.short_axis_mm ? `<span class="pt-imaging-pill">短径: ${m.short_axis_mm} mm</span>` : ''}
                      ${m.total_volume_cm3 ? `<span class="pt-imaging-pill">3D 体积: ${m.total_volume_cm3} cm³</span>` : ''}
                      ${m.key_slice_index !== undefined ? `<span class="pt-imaging-pill">最大截面: #${m.key_slice_index} 层</span>` : ''}
                    `}
                  </div>
                  ${r.extraction_note ? `<div class="pt-imaging-note muted small">${esc(r.extraction_note)}</div>` : ''}
                  <div class="pt-imaging-actions">
                    <button class="primary small-btn" data-img-report="${r.id}" title="自动创建文档并由 AI 撰写 CARE 准则病例报告，插入该影像量化指标与关键截面图">📝 写影像病例报告</button>
                    <button class="small-btn" data-img-canvas="${r.id}" title="在 Heurion 原生幻灯片工作台制作包含此影像指标的多页会诊 Slide (PPTX)">🎨 制作会诊 Slide</button>
                    ${imgUrl ? `<button class="quiet small-btn" data-view-img="${imgUrl}">🔍 查看量化切片</button>` : ''}
                    ${rawFid ? `<a class="quiet small-btn" href="/api/patients/${d.id}/files/${rawFid}?token=${encodeURIComponent(hooks.token())}" target="_blank" download="${esc(rawFileName)}" title="下载该患者已归档的原始 3D 序列扫描文件">💾 下载 3D 原卷${rawSizeText ? ` (${esc(rawSizeText)})` : ''}</a>` : ''}
                  </div>
                </div>
              </div>`
          }).join('')}
        </div>
      </div>
    ` : ''

    const otherHtml = otherRecords.length ? `
      <div class="pt-other-records-section">
        <h3 class="mem-h" style="margin-top: ${imagingRecords.length ? '24px' : '0'}">📄 检验报告与病历文书</h3>
        <table class="users"><thead><tr><th>报告日期</th><th>类型</th><th>标题</th><th>状态</th><th></th></tr></thead><tbody>
          ${otherRecords.map(r => `<tr data-rec="${r.id}"><td>${esc(r.report_date ?? '—')}</td><td>${esc(KIND[r.kind] ?? r.kind)}</td>
            <td>${esc(r.title)}${r.extraction_note ? `<div class="muted small">${esc(r.extraction_note)}</div>` : ''}</td>
            <td><span class="pill ${r.status === 'confirmed' ? 'ok' : 'off'}">${STATUS[r.status]}</span> <span class="muted small">${EXTRACT[r.extraction ?? ''] ?? ''}</span></td>
            <td class="actions">${r.file_id ? `<button data-file="${r.file_id}">原件</button>` : ''}</td></tr>`).join('')}
        </tbody></table>
      </div>
    ` : ''

    return imagingHtml + otherHtml
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
    const props = d.pending_proposals.map(p => `<li class="mem" data-prop="${p.id}"><div class="mem-text"><span class="mem-kind">AI 提议</span>${esc(p.kind === 'lab' ? `化验：${p.payload.test_name} ${p.payload.value} ${p.payload.unit ?? ''}（${p.payload.collected_on}）` : p.kind === 'tag' ? `诊断标签：${p.payload.tag}` : p.kind === 'enroll' ? `入组研究「${p.payload.study_title}」` : p.kind === 'unenroll' ? `移出研究「${p.payload.study_title}」（${p.payload.subject_id}）` : p.kind === 'update' ? `修改患者信息：${Object.keys(p.payload).join('、')}` : `摘要补充：${p.payload.text}`)}</div>
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

  /** 基于影像分析记录一键写病例报告：创建文档，关联患者，自动在 AI 对话框预填影像指标与关键截面插图 */
  async function writeImagingReport(d: Patient | Detail, r: RecordRow): Promise<void> {
    try {
      const doc = await api<{ id: string }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title: `${d.code} 影像病例报告 ${r.report_date || new Date().toISOString().slice(0, 10)}` })
      })
      await api(`/api/patients/${d.id}/docs`, { method: 'POST', body: JSON.stringify({ doc_id: doc.id, kind: 'case_report' }) })
      current = null
      await hooks.openDoc(doc.id)

      const imgData = r.imaging_data || {}
      const m = imgData.metrics || {}
      const assetId = imgData.asset_id
      const isBronchiectasis = imgData.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')

      let promptText = `请依据患者 ${d.code} 的已确认数据及最新医学影像量化分析结果写一份专业病例报告（参考 CARE 临床病例报告指南与 Fleischner 学会准则）：\n\n`
      promptText += `【影像检查信息】\n`
      promptText += `- 检查名称：${r.title}\n`
      promptText += `- 检查日期：${r.report_date || '近期'}\n`
      if (assetId) {
        promptText += `- 关键截面插图：![${r.title}](/api/assets/${assetId})\n`
      }
      promptText += `\n【核心量化指标】\n`
      if (isBronchiectasis) {
        if (m.bar_ratio) promptText += `- 支气管-伴行动脉比 (BAR): ${m.bar_ratio} (${m.signet_ring_sign ? '印戒征阳性，确诊支气管扩张' : '正常'})\n`
        if (m.total_mucus_volume_cm3 !== undefined) promptText += `- 气道粘液栓总体积: ${m.total_mucus_volume_cm3} cm³\n`
        if (m.high_attenuation_mucus_cm3) promptText += `- 高密度粘液栓 (HAM) 体积: ${m.high_attenuation_mucus_cm3} cm³ (强烈提示变应性支气管肺曲霉病 ABPA 疑诊)\n`
        if (m.airway_occlusion_rate_pct !== undefined) promptText += `- 气道管腔阻塞率: ${m.airway_occlusion_rate_pct}%\n`
        if (m.wall_to_lumen_ratio) promptText += `- 管壁增厚比 (Wall/Lumen): ${m.wall_to_lumen_ratio}\n`
        if (m.primary_location) promptText += `- 粘液栓主要解剖位置: ${m.primary_location}\n`
        if (m.distribution_summary) promptText += `- 优势分布肺叶: ${m.distribution_summary}\n`
        if (m.mucus_nodule_locations && m.mucus_nodule_locations.length > 0) {
          promptText += `- 主要粘液结节/栓塞详情:\n`
          m.mucus_nodule_locations.slice(0, 3).forEach((n: any, idx: number) => {
            promptText += `  ${idx + 1}. ${n.location_name} (${n.zone_type}) · 切片: ${n.slice_range} · 体积: ${n.volume_cm3} cm³ (CT: ${n.mean_hu} HU)\n`
          })
        }
      } else {
        if (m.longest_diameter_mm) promptText += `- RECIST 1.1 靶病灶最大横截面长径: ${m.longest_diameter_mm} mm\n`
        if (m.short_axis_mm) promptText += `- 垂直短径: ${m.short_axis_mm} mm\n`
        if (m.total_volume_cm3) promptText += `- 3D 病灶总体积: ${m.total_volume_cm3} cm³\n`
        if (m.key_slice_index !== undefined) promptText += `- 最大横截面层号: 第 #${m.key_slice_index} 层\n`
      }
      if (r.extraction_note) promptText += `- 征象摘要: ${r.extraction_note}\n`
      promptText += `\n请按照病史摘要、影像表现与量化分析、诊断结论、鉴别诊断及下一步临床随访治疗方案展开撰写。只用患者代号 ${d.code}，不写姓名。`

      hooks.prefillChat(promptText)
      notice('已新建影像病例报告并关联到患者。AI 对话框已准备好包含量化指标与切片插图的指令，可直接确认发送。')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** 基于影像分析记录直接在 Heurion 原生工作台创建多页会诊幻灯片 (kind='deck') 并关联患者 */
  async function makeImagingSlideDeck(d: Patient | Detail, r: RecordRow): Promise<void> {
    try {
      const title = `${d.code} 影像会诊幻灯片 ${r.report_date || new Date().toISOString().slice(0, 10)}`
      const doc = await api<{ id: string }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title, kind: 'deck' })
      })
      await api(`/api/patients/${d.id}/docs`, {
        method: 'POST',
        body: JSON.stringify({ doc_id: doc.id, kind: 'presentation' })
      })
      current = null
      await hooks.openDoc(doc.id)

      const imgData = r.imaging_data || {}
      const m = imgData.metrics || {}
      const assetId = imgData.asset_id
      const isBronchiectasis = imgData.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')

      let promptText = `请依据患者 ${d.code} 的医学影像量化分析数据，为当前会诊幻灯片（标题：${title}）制作多页专业幻灯片：\n\n`
      promptText += `【影像检查信息】\n`
      promptText += `- 检查项目：${r.title}\n`
      promptText += `- 检查日期：${r.report_date || '近期'}\n`
      if (assetId) {
        promptText += `- 关键截面图（已入库资产）：![${r.title}](/api/assets/${assetId})\n`
      }
      promptText += `\n【核心量化指标】\n`
      if (isBronchiectasis) {
        if (m.bar_ratio) promptText += `- BAR 印戒征比值: ${m.bar_ratio} (${m.signet_ring_sign ? '确诊支气管扩张' : '正常'})\n`
        if (m.total_mucus_volume_cm3 !== undefined) promptText += `- 气道粘液栓总体积: ${m.total_mucus_volume_cm3} cm³ (阻塞率: ${m.airway_occlusion_rate_pct}%)\n`
        if (m.high_attenuation_mucus_cm3) promptText += `- 高密度粘液栓 HAM: ${m.high_attenuation_mucus_cm3} cm³ (强烈提示变应性支气管肺曲霉病 ABPA)\n`
        if (m.primary_location) promptText += `- 主要解剖部位: ${m.primary_location}\n`
        if (m.distribution_summary) promptText += `- 优势分布肺叶: ${m.distribution_summary}\n`
      } else {
        if (m.longest_diameter_mm) promptText += `- RECIST 1.1 靶病灶长径: ${m.longest_diameter_mm} mm (短径: ${m.short_axis_mm} mm)\n`
        if (m.total_volume_cm3) promptText += `- 3D 病灶体积: ${m.total_volume_cm3} cm³\n`
        if (m.key_slice_index !== undefined) promptText += `- 最大截面层号: 第 #${m.key_slice_index} 层\n`
      }
      promptText += `\n【建议幻灯片结构】\n`
      promptText += `1. 封面页：${d.code} 影像多学科会诊 (MDT)\n`
      promptText += `2. 临床指标与病灶测量页：三维容积、BAR 比值与管壁厚度对比\n`
      promptText += `3. 关键截面影像插图页：插入 /api/assets/${assetId || ''} 截面图并标注病灶解剖定位与阻塞率\n`
      promptText += `4. MDT 诊疗与随访决策页：排痰引流 (ACT) 方案、ABPA 鉴别与后续影像复查时间点\n\n`
      promptText += `请使用 deck_edit 工具按此结构生成或修改幻灯片各页内容。`

      hooks.prefillChat(promptText)
      notice('已在 Heurion 中新建会诊幻灯片并关联患者！AI 对话框已准备好制作指令，可直接确认发送。')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  function showImageLightbox(imgUrl: string, title?: string): void {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-lightbox-card" role="dialog" aria-modal="true" style="max-width: 860px; background: #0b0f19; border-color: rgba(255,255,255,0.15)">
        <div class="dialog-head" style="border-bottom-color: rgba(255,255,255,0.1); color: #fff">
          <h2 style="color: #fff">${esc(title || '医学影像关键截面原图 (Key Slice · MONAI 量化标尺)')}</h2>
          <button class="quiet" data-close aria-label="关闭" style="color: #ccc">✕</button>
        </div>
        <div class="dialog-body" style="padding: 16px; display: flex; justify-content: center; align-items: center">
          <img src="${imgUrl}" style="max-width: 100%; max-height: 80vh; object-fit: contain; border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.6)">
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }
  }

  async function showImagingDialog(patientId: string, d: Detail | Patient): Promise<void> {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-imaging-dialog" role="dialog" aria-modal="true" style="max-width: 680px">
        <div class="dialog-head">
          <h2>🩺 ${esc(d.code)} 医学影像量化分析 (MONAI 3D)</h2>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="gap: 14px">
          <div class="pt-img-dlg-loading" style="padding: 24px; text-align: center; color: var(--text-2);">
            正在连接 MONAI 影像计算节点与加载临床模型...
          </div>
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    let statusData: any = null
    let modelsData: any = { models: [] }
    let samplesData: any = { samples: [] }

    try {
      [statusData, modelsData, samplesData] = await Promise.all([
        api<any>('/api/imaging/status').catch(() => null),
        api<any>('/api/imaging/models').catch(() => ({ models: [] })),
        api<any>('/api/imaging/samples').catch(() => ({ samples: [] })),
      ])
    } catch {}

    const isHealthy = statusData && statusData.status === 'healthy'
    const devInfo = statusData?.device || {}
    const devName = isHealthy
      ? `${devInfo.accelerator || 'GPU / Metal 统一内存加速'}${devInfo.total_unified_ram_gb ? ` · ${devInfo.total_unified_ram_gb}GB 统一内存` : ''}`
      : '计算节点离线 (端口 8004 未连接)'

    const samples: Array<{ id: string; name: string; modality: string; size_mb?: number }> = samplesData.samples || []
    const modelsList: Array<{ id: string; name: string; category?: string; modality?: string; target?: string; recommended_window?: string }> = modelsData.models || []

    const categories: Record<string, typeof modelsList> = {}
    for (const m of modelsList) {
      const cat = m.category || '通用临床模型'
      if (!categories[cat]) categories[cat] = []
      categories[cat].push(m)
    }
    const defaultDesc = modelsList.find(m => m.id === 'bronchiectasis_mucus_analyzer')?.target || '支气管-动脉径比 (BAR)、粘液栓容积、解剖肺叶肺段定位、树芽征'

    const body = dlg.querySelector('.dialog-body')
    if (!body) return
    body.innerHTML = `
      <div class="pt-img-banner ${isHealthy ? 'ok' : 'warn'}">
        <span class="dot"></span>
        <div>
          <b>${isHealthy ? 'MONAI 医学影像计算引擎就绪' : '计算微服务离线'}</b>
          <div class="muted small">${esc(devName)}</div>
        </div>
      </div>

      <div class="field">
        <label><b>影像数据来源</b></label>
        <div class="row" style="gap: 16px; margin: 4px 0 8px">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 6px">
            <input type="radio" name="imgSource" value="sample" checked> 预置高分辨临床扫描（一键分析）
          </label>
          <label style="cursor: pointer; display: flex; align-items: center; gap: 6px">
            <input type="radio" name="imgSource" value="upload"> 上传本地 CT/MRI (.nii / .nii.gz / .dcm)
          </label>
        </div>

        <div id="imgSampleBox">
          <select id="imgSampleSelect" class="pt-dlg-select" style="width: 100%; padding: 7px 10px">
            ${samples.length ? samples.map((s, idx) => `
              <option value="${esc(s.id)}" ${s.id === 'chest_lung_ct' || idx === 0 ? 'selected' : ''}>
                ${esc(s.name)} [${esc(s.modality)}] ${s.size_mb ? `(${s.size_mb} MB)` : ''}
              </option>
            `).join('') : `
              <option value="chest_lung_ct" selected>真实临床全胸部 HRCT 扫描 (269层 512x512，83.6MB)</option>
              <option value="spleen_test">真实临床腹部增强 CT 扫描 (96层 512x512，29.6MB)</option>
              <option value="prostate_mri">真实临床前列腺 T2 加权 MRI (19层 320x320，3.4MB)</option>
            `}
          </select>
          <div class="muted small" style="margin-top: 4px">💡 预置真实临床三维体素扫描数据。系统会将完整 3D 原始体素序列加密归档至该患者档案，作为永久保存的医学影像资料。</div>
        </div>

        <div id="imgUploadBox" hidden>
          <input type="file" id="imgFileInput" accept=".nii,.nii.gz,.dcm,.zip" style="width: 100%; border: 1px dashed var(--line-strong); padding: 14px; border-radius: 4px; background: var(--hover)">
          <div class="muted small" style="margin-top: 4px">支持高分辨率胸部/腹部 HRCT、MRI 序列 (NIfTI / DICOM 归档)。上传后将作为该患者的原始 3D 影像资料加密归档，并自动调度 MONAI 进行量化。</div>
        </div>
      </div>

      <div class="field">
        <div class="row" style="justify-content: space-between; align-items: baseline; margin-bottom: 4px">
          <label><b>选择临床深度学习模型 (MONAI Model Zoo)</b></label>
          <span class="muted small">${modelsList.length || 18} 款分科预训练临床模型</span>
        </div>
        <select id="imgModelSelect" class="pt-dlg-select" style="width: 100%; padding: 7px 10px">
          ${Object.keys(categories).length ? Object.entries(categories).map(([cat, list]) => `
            <optgroup label="${esc(cat)}">
              ${list.map(m => `
                <option value="${esc(m.id)}" data-window="${esc(m.recommended_window || 'lung')}" data-target="${esc(m.target || '')}" ${m.id === 'bronchiectasis_mucus_analyzer' ? 'selected' : ''}>
                  ${esc(m.name)} [${esc(m.modality || 'CT')}]
                </option>
              `).join('')}
            </optgroup>
          `).join('') : `
            <optgroup label="🫁 胸部与呼吸科">
              <option value="bronchiectasis_mucus_analyzer" data-window="lung" data-target="支气管-动脉径比 (BAR)、粘液栓容积、解剖肺叶肺段定位、树芽征" selected>支气管扩张与粘液栓 (Mucus Plug) 定量分析 (BAR印戒征 / 阻塞率 / HAM) [Chest HRCT]</option>
              <option value="lung_nodule_segmenter" data-window="lung" data-target="肺实质实性/磨玻璃结节 (RECIST 1.1 最大径与三维体积)">肺结节与肺实变自动分割 (MONAI 3D SegResNet) [Chest CT]</option>
              <option value="lung_airway_segmenter" data-window="lung" data-target="全气道树管腔三维拓扑骨架与管壁厚度测量">全气道树三维拓扑重建 (MONAI AirwayUNet) [Chest HRCT]</option>
              <option value="lung_lobe_segmenter" data-window="lung" data-target="双肺 5 大肺叶 (RUL, RML, RLL, LUL, LLL) 体积及占比">5 大解剖肺叶分割与肺容积积分 (MONAI V-Net) [Chest CT]</option>
              <option value="covid19_lung_infection" data-window="lung" data-target="磨玻璃影 (GGO)、网格影与实变受累百分比">病毒性肺炎磨玻璃实变影定量 (MONAI COVID-Net) [Chest CT]</option>
            </optgroup>
            <optgroup label="🫄 腹部、消化与泌尿">
              <option value="spleen_segmenter" data-window="abdomen" data-target="脾脏三维体积、脾肿大定量与创伤破裂评估">腹部实质脏器与脾脏分割 (MONAI 3D SegResNet) [Abdominal CT]</option>
              <option value="multi_organ_ct" data-window="abdomen" data-target="肝、脾、双肾、胰腺、胆囊、胃、主动脉、下腔静脉等">全腹部 13 器官多任务分割 (MONAI SwinUNETR) [Abdominal CT]</option>
              <option value="liver_lesion_segmenter" data-window="abdomen" data-target="肝实质体积、原发性肝癌 (HCC) 与转移瘤靶病灶">肝脏实质与局灶病灶/转移瘤分割 (MONAI UNet) [Abdominal CT]</option>
              <option value="pancreas_tumor_segmenter" data-window="abdomen" data-target="胰腺实质、胰腺导管腺癌与囊性占位病变">胰腺实质与胰腺肿瘤分割 (MONAI UNet) [Abdominal CT]</option>
              <option value="kidney_tumor_segmenter" data-window="abdomen" data-target="肾实质、肾肿瘤皮质实性占位与肾囊肿">肾脏与肾肿瘤/囊肿分割 (MONAI KiTS) [Abdominal CT]</option>
              <option value="prostate_mri_segmenter" data-window="abdomen" data-target="前列腺腺体分带与可疑癌灶 (PI-RADS 3-5分区)">前列腺外周带/移行带与 PI-RADS 病灶 (MONAI UNet) [Pelvic MRI]</option>
            </optgroup>
            <optgroup label="🧠 颅脑与神经系统">
              <option value="brain_tumor_brats" data-window="brain" data-target="强化肿瘤 (ET)、瘤周水肿 (ED) 与坏死核心 (NCR)">脑胶质瘤多序列分割 (MONAI BraTS DynUNet) [Brain MRI]</option>
              <option value="brain_subcortical_segmenter" data-window="brain" data-target="双侧海马体、杏仁核、丘脑体积与阿尔茨海默病量化">皮质下深部核团与海马体萎缩量化 (FastSurfer-like) [Brain T1 MRI]</option>
              <option value="stroke_ischemic_lesion" data-window="brain" data-target="急性脑梗死缺血半暗带与核心梗死容积">急性脑卒中缺血梗死灶测定 (MONAI UNet) [Brain MRI (DWI/FLAIR)]</option>
              <option value="intracranial_hemorrhage_ct" data-window="brain" data-target="硬膜下、硬膜外、脑实质内及蛛网膜下腔出血">急诊颅内出血与血肿检出 (MONAI DenseNet) [Brain Head CT]</option>
            </optgroup>
            <optgroup label="🫀 心血管系统">
              <option value="coronary_artery_calcification" data-window="mediastinum" data-target="左前降支、回旋支、右冠状动脉钙化积分与冠心病风险分层">冠状动脉钙化积分 (CAC / Agatston 评分) [Cardiac CT]</option>
              <option value="cardiac_mri_segmentation" data-window="mediastinum" data-target="左心室舒张/收缩末容积、心肌质量与射血分数 (LVEF)">心脏多时相 CINE MRI 心室分割与射血分数 [Cardiac MRI]</option>
            </optgroup>
            <optgroup label="🦴 骨科与全身体素">
              <option value="whole_body_ct_segmenter" data-window="bone" data-target="全身体素骨骼、主要内脏系统与主要肌群">全身体素 104 类解剖结构分割 (TotalSegmentator) [Whole-Body CT]</option>
              <option value="vertebra_segmenter" data-window="bone" data-target="颈椎、胸椎、腰椎各节椎体骨折压缩与椎间隙测量">全脊柱 24 节椎骨与椎间盘分割 (Spine-Segmenter) [Spine CT]</option>
            </optgroup>
          `}
        </select>
        <div id="imgModelDesc" class="muted small" style="margin-top: 5px; color: var(--blue)">💡 临床靶目标：${esc(defaultDesc)}</div>
      </div>

      <details class="pt-dlg-params" open>
        <summary style="cursor: pointer; user-select: none"><b>临床量化与重建参数设置</b> <span class="muted small">（Fleischner 准则与门限）</span></summary>
        <div class="grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px">
          <div>
            <label class="small muted">支气管-伴行动脉比 (BAR) 扩张切点</label>
            <input type="number" id="imgBarCutoff" step="0.05" value="1.10" style="width: 100%; padding: 4px 6px">
            <span class="muted small" style="font-size: 11px">参考值: &gt;1.10 确诊印戒征扩张</span>
          </div>
          <div>
            <label class="small muted">高密度粘液栓 (HAM) CT 阈值 (HU)</label>
            <input type="number" id="imgHamThreshold" step="5" value="70.0" style="width: 100%; padding: 4px 6px">
            <span class="muted small" style="font-size: 11px">参考值: &ge;70 HU 强烈提示 ABPA</span>
          </div>
          <div>
            <label class="small muted">常规粘液栓 CT 阈值范围 (HU)</label>
            <div class="row" style="gap: 4px">
              <input type="number" id="imgMucusMin" step="5" value="10.0" style="width: 50%; padding: 4px 6px">
              <span style="align-self: center">~</span>
              <input type="number" id="imgMucusMax" step="5" value="75.0" style="width: 50%; padding: 4px 6px">
            </div>
          </div>
          <div>
            <label class="small muted">CT 窗宽窗位预设 (Window)</label>
            <select id="imgWindowSelect" style="width: 100%; padding: 4px 6px">
              <option value="lung" selected>肺窗 (Lung W:1500 L:-600)</option>
              <option value="mediastinum">纵隔窗 (Mediastinum W:350 L:40)</option>
              <option value="abdomen">腹部窗 (Abdomen W:400 L:50)</option>
              <option value="brain">脑窗 (Brain W:80 L:40)</option>
            </select>
          </div>
        </div>
      </details>

      <div class="field-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px">
        <label style="display: flex; align-items: center; gap: 8px">
          <span class="muted small">报告/检查日期:</span>
          <input type="date" id="imgReportDate" value="${new Date().toISOString().slice(0, 10)}" style="padding: 3px 6px">
        </label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px">
          <input type="checkbox" id="imgAutoTag" checked> 发现阳性征象（如 BAR 印戒征或 HAM）时自动更新诊断标签
        </label>
      </div>

      <div id="imgProgressBox" hidden style="margin-top: 8px; padding: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 4px">
        <div class="row" style="align-items: center; gap: 10px">
          <span class="dot" style="background: var(--mint)"></span>
          <b id="imgProgressMsg">正在调度 Apple Silicon M4 Pro 执行 3D 卷积推理...</b>
        </div>
        <div class="muted small" style="margin-top: 4px">包含三维体素分割、支气管伴行动脉测距 (BAR)、粘液栓体积积分与高清关键截面渲染。</div>
      </div>

      <div class="row end" style="margin-top: 14px; gap: 10px">
        <button type="button" data-close>取消</button>
        <button type="button" class="primary" id="btnRunImaging" ${isHealthy ? '' : 'disabled'}>
          🚀 开始 MONAI 3D 量化推理并存入档案
        </button>
      </div>`

    // 绑定单选切换
    const radioSample = body.querySelector('input[value="sample"]') as HTMLInputElement
    const radioUpload = body.querySelector('input[value="upload"]') as HTMLInputElement
    const sampleBox = body.querySelector('#imgSampleBox') as HTMLElement
    const uploadBox = body.querySelector('#imgUploadBox') as HTMLElement

    radioSample?.addEventListener('change', () => {
      if (radioSample.checked) { sampleBox.hidden = false; uploadBox.hidden = true }
    })
    radioUpload?.addEventListener('change', () => {
      if (radioUpload.checked) { sampleBox.hidden = true; uploadBox.hidden = false }
    })

    const modelSelect = body.querySelector('#imgModelSelect') as HTMLSelectElement
    const windowSelect = body.querySelector('#imgWindowSelect') as HTMLSelectElement
    const modelDesc = body.querySelector('#imgModelDesc') as HTMLElement
    const sampleSelect = body.querySelector('#imgSampleSelect') as HTMLSelectElement

    modelSelect?.addEventListener('change', () => {
      const opt = modelSelect.selectedOptions[0]
      if (opt) {
        const win = opt.dataset.window
        const target = opt.dataset.target
        if (win && windowSelect) windowSelect.value = win
        if (target && modelDesc) modelDesc.textContent = `💡 临床靶目标：${target}`
      }
    })

    sampleSelect?.addEventListener('change', () => {
      const sid = sampleSelect.value
      if (sid === 'chest_lung_ct') {
        modelSelect.value = 'bronchiectasis_mucus_analyzer'
      } else if (sid === 'spleen_test') {
        modelSelect.value = 'spleen_segmenter'
      } else if (sid === 'prostate_mri') {
        modelSelect.value = 'prostate_mri_segmenter'
      }
      modelSelect.dispatchEvent(new Event('change'))
    })

    // 启动分析按钮
    const btnRun = body.querySelector('#btnRunImaging') as HTMLButtonElement
    const progressBox = body.querySelector('#imgProgressBox') as HTMLElement
    const progressMsg = body.querySelector('#imgProgressMsg') as HTMLElement

    btnRun?.addEventListener('click', async () => {
      const isUpload = radioUpload?.checked
      const sampleId = (body.querySelector('#imgSampleSelect') as HTMLSelectElement)?.value
      const modelId = (body.querySelector('#imgModelSelect') as HTMLSelectElement)?.value
      const windowPreset = (body.querySelector('#imgWindowSelect') as HTMLSelectElement)?.value
      const barCutoff = Number((body.querySelector('#imgBarCutoff') as HTMLInputElement)?.value || 1.10)
      const mucusMin = Number((body.querySelector('#imgMucusMin') as HTMLInputElement)?.value || 10.0)
      const mucusMax = Number((body.querySelector('#imgMucusMax') as HTMLInputElement)?.value || 75.0)
      const hamThresh = Number((body.querySelector('#imgHamThreshold') as HTMLInputElement)?.value || 70.0)
      const reportDate = (body.querySelector('#imgReportDate') as HTMLInputElement)?.value
      const autoTag = (body.querySelector('#imgAutoTag') as HTMLInputElement)?.checked

      const fileInput = body.querySelector('#imgFileInput') as HTMLInputElement
      const uploadedFile = fileInput?.files?.[0]

      if (isUpload && !uploadedFile) {
        notice('请选择要上传的 CT/MRI 影像文件 (.nii / .nii.gz / .dcm)', true)
        return
      }

      btnRun.disabled = true
      progressBox.hidden = false
      progressMsg.textContent = '正在传输体素数据并调度 Apple Silicon Metal 执行 3D 卷积分割...'

      try {
        if (isUpload && uploadedFile) {
          const fd = new FormData()
          fd.append('file', uploadedFile)
          fd.append('model_id', modelId)
          fd.append('window_preset', windowPreset)
          fd.append('bar_cutoff', String(barCutoff))
          fd.append('mucus_min_hu', String(mucusMin))
          fd.append('mucus_max_hu', String(mucusMax))
          fd.append('ham_threshold_hu', String(hamThresh))
          if (reportDate) fd.append('report_date', reportDate)
          fd.append('auto_tag', String(autoTag))
          await api(`/api/patients/${patientId}/imaging/analyze`, { method: 'POST', body: fd })
        } else {
          await api(`/api/patients/${patientId}/imaging/analyze`, {
            method: 'POST',
            body: JSON.stringify({
              sample_id: sampleId,
              model_id: modelId,
              window_preset: windowPreset,
              bar_cutoff: barCutoff,
              mucus_min_hu: mucusMin,
              mucus_max_hu: mucusMax,
              ham_threshold_hu: hamThresh,
              report_date: reportDate,
              auto_tag: autoTag,
            })
          })
        }

        notice('影像量化分析完成！已生成关键截面并加密存入患者档案。')
        close()
        tab = 'records'
        await loadList()
        await openPatient(patientId, true)
      } catch (err: any) {
        btnRun.disabled = false
        progressBox.hidden = true
        notice(`影像分析失败: ${err.message || String(err)}`, true)
      }
    })
  }

  async function showClaimDialog(patientId: string, d: Detail | Patient): Promise<void> {
    const data = await api<{
      claims: Array<{ id: string; code: string; status: string; expires_at: string; created_at: string; requested_at: string | null; confirmed_at: string | null; claimant_info?: { birth_year?: number | null } }>;
      links: Array<{ id: string; status: string; verified_at: string }>;
    }>(`/api/patients/${patientId}/claims`)
    const dlg = document.getElementById('dialog')!
    const activeClaim = data.claims.find(c => c.status === 'active')
    const requestedClaim = data.claims.find(c => c.status === 'requested')
    const activeLink = data.links.find(l => l.status === 'active')

    const renderClaimHtml = () => `
      <div class="dialog-card" role="dialog" aria-modal="true" aria-label="就诊认领与知家绑定">
        <div class="dialog-head"><h2>${esc(d.code)} 就诊认领与知家绑定</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body" style="gap: 16px">
          ${activeLink ? `
            <div class="banner" style="background: var(--green-soft); border-color: var(--green-line)">
              <span class="dot"></span>
              <div><b>已绑定知家家庭档案！</b><div class="muted small">关联编号：${esc(activeLink.id)} · 绑定于 ${new Date(activeLink.verified_at).toLocaleString('zh-CN', { hour12: false })}</div></div>
              <button class="danger quiet" id="btnUnlink" style="margin-left: auto">解除绑定</button>
            </div>
          ` : requestedClaim ? `
            <div class="banner pt-pending" style="flex-direction: column; align-items: flex-start; gap: 8px">
              <div style="display: flex; gap: 8px; align-items: center">
                <span class="dot"></span>
                <b>知家端已提交认领申请！</b>
                <span class="chip">${requestedClaim.claimant_info?.birth_year ? `${requestedClaim.claimant_info.birth_year} 年生` : '未提供出生年份'}</span>
              </div>
              <div class="muted small">为防止错认或手误，请核对患者信息并输入出生年份进行二次核验后确认绑定。</div>
              <div class="field-row" style="width: 100%; margin-top: 4px">
                <input type="number" id="claimBirthYear" placeholder="输入患者出生年份（如 1985）核对" style="max-width: 220px">
                <button class="primary" id="btnConfirmClaim">确认绑定（医生本人）</button>
                <button class="quiet" id="btnRejectClaim">驳回申请</button>
              </div>
            </div>
          ` : activeClaim ? `
            <div class="invite-link">
              <div class="muted small">患者知家认领码（24 小时有效，一码一用）：</div>
              <div class="field-row">
                <input type="text" readonly value="${esc(activeClaim.code)}" style="font-size: 16px; font-weight: 600; letter-spacing: 2px">
                <button type="button" class="primary" id="btnCopyClaim">复制</button>
              </div>
              <div class="row" style="justify-content: space-between; margin-top: 4px">
                <span class="muted small">有效期至：${new Date(activeClaim.expires_at).toLocaleString('zh-CN', { hour12: false })}</span>
                <button class="quiet danger-text" id="btnRevokeClaim" style="font-size: 12px">撤销认领码</button>
              </div>
            </div>
          ` : `
            <div class="muted small">
              生成 24 小时有效的专属就诊认领码。患者或家属在知家移动端输入该认领码后，系统将建立医院病历与家庭档案的安全链接。
            </div>
            <div class="row">
              <button class="primary" id="btnGenClaim">生成 24 小时就诊认领码</button>
            </div>
          `}

          <h3 class="mem-h" style="margin-top: 14px">认领历史记录</h3>
          ${data.claims.length === 0 ? '<div class="muted small">暂无认领记录</div>' : `
            <table class="users" style="font-size: 12px">
              <thead><tr><th>认领码</th><th>状态</th><th>生成时间</th><th>处理时间</th></tr></thead>
              <tbody>${data.claims.map(c => `<tr>
                <td style="font-family: var(--mono)">${esc(c.code)}</td>
                <td>${c.status === 'confirmed' ? '<span class="pill ok">已绑定</span>' : c.status === 'requested' ? '<span class="pill warn">待确认</span>' : c.status === 'active' ? '<span class="pill">生效中</span>' : c.status === 'expired' ? '<span class="pill off">已过期</span>' : '<span class="pill off">已撤销</span>'}</td>
                <td class="muted">${new Date(c.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
                <td class="muted">${c.confirmed_at ? new Date(c.confirmed_at).toLocaleString('zh-CN', { hour12: false }) : c.requested_at ? new Date(c.requested_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
              </tr>`).join('')}</tbody>
            </table>
          `}
        </div>
      </div>`

    dlg.innerHTML = renderClaimHtml()
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    dlg.querySelector('#btnCopyClaim')?.addEventListener('click', async () => {
      if (activeClaim) {
        await navigator.clipboard.writeText(activeClaim.code).catch(() => {})
        notice('已复制认领码')
      }
    })
    dlg.querySelector('#btnGenClaim')?.addEventListener('click', async () => {
      try {
        await api(`/api/patients/${patientId}/claims`, { method: 'POST' })
        notice('认领码已生成')
        await showClaimDialog(patientId, d)
      } catch (err) { notice((err as Error).message, true) }
    })
    dlg.querySelector('#btnRevokeClaim')?.addEventListener('click', async () => {
      if (activeClaim) {
        try {
          await api(`/api/claims/${activeClaim.id}`, { method: 'DELETE' })
          notice('认领码已撤销')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnUnlink')?.addEventListener('click', async () => {
      const activeClaimId = data.claims.find(c => c.status === 'confirmed')?.id
      if (activeClaimId && await askConfirm({ title: '解除关联', message: '解除与知家家庭成员的档案关联？解除后医院端病历数据仍保留。', confirm: '解除绑定', danger: true })) {
        try {
          await api(`/api/claims/${activeClaimId}`, { method: 'DELETE' })
          notice('已解除绑定')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnRejectClaim')?.addEventListener('click', async () => {
      if (requestedClaim) {
        try {
          await api(`/api/claims/${requestedClaim.id}`, { method: 'DELETE' })
          notice('已驳回认领申请')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnConfirmClaim')?.addEventListener('click', async () => {
      if (requestedClaim) {
        const yearInput = (dlg.querySelector('#claimBirthYear') as HTMLInputElement).value.trim()
        const year = yearInput ? Number(yearInput) : undefined
        try {
          await api(`/api/claims/${requestedClaim.id}/confirm`, { method: 'POST', body: JSON.stringify({ birth_year: year }) })
          notice('病历与知家家庭档案绑定成功！')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
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
    const study = t.closest<HTMLElement>('[data-study]')
    if (study && hooks.openStudy) { current = null; await hooks.openStudy(study.dataset.study!); return }
    const file = t.closest<HTMLElement>('[data-file]')
    if (file) { window.open(`/api/patients/${id}/files/${file.dataset.file}?token=${encodeURIComponent(hooks.token())}`, '_blank'); return }

    const viewImg = t.closest<HTMLElement>('[data-view-img]')
    if (viewImg) {
      const url = viewImg.dataset.viewImg || (viewImg as HTMLImageElement).src
      if (url) showImageLightbox(url)
      return
    }

    const imgReport = t.closest<HTMLElement>('[data-img-report]')
    if (imgReport) {
      const recId = imgReport.dataset.imgReport
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = detail.records.find(x => x.id === recId)
      if (r) await writeImagingReport(detail, r)
      return
    }

    const imgCanvas = t.closest<HTMLElement>('[data-img-canvas]')
    if (imgCanvas) {
      const recId = imgCanvas.dataset.imgCanvas
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = detail.records.find(x => x.id === recId)
      if (r) await makeImagingSlideDeck(detail, r)
      return
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'ptmore') { const m = document.getElementById('ptMore'); if (m) m.hidden = !m.hidden; return }
    document.getElementById('ptMore')?.setAttribute('hidden', '')
    try {
      if (act === 'alias') {
        const n = await askText({ title: '本机备注姓名', label: `${d.code} 的姓名（只存在这台电脑的浏览器里，平台不保存、不发给 AI）`, value: names()[id] ?? '', confirm: '保存' })
        if (n !== null) { setName(id, n); void openPatient(id, true) }
      } else if (act === 'tags') {
        const v = await askText({ title: '诊断标签', label: '用逗号分开', value: d.tags.join('，'), confirm: '保存' })
        if (v !== null) { await api(`/api/patients/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: v.split(/[,，、;；]/).map(x => x.trim()).filter(Boolean) }) }); await loadList(); void openPatient(id, true) }
      } else if (act === 'upload') {
        (document.getElementById('ptUpload') as HTMLInputElement).click()
      } else if (act === 'imaging') {
        await showImagingDialog(id, d)
      } else if (act === 'report') {
        await writeReport(d)
      } else if (act === 'claim') {
        await showClaimDialog(id, d)
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
        const ACTION: Record<string, string> = { create: '新建', view: '查看', update: '修改', labs_read: '读化验', lab_add: '补录化验项', doc_link: '关联报告', doc_unlink: '取消关联', lab_confirm: '确认化验', lab_reject: '删除化验', lab_edit: '修改化验', file_upload: '上传报告', file_download: '查看原件', record_confirm: '确认报告', record_reject: '驳回报告', imaging_analyze: '影像量化分析', propose: '提议', proposal_accept: '采纳提议', proposal_reject: '不采纳提议', team_add: '加入诊疗组', team_remove: '移出诊疗组', break_glass: '紧急访问', delete: '删除', cohort_screen: '研究筛选', enroll: '入组研究', unenroll: '移出研究', cohort_export: '生成研究数据集' }
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
      let hasImaging = false
      for (const f of Array.from(input.files)) {
        const isImaging = /\.(nii|nii\.gz|dcm|dicom|mha|nrrd)$/i.test(f.name)
        if (isImaging) {
          hasImaging = true
          notice(`正在上传医学影像 ${f.name} 并调度 MONAI 3D 卷积执行量化分析...`)
          const fd = new FormData()
          fd.append('file', f)
          fd.append('model_id', 'bronchiectasis_mucus_analyzer')
          fd.append('auto_tag', 'true')
          try {
            await api(`/api/patients/${id}/imaging/analyze`, { method: 'POST', body: fd })
            ok++
            notice(`已成功将 3D 影像资料 ${f.name} 关联至患者，并生成量化分析记录！`)
          } catch (err) {
            failed.push(`${f.name}：${(err as Error).message}`)
          }
          continue
        }
        const fd = new FormData()
        fd.append('file', f)
        try { await api(`/api/patients/${id}/files`, { method: 'POST', body: fd }); ok++ } catch (err) { failed.push(`${f.name}：${(err as Error).message}`) }
      }
      input.value = ''
      // 被拦下的（重复上传等）单独说清楚，不被「已上传」覆盖
      if (failed.length) notice((ok ? `已上传 ${ok} 份。` : '') + failed.join('；'), true)
      else if (!hasImaging) notice('已上传，正在自动提取，完成后在「待确认」里审核')
      if (!ok) return
      tab = hasImaging ? 'records' : 'review'
      await loadList()
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

  /** 家庭分享收件箱：中间区域显示卡片列表，点开看只读视图。 */
  async function openShares(focus?: string): Promise<void> {
    hooks.leaveDoc()
    current = null
    if (poll) { clearTimeout(poll); poll = null }
    await loadShares()
    const page = $('page')
    page.className = 'page patient-page share-page'
    $('docTitle').textContent = '家庭分享'
    renderList()
    page.innerHTML = `<div class="sh-head"><h1>家庭分享</h1>
      <p class="muted">家人在知家里分享给你所在科室（或指定给你）的档案：只读、有效期内可见，每次查看家人都能在访问记录里看到。家人允许时可以「纳入本院」，复制成本院患者。</p></div>
      ${shares.length ? `<div class="sh-cards">${shares.map(s => `<button class="sh-card" data-share="${esc(s.share_id)}">
        <div class="sh-card-t"><b>${esc(s.display_name || s.share_code)}</b><span class="pt-code">${esc(s.share_code)}</span>${s.to_me ? '<span class="pill ok">指定给我</span>' : ''}</div>
        <div class="muted small">${esc(s.department)} · ${esc(scopeText(s.scope))} · ${esc(s.expires_at.slice(0, 10))} 到期</div>
        <div class="muted small">${s.imported ? '已纳入本院' : s.allow_import ? '家人允许纳入本院' : '仅查看'}</div></button>`).join('')}</div>`
        : '<p class="muted">还没有收到家庭分享。家人在知家里选「本院 → 你所在的科室」分享后会出现在这里；科室由机构管理员在「机构管理」里设置。</p>'}`
    page.querySelectorAll<HTMLElement>('[data-share]').forEach(b => b.addEventListener('click', () => void openShare(b.dataset.share!)))
    if (focus) await openShare(focus)
  }

  async function openShare(id: string): Promise<void> {
    const page = $('page')
    let v: ShareDetail
    try { v = await api<ShareDetail>(`/api/shares/${id}`) } catch (err) { notice((err as Error).message, true); await openShares(); return }
    page.className = 'page patient-page share-page'
    const who = v.display_name || v.share_code
    $('docTitle').textContent = `家庭分享 · ${who}`
    const labsRows = v.latest_labs.map(l => `<tr><td>${esc(l.test_name)}</td><td class="${l.flag ? 'pt-flag' : ''}">${esc(stdValue(l))} ${esc(l.std_unit ?? l.unit ?? '')}${l.flag === 'H' ? ' ↑' : l.flag === 'L' ? ' ↓' : ''}</td>
      <td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td><td class="muted small">${l.source === 'manual' ? '家人手工录入' : '来自报告'}</td></tr>`).join('')
    page.innerHTML = `<div class="sh-head"><button class="link-btn" data-back>← 家庭分享</button>
        <h1>${esc(who)} <span class="pt-code">${esc(v.share_code)}</span></h1>
        <div class="muted">${[v.sex ? SEX[v.sex] : '', v.birth_year ? `${new Date().getFullYear() - v.birth_year} 岁` : '', ...v.tags].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="muted small">发给 ${esc(v.department)}${v.to_me ? '（指定给你）' : ''} · 范围：${esc(scopeText(v.scope))} · ${esc(v.expires_at.slice(0, 10))} 到期 · 只读，家人能看到你的查看记录</div>
        <div class="row">${v.imported ? `<button data-open-imported="${esc(v.imported.patient_id ?? '')}">已纳入本院 · 打开患者</button>` : v.allow_import ? '<button class="primary" data-import>纳入本院</button>' : '<span class="muted small">家人没有允许纳入本院病历</span>'}</div></div>
      ${v.scope.categories.includes('labs') ? `<section class="sh-sec"><h3 class="mem-h">化验（各项最近一次，共 ${v.lab_count} 条）</h3>${labsRows ? `<table class="users pt-labs"><thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th><th>来源</th></tr></thead><tbody>${labsRows}</tbody></table>
        <button class="small-btn" data-all-labs>看全部化验</button><div id="shAllLabs"></div>` : '<p class="muted">范围内没有化验</p>'}</section>` : ''}
      ${v.scope.categories.includes('reports') ? `<section class="sh-sec"><h3 class="mem-h">报告原件</h3>${v.records.length ? `<ul class="rs-list">${v.records.map(r => `<li class="rs-item"><span class="rs-kind">${esc(KIND[r.kind] ?? '报告')}</span><b>${esc(r.title)}</b><span class="muted small">${esc(r.report_date ?? '')}</span>
        ${r.file_id ? `<a class="small-btn" target="_blank" rel="noopener" href="/api/shares/${esc(v.share_id)}/files/${esc(r.file_id)}?token=${encodeURIComponent(hooks.token())}">看原件</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">范围内没有报告</p>'}</section>` : ''}
      ${v.scope.categories.includes('docs') ? `<section class="sh-sec"><h3 class="mem-h">就诊简报与健康档案</h3>${v.documents.length ? `<ul class="rs-list">${v.documents.map(d => `<li class="rs-item"><span class="rs-kind">${esc(d.kind === 'brief' ? '就诊简报' : d.kind === 'archive' ? '健康档案' : '文档')}</span><b>${esc(d.title)}</b><span class="muted small">${esc(d.updated_at.slice(0, 10))}</span>
        <button class="small-btn" data-doc="${esc(d.doc_id)}">阅读</button></li>`).join('')}</ul><div id="shDoc"></div>` : '<p class="muted">没有简报或档案</p>'}</section>` : ''}`
    page.querySelector('[data-back]')!.addEventListener('click', () => void openShares())
    page.querySelector('[data-all-labs]')?.addEventListener('click', async () => {
      try {
        const all = await api<Lab[]>(`/api/shares/${id}/labs`)
        $('shAllLabs').innerHTML = `<table class="users pt-labs"><thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th></tr></thead><tbody>${all.map(l => `<tr><td>${esc(l.test_name)}</td><td>${esc(stdValue(l))} ${esc(l.std_unit ?? l.unit ?? '')}</td><td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td></tr>`).join('')}</tbody></table>`
      } catch (err) { notice((err as Error).message, true) }
    })
    page.querySelectorAll<HTMLElement>('[data-doc]').forEach(b => b.addEventListener('click', async () => {
      try {
        const d = await api<{ title: string; html: string }>(`/api/shares/${id}/docs/${b.dataset.doc}`)
        $('shDoc').innerHTML = `<div class="sh-doc"><div class="sh-doc-t"><b>${esc(d.title)}</b><span class="muted small">只读</span></div><div class="ProseMirror sh-doc-body">${d.html}</div></div>`
      } catch (err) { notice((err as Error).message, true) }
    }))
    page.querySelector('[data-import]')?.addEventListener('click', async () => {
      if (!await askConfirm({ title: '纳入本院', message: `把「${who}」复制成本院患者（新代号，你是负责人）：化验、报告原件、简报一并复制并标明来自家庭分享。纳入后归本院管理，家人撤销分享不影响已纳入的部分。`, confirm: '纳入本院' })) return
      try {
        const p = await api<Patient>(`/api/shares/${id}/import`, { method: 'POST' })
        notice(`已纳入本院：${p.code}`)
        await loadList()
        await openPatient(p.id)
      } catch (err) { notice((err as Error).message, true) }
    })
    page.querySelector<HTMLElement>('[data-open-imported]')?.addEventListener('click', e => { const pid = (e.currentTarget as HTMLElement).dataset.openImported; if (pid) void openPatient(pid) })
  }

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
    </div>${photoFigure('patients')}`
  }

  document.getElementById('page')!.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pw]')
    if (!b || !document.getElementById('page')!.classList.contains('pt-welcome')) return
    if (b.dataset.pw === 'new') void createPatient()
    else if (list[0]) void openPatient(list[0].id)
  })

  // —— 左栏页签 ——

  $('newPatientBig').onclick = () => void createPatient()
  $('patientList').onclick = e => {
    const t = e.target as HTMLElement
    if (t.closest('#breakGlassBtn')) { void breakGlass(); return }
    if (t.closest('[data-shares]')) { void openShares(); return }
    const li = t.closest<HTMLElement>('li[data-pt]')
    if (li) void openPatient(li.dataset.pt!)
  }
  document.getElementById('docSearch')!.addEventListener('input', () => { if (!$('patientList').hidden) renderList() })

  // —— 对话框下方：「引用患者」（任意文档的对话里把患者带给 AI；只列诊疗组里的，紧急访问的不列） ——
  let picked: Array<{ id: string; label: string }> = []
  const pickedBox = () => document.getElementById('ptPicked')!
  function renderPicked(): void {
    pickedBox().hidden = picked.length === 0
    pickedBox().innerHTML = picked.map(p => `<span class="chip" data-id="${p.id}" title="AI 会读这位患者的资料与化验">⚕ ${esc(p.label)}<button class="chip-x" aria-label="移除">✕</button></span>`).join('')
  }
  pickedBox().onclick = e => {
    const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
    if (id) { picked = picked.filter(p => p.id !== id); renderPicked() }
  }
  document.getElementById('ptPickBtn')!.onclick = async e => {
    const anchor = e.currentTarget as HTMLElement
    document.querySelector('.kb-picker')?.remove()
    let all: Patient[] = []
    try { all = (await api<Patient[]>('/api/patients')).filter(p => p.role !== 'break_glass') } catch (err) { notice((err as Error).message, true); return }
    const menu = document.createElement('div')
    menu.className = 'pop-menu kb-picker'
    menu.innerHTML = all.length === 0
      ? '<div class="muted small kb-picker-empty">诊疗组里还没有患者</div>'
      : all.map(p => `<label><input type="checkbox" value="${p.id}" ${picked.some(x => x.id === p.id) ? 'checked' : ''}> ${esc(label(p))} <span class="muted small">${esc(p.tags.slice(0, 2).join('、'))}</span></label>`).join('')
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, r.left)}px`
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`
    menu.onchange = ev => {
      const box = ev.target as HTMLInputElement
      const p = all.find(y => y.id === box.value)!
      picked = box.checked ? [...picked, { id: p.id, label: label(p) }].slice(0, 10) : picked.filter(x => x.id !== p.id)
      renderPicked()
    }
    const done = () => { menu.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey) }
    const away = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node) && ev.target !== anchor) done() }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') done() }
    setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', onKey) })
  }

  return {
    /** 发送对话时取走「引用患者」（发送后清空） */
    takePicked(): string[] { const ids = picked.map(p => p.id); picked = []; renderPicked(); return ids },
    /** 机构开了患者模块才显示「＋ 引用患者」 */
    setPickEnabled(on: boolean): void { document.getElementById('ptPickBtn')!.hidden = !on },
    /** 打开文档时：患者页失效 */
    leave(): void { current = null; if (poll) { clearTimeout(poll); poll = null } if (!$('patientList').hidden) renderList() },
    /** 打开患者页（从病例报告回到患者） */
    async open(id: string): Promise<void> { hooks.goSpace('patients'); await openPatient(id) },
    /** 进入患者空间（左侧图标栏）：刷新列表；中间区域空闲时显示患者引导 */
    async enter(idle: boolean): Promise<void> {
      if (idle && current && document.getElementById('page')!.classList.contains('patient-page') && !document.getElementById('page')!.classList.contains('pt-welcome')) { await loadList(); return }
      current = null
      await loadList()
      // 列表加载期间已经打开了某位患者（从研究页 / 病例报告跳过来）：不要再用引导页盖掉
      if (idle && current === null && !document.getElementById('page')!.classList.contains('share-page')) showWelcome()
    },
  }
}
