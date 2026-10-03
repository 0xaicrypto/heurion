/**
 * 临床研究（工作空间）：研究项目列表与研究页——研究方案、数据集、分析（用研究数据集画的图，自动汇总）、稿件、入组患者。
 * 入组：按条件筛选诊疗组里的患者 → 预览（代号 + 匹配依据）→ 勾选入组（研究编号 S001…）→ 生成研究数据集（只有研究编号）。
 * 新建方案 / 论文 / 幻灯片：新建文档并归入研究，打开后把建议的指令填进对话框（由人改好再发送）。
 */
import { photoFigure } from './photos.ts'
import { askConfirm } from './dialogs.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

interface StudyLite { id: string; title: string; design: string | null; status: 'planning' | 'ongoing' | 'completed'; docs: number; datasets: number }
interface Study {
  id: string; title: string; design: string | null; status: StudyLite['status']; summary: string | null; design_label: string | null; status_label: string; updated_at: string
  docs: Array<{ doc_id: string; title: string; kind: 'doc' | 'deck'; role: string; updated_at: string }>
  datasets: Array<{ dataset_id: string; name: string; format: string; rows: number; cols: number; status: string; version?: number; cohort?: { shape: string } | null }>
  analyses: Array<{ asset_id: string; name: string; created_at: string; datasets: string[]; has_code: boolean }>
}

export interface ResearchHooks {
  openDoc(id: string): Promise<void>
  /** 离开当前文档（研究页占用中间区域时） */
  leaveDoc(): void
  prefillChat(text: string): void
  goSpace(space: 'research'): void
  token(): string
  datasets: { upload(files: File[]): Promise<Array<{ id: string }>>; openDetail(id: string): Promise<void>; showProvenance(assetId: string): Promise<void> }
  /** 打开患者页（入组名单里点代号） */
  openPatient?(id: string): Promise<void>
}

interface Cohort {
  active: number
  subjects: Array<{ subject_id: string; patient_id: string; code: string | null; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_at: string; status: string }>
  pending: Array<{ proposal_id: string; patient_id: string; code: string | null; kind: string; reason: string }>
  datasets: Array<{ dataset_id: string; name: string; shape: string; version: number; rows: number; status: string; generated_at: string; latest: boolean; stale: boolean | null }>
}
interface Candidate { patient_id: string; code: string; sex: string | null; age: number | null; tags: string[]; matched: string[]; subject_id: string | null }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const DESIGNS: Record<string, string> = { retrospective_cohort: '回顾性队列', prospective_cohort: '前瞻性队列', rct: '随机对照试验', case_control: '病例对照', cross_sectional: '横断面', other: '其他' }
const STATUS: Record<string, string> = { planning: '筹备中', ongoing: '进行中', completed: '已完成' }
const ROLES: Record<string, string> = { protocol: '研究方案', manuscript: '论文', slides: '幻灯片', other: '其他文档' }
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-CN')
const SEX: Record<string, string> = { M: '男', F: '女' }

