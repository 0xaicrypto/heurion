/**
 * 临床研究（工作空间）：研究项目把方案、数据集、分析、稿件放在一起；入组患者（从患者库筛选）是第三期。
 * 这一版：开始页与研究列表（研究项目的增删改见后续提交）。
 */
type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function initResearch(api: Api, _notice: Notice) {
  const $ = (id: string) => document.getElementById(id)!
  let list: Array<{ id: string; title: string; design: string | null; status: string }> = []

  async function loadList(): Promise<void> {
    try { list = await api('/api/studies') } catch { list = [] }
    $('studyList').innerHTML = list.map(s => `<li data-study="${s.id}" title="${esc(s.title)}"><span class="label">${esc(s.title)}</span></li>`).join('')
      + (list.length === 0 ? '<li class="nav-empty">还没有研究项目。</li>' : '')
  }

  function showWelcome(): void {
    const page = $('page')
    page.className = 'page study-page rs-welcome'
    $('docTitle').textContent = '临床研究'
    page.innerHTML = `<div class="pt-welcome-body">
      <span class="pt-code big">STUDY</span>
      <h1>${list.length ? '选择一个研究项目' : '新建第一个研究项目'}</h1>
      <p class="muted">一个研究项目把方案、数据、分析和稿件放在一起：AI 分析时自动用这个研究的数据集，写论文时能直接引用分析结果。</p>
      <ol class="pt-steps">
        <li><b>研究方案</b><span>研究设计、纳入排除标准、终点，AI 可以帮你起草与完善。</span></li>
        <li><b>数据集</b><span>上传 CSV、Excel、SAS、SPSS、Stata；身份信息的列处理后才能分析。</span></li>
        <li><b>分析</b><span>Table 1、生存曲线、回归……每张图都能看到代码与数据来源。</span></li>
        <li><b>稿件</b><span>论文、组会汇报幻灯片，写作时直接引用分析结果。</span></li>
        <li><b>入组患者</b><span>从患者库按条件筛选入组（下一期）。</span></li>
      </ol>
    </div>`
  }

  return {
    async enter(idle: boolean): Promise<void> {
      await loadList()
      if (idle) showWelcome()
    },
    leave(): void { /* 研究页离开时无状态需要清理（研究页面见后续提交） */ },
  }
}
