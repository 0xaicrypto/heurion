/**
 * 记忆（R3，参考 Claude 的记忆设计）：记忆页（待确认、已生效、编辑删除、出处、导出导入、暂停 / 清空）、
 * 对话里的「记住这条？」卡片、对话框的「本轮不用记忆」。
 */
import { askConfirm, askText } from './dialogs.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>

interface Memory {
  id: string; scope: 'global' | 'project'; project_id: string | null; kind: 'preference' | 'fact' | 'style' | 'term'
  content: string; reason: string | null; source: 'turn' | 'comment' | 'manual' | 'import'; source_doc_id: string | null; source_doc_title: string | null
  status: 'proposed' | 'active'; explicit: number; updated_at: string
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const KINDS: Record<Memory['kind'], string> = { preference: '偏好', fact: '事实', style: '写法', term: '术语' }
const SOURCE: Record<Memory['source'], string> = { turn: '对话', comment: '评论', manual: '手动添加', import: '导入' }

export function initMemory(api: Api, notice: (msg: string, error?: boolean) => void, openDoc: (id: string) => void) {
  const dlg = () => document.getElementById('dialog')!

  async function openMemory(): Promise<void> {
    const [data, projects] = await Promise.all([api<{ enabled: boolean; instance: boolean; paused: boolean; items: Memory[] }>('/api/memory'), api<Array<{ id: string; name: string }>>('/api/projects')])
    const projectName = (id: string | null) => projects.find(p => p.id === id)?.name ?? '项目'
    const proposed = data.items.filter(m => m.status === 'proposed')
    const active = data.items.filter(m => m.status === 'active')
    const origin = (m: Memory) => [
      m.scope === 'project' ? `<span class="pill">${esc(projectName(m.project_id))}</span>` : '<span class="pill">全局</span>',
      `来自${SOURCE[m.source]}`,
      m.source_doc_id ? `<a href="#" data-doc="${esc(m.source_doc_id)}">《${esc(m.source_doc_title ?? '已删除的文档')}》</a>` : '',
    ].filter(Boolean).join(' · ')
    const row = (m: Memory) => `<li class="mem" data-id="${m.id}">
        <div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
        <div class="muted small">${origin(m)}${m.reason ? ` · ${esc(m.reason)}` : ''}</div>
        <div class="actions-row">${m.status === 'proposed'
          ? '<button class="primary" data-act="accept">采纳</button><button data-act="edit">改写</button><button data-act="reject">拒绝</button>'
          : '<button data-act="edit">编辑</button><button data-act="delete" class="danger">删除</button>'}</div></li>`

    const d = dlg()
    d.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="记忆">
      <div class="dialog-head"><h2>记忆</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted">AI 会记住你确认过的写作偏好、术语和常用事实，在之后的对话里照做。不会记住患者信息或账号。</div>
        ${!data.instance ? '<div class="mem-banner">管理员已停用记忆。</div>' : `<div class="row">
          <label class="toggle"><input type="checkbox" id="memOn" ${data.paused ? '' : 'checked'}> 使用记忆</label>
          <span class="muted small">${data.paused ? '已暂停：保留已有记忆，但对话里不使用、也不提议新的。' : ''}</span>
          <span class="grow"></span><button id="memAdd">＋ 添加</button></div>`}
        ${proposed.length ? `<h3 class="mem-h">待确认（${proposed.length}）</h3><ul class="mem-list">${proposed.map(row).join('')}</ul>` : ''}
        <h3 class="mem-h">已生效（${active.length}）</h3>
        ${active.length ? `<ul class="mem-list">${active.map(row).join('')}</ul>` : '<div class="muted">还没有记忆。对话里说「记住……」，或点「＋ 添加」。</div>'}
        <div class="row mem-foot"><button id="memExport">导出</button><button id="memImport">导入</button><input id="memImportFile" type="file" accept=".json,application/json" hidden>
          <span class="grow"></span><button id="memClear" class="danger">清空全部记忆</button></div>
      </div></div>`
    d.hidden = false

    const reopen = () => void openMemory()
    const on = d.querySelector<HTMLInputElement>('#memOn')
    if (on) on.onchange = async () => { await api('/api/memory/settings', { method: 'PUT', body: JSON.stringify({ paused: !on.checked }) }); notice(on.checked ? '已恢复使用记忆' : '已暂停记忆'); reopen() }
    const add = d.querySelector<HTMLButtonElement>('#memAdd')
    if (add) add.onclick = async () => {
      const content = await askText({ title: '添加记忆', label: '一条偏好、写法、术语或事实', placeholder: '例如：数值保留两位小数', confirm: '添加', hint: '写成以后可以直接照做的规则；不要写患者信息。' })
      if (content?.trim()) await api('/api/memory', { method: 'POST', body: JSON.stringify({ content, kind: 'preference' }) }).then(() => notice('已添加'), err => notice((err as Error).message, true))
      reopen()
    }
    d.querySelector<HTMLButtonElement>('#memExport')!.onclick = async () => {
      const text = await api<string | object>('/api/memory-export')
      const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text, null, 2)], { type: 'application/json' })
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'heurion-memory.json' })
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }
    const file = d.querySelector<HTMLInputElement>('#memImportFile')!
    d.querySelector<HTMLButtonElement>('#memImport')!.onclick = () => file.click()
    file.onchange = async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        const r = await api<{ added: number; skipped: Array<{ reason: string }> }>('/api/memory-import', { method: 'POST', body: await f.text() })
        notice(`导入 ${r.added} 条到「待确认」${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}`)
      } catch (err) { notice(`导入失败：${(err as Error).message}`, true) }
      reopen()
    }
    d.querySelector<HTMLButtonElement>('#memClear')!.onclick = async () => {
      d.hidden = true
      if (await askConfirm({ title: '清空全部记忆', message: '彻底删除你的所有记忆（包括待确认的），不可恢复。', confirm: '清空', danger: true })) {
        const r = await api<{ deleted: number }>('/api/memory', { method: 'DELETE' })
        notice(`已删除 ${r.deleted} 条记忆`)
      }
      reopen()
    }
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { d.hidden = true; d.innerHTML = ''; return }
      const link = t.closest<HTMLElement>('[data-doc]')
      if (link) { e.preventDefault(); d.hidden = true; openDoc(link.dataset.doc!); return }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
      const m = data.items.find(x => x.id === t.closest<HTMLElement>('li[data-id]')?.dataset.id)
      if (!act || !m) return
      if (act === 'delete') {
        d.hidden = true
        if (await askConfirm({ title: '删除记忆', message: `删除「${m.content}」？之后的对话不再使用它。`, confirm: '删除', danger: true })) await api(`/api/memory/${m.id}`, { method: 'DELETE' })
        reopen()
        return
      }
      if (act === 'edit') {
        d.hidden = true
        const content = await askText({ title: m.status === 'proposed' ? '改写后采纳' : '编辑记忆', label: KINDS[m.kind], value: m.content, confirm: '保存' })
        if (content?.trim()) await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content, status: 'active' }) }).catch(err => notice((err as Error).message, true))
        reopen()
        return
      }
      await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: act === 'accept' ? 'active' : 'rejected' }) })
      notice(act === 'accept' ? '已记住' : '已拒绝，不会再提议这条')
      reopen()
    }
  }

  /** 对话里 AI 提议（或按用户要求记下）一条记忆时的卡片。 */
  function memoryCard(ev: { result: 'proposed' | 'active'; memory: Memory }): HTMLElement {
    const m = ev.memory
    const card = document.createElement('div')
    card.className = 'mem-card'
    const done = (text: string) => { card.querySelector('.actions-row')!.outerHTML = `<div class="muted small">${esc(text)}</div>` }
    card.innerHTML = ev.result === 'active'
      ? `<div class="mem-card-head">已记住</div><div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
         <div class="actions-row"><button data-act="undo">撤销</button><button data-act="manage">管理记忆</button></div>`
      : `<div class="mem-card-head">记住这条？</div><div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
         ${m.reason ? `<div class="muted small">${esc(m.reason)}</div>` : ''}
         <div class="actions-row"><button class="primary" data-act="accept">记住</button><button data-act="edit">改写</button><button data-act="reject">不用</button></div>`
    card.onclick = async e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (!act) return
      try {
        if (act === 'manage') { void openMemory(); return }
        if (act === 'undo') { await api(`/api/memory/${m.id}`, { method: 'DELETE' }); done('已撤销，不会记住这条'); return }
        if (act === 'edit') {
          const content = await askText({ title: '改写后记住', label: KINDS[m.kind], value: m.content, confirm: '记住' })
          if (!content?.trim()) return
          await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content, status: 'active' }) })
          done(`已记住：${content.trim()}`)
          return
        }
        await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: act === 'accept' ? 'active' : 'rejected' }) })
        done(act === 'accept' ? '已记住，之后的对话会照做' : '好的，不记这条')
      } catch (err) { notice((err as Error).message, true) }
    }
    return card
  }

  document.getElementById('userMenuMemory')!.onclick = () => { document.getElementById('userMenu')!.hidden = true; void openMemory() }

  return {
    openMemory,
    memoryCard,
    /** 本轮是否使用记忆（对话框里的开关；发送后恢复默认）。 */
    takeMemoryFlag(): boolean {
      const box = document.getElementById('noMemory') as HTMLInputElement
      const off = box.checked
      box.checked = false
      return !off
    },
  }
}