export function initResearch(api: Api, notice: Notice, hooks: ResearchHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let list: StudyLite[] = []
  let current: string | null = null
  let poll: ReturnType<typeof setTimeout> | null = null

  // —— 左栏 ——

  async function loadList(): Promise<void> {
    try { list = await api<StudyLite[]>('/api/studies') } catch { list = [] }
    renderList()
  }

  function renderList(): void {
    const q = ($('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = list.filter(s => !q || s.title.toLowerCase().includes(q))
    $('studyList').innerHTML = shown.map(s => `<li data-study="${s.id}" class="hit${s.id === current ? ' active' : ''}" title="${esc(s.title)}">
        <span class="hit-text"><span class="label">${esc(s.title)}</span><span class="snippet">${[s.design ? DESIGNS[s.design] : '', STATUS[s.status], `${s.datasets} 个数据集`].filter(Boolean).join(' · ')}</span></span></li>`).join('')
      + (list.length === 0 ? '<li class="nav-empty">还没有研究项目。点「＋ 新建研究」。</li>' : shown.length === 0 ? `<li class="nav-empty">没有找到「${esc(q)}」</li>` : '')
  }

  /** 新建研究：名称、设计、简介（一个小表单）。 */
  function createDialog(): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="新建研究">
      <div class="dialog-head"><h2>新建研究</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="studyForm">
        <label>研究名称<input type="text" name="title" required maxlength="120" placeholder="例如：SGLT2 抑制剂与 CKD3 患者 eGFR 下降"></label>
        <label>研究设计<select name="design"><option value="">（暂不确定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>简介（可选）<textarea name="summary" rows="3" placeholder="研究问题、人群、主要终点"></textarea></label>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">创建</button></div>
      </form></div>`
    dlg.hidden = false
    dlg.querySelector<HTMLInputElement>('input[name=title]')!.focus()
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    dlg.querySelector<HTMLFormElement>('#studyForm')!.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(e.target as HTMLFormElement)
      try {
        const s = await api<{ id: string }>('/api/studies', { method: 'POST', body: JSON.stringify({ title: f.get('title'), design: f.get('design') || null, summary: f.get('summary') }) })
        dlg.hidden = true; dlg.innerHTML = ''
        await loadList()
        await openStudy(s.id)
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  // —— 研究页 ——

  async function openStudy(id: string): Promise<void> {
    // 从研究里的文档回来、或在文档里点研究：先关掉文档（AI 栏收起，顶栏不再显示文档的东西）
    if (!$('page').classList.contains('study-page')) hooks.leaveDoc()
    current = id
    if (poll) { clearTimeout(poll); poll = null }
    let s: Study
    try { s = await api<Study>(`/api/studies/${id}`) } catch (err) { notice((err as Error).message, true); current = null; return }
    // 入组名单（机构没开患者模块时没有）
    let cohort: Cohort | null = null
    let cohortOff = ''
    try { cohort = await api<Cohort>(`/api/studies/${id}/cohort`) } catch (err) { cohortOff = (err as Error).message }
    const page = $('page')
    page.className = 'page study-page'
    $('docTitle').textContent = s.title
    renderList()
    const docsOf = (roles: string[]) => s.docs.filter(d => roles.includes(d.role))
    const docRow = (d: Study['docs'][number]) => `<li class="rs-item" data-opendoc="${d.doc_id}"><span class="rs-kind">${d.kind === 'deck' ? '幻灯片' : ROLES[d.role] ?? '文档'}</span><b>${esc(d.title)}</b><span class="muted small">更新于 ${date(d.updated_at)}</span>
        <button class="quiet small-btn" data-unlink="doc:${d.doc_id}" title="移出研究（文档回到写作的文档列表）">移出</button></li>`
    const protocols = docsOf(['protocol'])
    const manuscripts = docsOf(['manuscript', 'slides', 'other'])
    page.innerHTML = `
      <div class="rs-head">
        <input class="rs-title" id="rsTitle" value="${esc(s.title)}" aria-label="研究名称">
        <div class="row">
          <select id="rsDesign" aria-label="研究设计"><option value="">研究设计（未定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${s.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <select id="rsStatus" aria-label="状态">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${s.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <span class="grow"></span>
          <div class="menu-wrap"><button data-act="more" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="rsMore" hidden><button data-act="attach">归入已有文档…</button><button data-act="delete" class="danger-text">删除研究项目</button></div></div>
        </div>
        <textarea id="rsSummary" rows="2" placeholder="简介：研究问题、人群、暴露 / 干预、主要终点">${esc(s.summary ?? '')}</textarea>
      </div>
      <div class="rs-grid">
        <section class="rs-card">
          <div class="rs-card-head"><h3>研究方案</h3><button class="small-btn" data-new="protocol">＋ 新建方案</button></div>
          ${protocols.length ? `<ul class="rs-list">${protocols.map(docRow).join('')}</ul>` : '<p class="muted small">还没有研究方案。AI 可以依据你的研究问题起草：设计、纳入排除标准、终点、样本量、统计计划。</p>'}
        </section>
        <section class="rs-card">
          <div class="rs-card-head"><h3>数据集</h3><button class="small-btn" data-act="upload">＋ 上传数据</button><input type="file" id="rsUpload" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta" multiple hidden></div>
          ${s.datasets.length ? `<ul class="rs-list">${s.datasets.map(d => `<li class="rs-item" data-dataset="${d.dataset_id}"><span class="rs-kind">${esc(d.format)}</span><b>${esc(d.name)}</b>
            <span class="muted small">${d.status === 'ready' ? `${d.rows.toLocaleString()} 行 × ${d.cols} 列` : d.status === 'review' ? '<span class="flag-L">待处理身份信息</span>' : d.status === 'failed' ? '<span class="flag-H">导入失败</span>' : '处理中…'}</span>
            <button class="quiet small-btn" data-unlink="dataset:${d.dataset_id}" title="移出研究（数据集仍在「全部数据集」里）">移出</button></li>`).join('')}</ul>`
            : '<p class="muted small">上传 CSV、Excel、SAS、SPSS、Stata。在这个研究的文档里和 AI 对话时，会自动带上这些数据集。</p>'}
        </section>
        <section class="rs-card wide">
          <div class="rs-card-head"><h3>分析</h3><span class="muted small">用本研究数据集画的图，点开看代码与数据来源</span></div>
          ${s.analyses.length ? `<div class="rs-analyses">${s.analyses.map(a => `<button class="rs-fig" data-fig="${a.asset_id}" title="${esc(a.name)}"><img src="/api/assets/${a.asset_id}?token=${encodeURIComponent(hooks.token())}" alt="${esc(a.name)}"><span>${esc(a.name.split('/').pop())}<br><span class="muted">${esc(a.datasets.join('、'))} · ${date(a.created_at)}</span></span></button>`).join('')}</div>`
            : '<p class="muted small">还没有分析。打开论文或新建一份文档，在对话里让 AI 用研究数据做 Table 1、生存曲线、回归，画的图会出现在这里。</p>'}
        </section>
        <section class="rs-card wide">
          <div class="rs-card-head"><h3>稿件</h3><button class="small-btn" data-new="manuscript">＋ 新建论文</button><button class="small-btn" data-new="slides">＋ 新建幻灯片</button></div>
          ${manuscripts.length ? `<ul class="rs-list">${manuscripts.map(docRow).join('')}</ul>` : '<p class="muted small">论文、组会汇报幻灯片。写作时可以直接引用上面的分析结果。</p>'}
        </section>
        ${cohortCard(cohort, cohortOff)}
      </div>`
    // 数据集还在处理：隔几秒刷新
    if (s.datasets.some(d => d.status === 'processing')) poll = setTimeout(() => { if (current === id) void openStudy(id) }, 2500)
  }

  /** 入组患者卡片：入组名单、待确认的 AI 入组提议、研究数据集（过期提示）。 */
  function cohortCard(c: Cohort | null, off: string): string {
    if (!c) return `<section class="rs-card wide"><div class="rs-card-head"><h3>入组患者</h3></div><p class="muted small">${esc(off || '研究入组需要启用患者模块')}</p></section>`
    const active = c.subjects.filter(x => x.status === 'active')
    const sets = c.datasets.filter(d => d.latest)
    const SHAPE: Record<string, string> = { wide: '宽表', long: '长表' }
    return `<section class="rs-card wide" id="rsCohort">
      <div class="rs-card-head"><h3>入组患者${active.length ? `<span class="muted small"> · ${active.length} 人</span>` : ''}</h3>
        <button class="small-btn" data-act="screen">＋ 筛选入组</button>${active.length ? '<button class="small-btn" data-act="gen">生成研究数据集</button>' : ''}</div>
      ${c.pending.length ? `<div class="banner pt-pending"><span class="dot"></span>AI 建议了 ${c.pending.length} 项入组 / 移出，待你确认</div>
        <ul class="rs-list">${c.pending.map(p => `<li class="rs-item"><span class="rs-kind">${p.kind === 'enroll' ? '入组' : '移出'}</span><b>${esc(p.code ?? '—')}</b><span class="muted small">${esc(p.reason)}</span>
          <button class="small-btn primary" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="accept">确认</button><button class="quiet small-btn" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="reject">不采纳</button></li>`).join('')}</ul>` : ''}
      ${sets.map(d => `<div class="rs-cohort-ds${d.stale ? ' stale' : ''}" data-dataset="${d.dataset_id}"><span class="rs-kind">${SHAPE[d.shape] ?? d.shape} v${d.version}</span>
        <span>${esc(d.name)} <span class="muted small">${d.rows} 行 · ${date(d.generated_at)}</span></span>
        ${d.stale ? `<span class="flag-L small">入组或化验有变化，数据集已过期</span><button class="small-btn" data-regen="${d.shape}">刷新</button>` : '<span class="muted small">最新</span>'}</div>`).join('')}
      ${c.subjects.length ? `<div class="ds-scroll"><table class="users rs-subjects"><thead><tr><th>研究编号</th><th>代号</th><th>性别</th><th>入组时年龄</th><th>诊断标签</th><th>入组日期</th><th></th></tr></thead><tbody>
        ${c.subjects.map(x => `<tr class="${x.status === 'active' ? '' : 'muted'}"><td><b>${esc(x.subject_id)}</b></td>
          <td>${x.code ? `<button class="linkish" data-patient="${x.patient_id}">${esc(x.code)}</button>` : '<span class="muted" title="你已不在这位患者的诊疗组里">—</span>'}</td>
          <td>${esc(SEX[x.sex ?? ''] ?? '')}</td><td>${x.age_at_enroll ?? ''}</td><td>${esc(x.tags.join('、'))}</td><td>${date(x.enrolled_at)}</td>
          <td>${x.status === 'active' ? `<button class="quiet small-btn" data-unenroll="${x.patient_id}" data-subject="${esc(x.subject_id)}">移出</button>` : '<span class="small">已移出</span>'}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted small">按性别、年龄、诊断标签、化验结果、检查日期从你在诊疗组里的患者中筛选入组；每人得到研究编号（S001…），生成的研究数据集里只有研究编号，没有代号。</p>'}
    </section>`
  }

  /** 筛选入组：条件 → 预览（代号 + 匹配依据）→ 勾选 → 入组。 */
  function screenDialog(studyId: string): void {
    const dlg = $('dialog')
    const labRow = () => `<div class="row rs-labrow"><input name="lab_test" placeholder="化验项目，如 肌酐 / HbA1c" list="rsTests"><select name="lab_mode"><option value="latest">最近一次</option><option value="any">任一次</option></select>
      <select name="lab_op"><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option><option>=</option></select><input name="lab_value" type="number" step="any" placeholder="阈值（标准单位）"><button type="button" class="quiet" data-dellab aria-label="删除这条">✕</button></div>`
    dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="筛选入组">
      <div class="dialog-head"><h2>筛选入组</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="screenForm">
        <div class="muted small">在你在诊疗组里的在管患者中筛选。化验用换算到标准单位后的已确认值（肌酐 µmol/L、血糖 mmol/L、血红蛋白 g/L…）。</div>
        <div class="row"><label>性别<select name="sex"><option value="">不限</option><option value="M">男</option><option value="F">女</option></select></label>
          <label>年龄 ≥<input name="age_min" type="number" min="0" max="130"></label><label>年龄 ≤<input name="age_max" type="number" min="0" max="130"></label></div>
        <label>诊断标签包含（任一，逗号分隔）<input name="tags" placeholder="例如：CKD, 糖尿病"></label>
        <div><div class="muted small">化验条件（都要满足）</div><div id="rsLabs"></div><button type="button" class="small-btn" data-addlab>＋ 化验条件</button></div>
        <datalist id="rsTests"><option value="肌酐"><option value="eGFR"><option value="HbA1c"><option value="血糖"><option value="血红蛋白"><option value="ALT"><option value="AST"><option value="白蛋白"><option value="尿酸"><option value="LDL-C"></datalist>
        <div class="row"><label>化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
        <div class="row end"><button type="submit" class="primary">预览</button></div>
        <div id="rsPreview"></div>
      </form></div>`
    dlg.hidden = false
    const form = dlg.querySelector<HTMLFormElement>('#screenForm')!
    let lastCriteria: Record<string, unknown> = {}
    const criteria = () => {
      const f = new FormData(form)
      const num = (k: string) => (f.get(k) as string) ? Number(f.get(k)) : undefined
      const labs = [...form.querySelectorAll<HTMLElement>('.rs-labrow')].map(r => ({
        test: r.querySelector<HTMLInputElement>('[name=lab_test]')!.value.trim(), mode: r.querySelector<HTMLSelectElement>('[name=lab_mode]')!.value,
        op: r.querySelector<HTMLSelectElement>('[name=lab_op]')!.value, value: r.querySelector<HTMLInputElement>('[name=lab_value]')!.value,
      })).filter(l => l.test || l.value).map(l => ({ ...l, value: Number(l.value) }))
      return { sex: f.get('sex') || undefined, age_min: num('age_min'), age_max: num('age_max'), tags_any: String(f.get('tags') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean), labs, from: f.get('from') || undefined, to: f.get('to') || undefined }
    }
    dlg.onclick = async e => {
      const t = e.target as HTMLElement
      if (e.target === dlg || t.closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = ''; return }
      if (t.closest('[data-addlab]')) { $('rsLabs').insertAdjacentHTML('beforeend', labRow()); return }
      if (t.closest('[data-dellab]')) { t.closest('.rs-labrow')?.remove(); return }
      if (t.closest('[data-enroll]')) {
        const ids = [...form.querySelectorAll<HTMLInputElement>('input[name=pick]:checked')].map(i => i.value)
        if (!ids.length) { notice('先勾选要入组的患者', true); return }
        try {
          const r = await api<{ enrolled: unknown[]; proposed: unknown[]; skipped: Array<{ reason: string }> }>(`/api/studies/${studyId}/cohort`, { method: 'POST', body: JSON.stringify({ patient_ids: ids, criteria: lastCriteria }) })
          dlg.hidden = true; dlg.innerHTML = ''
          notice(`已入组 ${r.enrolled.length} 人${r.skipped.length ? `，跳过 ${r.skipped.length} 人（${[...new Set(r.skipped.map(x => x.reason))].join('；')}）` : ''}`)
          void openStudy(studyId)
        } catch (err) { notice((err as Error).message, true) }
      }
      if (t.closest('[data-pickall]')) { const on = (t as HTMLInputElement).checked; form.querySelectorAll<HTMLInputElement>('input[name=pick]:not(:disabled)').forEach(i => { i.checked = on }) }
    }
    dlg.onchange = null
    form.onsubmit = async e => {
      e.preventDefault()
      lastCriteria = criteria()
      try {
        const r = await api<{ total: number; patients: Candidate[] }>(`/api/studies/${studyId}/cohort/preview`, { method: 'POST', body: JSON.stringify(lastCriteria) })
        const fresh = r.patients.filter(p => !p.subject_id).length
        $('rsPreview').innerHTML = r.total === 0 ? '<div class="muted">没有符合条件的患者。</div>' : `
          <div class="rs-preview-head"><b>符合条件 ${r.total} 人</b>${fresh < r.total ? `<span class="muted small">（${r.total - fresh} 人已入组）</span>` : ''}</div>
          <div class="ds-scroll"><table class="users rs-candidates"><thead><tr><th><input type="checkbox" data-pickall checked aria-label="全选"></th><th>代号</th><th>性别</th><th>年龄</th><th>诊断标签</th><th>匹配依据</th></tr></thead><tbody>
          ${r.patients.map(p => `<tr><td><input type="checkbox" name="pick" value="${p.patient_id}"${p.subject_id ? ' disabled' : ' checked'} aria-label="${esc(p.code)}"></td><td><b>${esc(p.code)}</b>${p.subject_id ? ` <span class="muted small">已入组 ${esc(p.subject_id)}</span>` : ''}</td>
            <td>${esc(SEX[p.sex ?? ''] ?? '')}</td><td>${p.age ?? ''}</td><td>${esc(p.tags.join('、'))}</td><td class="small">${esc(p.matched.join('；') || '—')}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="row end"><button type="button" class="primary" data-enroll${fresh ? '' : ' disabled'}>入组选中的患者</button></div>`
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  /** 生成研究数据集：宽表 / 长表、化验项目、日期窗口。 */
  function datasetDialog(studyId: string, shape = 'wide'): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="生成研究数据集">
      <div class="dialog-head"><h2>生成研究数据集</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="genForm">
        <label>形状<select name="shape"><option value="wide"${shape === 'wide' ? ' selected' : ''}>宽表：每人一行（基线 / 最近值、次数）</option><option value="long"${shape === 'long' ? ' selected' : ''}>长表：每次化验一行</option></select></label>
        <label>化验项目（可选，逗号分隔；不填 = 全部）<input name="tests" placeholder="例如：肌酐, eGFR, HbA1c"></label>
        <div class="row"><label>化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
        <div class="muted small">数据集里只有研究编号，没有代号；数值统一换算到标准单位。之后入组或化验有变化会提示刷新，刷新生成新版本，旧版本保留。</div>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">生成</button></div>
      </form></div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    const form = dlg.querySelector<HTMLFormElement>('#genForm')!
    form.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(form)
      const btn = form.querySelector<HTMLButtonElement>('button.primary')!
      btn.disabled = true; btn.textContent = '生成中…'
      try {
        const r = await api<{ dataset: { name: string }; unchanged: boolean; skipped: string[] }>(`/api/studies/${studyId}/cohort/dataset`, { method: 'POST', body: JSON.stringify({
          shape: f.get('shape'), tests: String(f.get('tests') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean), from: f.get('from') || null, to: f.get('to') || null,
        }) })
        dlg.hidden = true; dlg.innerHTML = ''
        notice(r.unchanged ? `数据没有变化，沿用「${r.dataset.name}」` : `已生成「${r.dataset.name}」并归入研究${r.skipped.length ? `；${r.skipped.join('、')} 你已不在诊疗组里，没有包含` : ''}`)
        void openStudy(studyId); void loadList()
      } catch (err) { btn.disabled = false; btn.textContent = '生成'; notice((err as Error).message, true) }
    }
  }

  const PROMPTS: Record<string, (t: string) => string> = {
    protocol: t => `请为研究「${t}」起草一份研究方案：研究背景与目的、研究设计、研究人群（纳入与排除标准）、暴露 / 干预与对照、主要与次要终点、样本量估计、统计分析计划、伦理与数据管理。不确定的地方标「待定」，不要编造文献。`,
    manuscript: t => `请依据研究「${t}」的方案和已有分析，起草论文的方法与结果部分：结果段落只引用实际算出的数字，需要时用研究数据集补做分析（Table 1、主要终点分析）。`,
    slides: t => `请依据研究「${t}」做一份组会汇报幻灯片（6–8 页）：研究问题、设计、人群、主要结果（用已有分析的图）、局限与下一步。`,
  }

  async function newDoc(role: 'protocol' | 'manuscript' | 'slides', s: { id: string; title: string }): Promise<void> {
    try {
      const kind = role === 'slides' ? 'deck' : 'doc'
      const doc = await api<{ id: string }>('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${s.title} · ${ROLES[role]}`, kind }) })
      await api(`/api/studies/${s.id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'doc', ref_id: doc.id, role }) })
      current = null
      await hooks.openDoc(doc.id)
      hooks.prefillChat(PROMPTS[role]!(s.title))
      notice('已新建并归入研究。对话框里填好了建议的指令，可以修改后点「发送」')
    } catch (err) { notice((err as Error).message, true) }
  }

  async function attachExisting(s: { id: string }): Promise<void> {
    const docs = await api<Array<{ id: string; title: string; kind: string }>>('/api/docs')
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="归入已有文档">
      <div class="dialog-head"><h2>归入已有文档</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="attachForm">
        ${docs.length ? `<label>文档<select name="doc">${docs.map(d => `<option value="${d.id}">${esc(d.title)}${d.kind === 'deck' ? '（幻灯片）' : ''}</option>`).join('')}</select></label>
        <label>作为<select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <div class="muted small">归入后这份文档在研究里，不再出现在写作的文档列表；随时可以移出。</div>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">归入</button></div>` : '<div class="muted">写作里没有可归入的文档。</div>'}
      </form></div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    const form = dlg.querySelector<HTMLFormElement>('#attachForm')!
    form.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(form)
      try {
        await api(`/api/studies/${s.id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'doc', ref_id: f.get('doc'), role: f.get('role') }) })
        dlg.hidden = true; dlg.innerHTML = ''
        notice('已归入研究'); void openStudy(s.id); void loadList()
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  function showWelcome(): void {
    current = null
    const page = $('page')
    page.className = 'page study-page rs-welcome'
    $('docTitle').textContent = '临床研究'
    page.innerHTML = `<div class="pt-welcome-body">
      <span class="pt-code big">STUDY</span>
      <h1>${list.length ? '选择一个研究项目' : '新建第一个研究项目'}</h1>
      <p class="muted">一个研究项目把方案、数据、分析和稿件放在一起：在研究的文档里，AI 会自动用这个研究的数据集，写论文时能直接引用分析结果。</p>
      <ol class="pt-steps">
        <li><b>研究方案</b><span>研究设计、纳入排除标准、终点，AI 可以帮你起草与完善。</span></li>
        <li><b>数据集</b><span>上传 CSV、Excel、SAS、SPSS、Stata；身份信息的列处理后才能分析。</span></li>
        <li><b>分析</b><span>Table 1、生存曲线、回归……每张图都能看到代码与数据来源。</span></li>
        <li><b>稿件</b><span>论文、组会汇报幻灯片，写作时直接引用分析结果。</span></li>
        <li><b>入组患者</b><span>从患者库按条件筛选入组，生成只有研究编号的研究数据集。</span></li>
      </ol>
      <div class="row"><button class="primary" data-rw="new">＋ 新建研究</button>${list[0] ? `<button data-rw="open">打开「${esc(list[0].title)}」</button>` : ''}</div>
    </div>${photoFigure('research')}`
  }

  // —— 事件 ——

  $('page').addEventListener('click', async e => {
    const page = $('page')
    const t = e.target as HTMLElement
    if (page.classList.contains('rs-welcome')) {
      const b = t.closest<HTMLElement>('[data-rw]')
      if (b?.dataset.rw === 'new') createDialog()
      else if (b && list[0]) void openStudy(list[0].id)
      return
    }
    if (!current || !page.classList.contains('study-page')) return
    const id = current
    const s = { id, title: ($('rsTitle') as HTMLInputElement | null)?.value ?? '' }
    const unlink = t.closest<HTMLElement>('[data-unlink]')?.dataset.unlink
    if (unlink) {
      e.stopPropagation()
      const [kind, ref] = unlink.split(':')
      try { await api(`/api/studies/${id}/items/${kind}/${ref}`, { method: 'DELETE' }); notice(kind === 'doc' ? '已移出，文档回到写作的文档列表' : '已移出研究'); void openStudy(id); void loadList() }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const open = t.closest<HTMLElement>('[data-opendoc]')?.dataset.opendoc
    if (open) { current = null; await hooks.openDoc(open); return }
    const pt = t.closest<HTMLElement>('[data-patient]')?.dataset.patient
    if (pt && hooks.openPatient) { current = null; await hooks.openPatient(pt); return }
    const un = t.closest<HTMLElement>('[data-unenroll]')
    if (un) {
      if (!await askConfirm({ title: '移出研究', message: `把 ${un.dataset.subject} 移出研究？研究编号保留不复用，之后再入组会恢复同一编号；已生成的研究数据集会提示过期。`, confirm: '移出' })) return
      try { await api(`/api/studies/${id}/cohort/${un.dataset.unenroll}`, { method: 'DELETE' }); notice('已移出研究'); void openStudy(id) } catch (err) { notice((err as Error).message, true) }
      return
    }
    const prop = t.closest<HTMLElement>('[data-prop]')
    if (prop) {
      try { await api(`/api/patients/${prop.dataset.pt}/proposals/${prop.dataset.prop}/${prop.dataset.propx}`, { method: 'POST' }); notice(prop.dataset.propx === 'accept' ? '已确认' : '已不采纳'); void openStudy(id) }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const regen = t.closest<HTMLElement>('[data-regen]')?.dataset.regen
    if (regen) { datasetDialog(id, regen); return }
    const ds = t.closest<HTMLElement>('[data-dataset]')?.dataset.dataset
    if (ds) { await hooks.datasets.openDetail(ds); return }
    const fig = t.closest<HTMLElement>('[data-fig]')?.dataset.fig
    if (fig) { await hooks.datasets.showProvenance(fig); return }
    const nd = t.closest<HTMLElement>('[data-new]')?.dataset.new
    if (nd) { await newDoc(nd as 'protocol' | 'manuscript' | 'slides', s); return }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'more') { $('rsMore').hidden = !$('rsMore').hidden; return }
    if (act === 'upload') { ($('rsUpload') as HTMLInputElement).click(); return }
    if (act === 'screen') { screenDialog(id); return }
    if (act === 'gen') { datasetDialog(id); return }
    if (act === 'attach') { $('rsMore').hidden = true; await attachExisting(s); return }
    if (act === 'delete') {
      $('rsMore').hidden = true
      if (await askConfirm({ title: '删除研究项目', message: `删除「${s.title}」？研究里的方案、论文、幻灯片会一起移到回收站（可以恢复）；数据集保留在「全部数据集」里。`, confirm: '删除', danger: true })) {
        await api(`/api/studies/${id}`, { method: 'DELETE' }); await loadList(); showWelcome()
      }
    }
  })

  $('page').addEventListener('change', async e => {
    if (!current || !$('page').classList.contains('study-page')) return
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const id = current
    if (el.id === 'rsUpload') {
      const files = Array.from((el as HTMLInputElement).files ?? [])
      ;(el as HTMLInputElement).value = ''
      const done = await hooks.datasets.upload(files)
      for (const d of done) await api(`/api/studies/${id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'dataset', ref_id: d.id }) }).catch(err => notice((err as Error).message, true))
      if (done.length) notice('已上传并归入研究，正在处理；有身份信息的列时，点开数据集处理')
      void openStudy(id); void loadList()
      return
    }
    const patch = el.id === 'rsTitle' ? { title: el.value } : el.id === 'rsDesign' ? { design: el.value || null } : el.id === 'rsStatus' ? { status: el.value } : el.id === 'rsSummary' ? { summary: el.value } : null
    if (!patch) return
    try { await api(`/api/studies/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); if ('title' in patch) $('docTitle').textContent = el.value; void loadList() }
    catch (err) { notice((err as Error).message, true) }
  })

  $('studyList').onclick = e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-study]')
    if (li) void openStudy(li.dataset.study!)
  }
  $('newStudy').onclick = () => createDialog()
  $('docSearch').addEventListener('input', () => { if (!$('studyList').hidden) renderList() })

  return {
    async enter(idle: boolean): Promise<void> {
      await loadList()
      if (idle && current && $('page').classList.contains('study-page') && !$('page').classList.contains('rs-welcome')) return
      if (idle) showWelcome()
    },
    leave(): void { current = null; if (poll) { clearTimeout(poll); poll = null } },
    /** 从研究里的文档回到研究页 */
    async open(id: string): Promise<void> { hooks.goSpace('research'); await openStudy(id) },
  }
}
