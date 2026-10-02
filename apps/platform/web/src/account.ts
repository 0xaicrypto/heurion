/**
 * 账户界面（MIGRATION_PLAN.md §2.5 R1）：登录 / 注册页、左栏底部的用户菜单、个人设置、管理员的用户管理。
 * 令牌存 localStorage（heurion.token）；任何接口返回 401 都回到登录页。
 */

const KEY = 'heurion.token'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export interface Me {
  id: string
  username: string
  display_name: string
  email: string | null
  role: 'user' | 'admin'
  dev?: boolean
  dev_mode: boolean
}

export const storedToken = (): string => {
  try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch { /* 无痕模式等：只在本页有效 */ }
}

/** 未登录 / 令牌失效：清掉令牌，显示登录页。 */
export function signOut(): void {
  saveToken(null)
  location.reload()
}

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

// —— 防机器人：工作量证明（服务端见 src/auth/bot-guard.ts） ——

interface Challenge { challenge: string; salt: string; maxnumber: number; signature: string }

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(h => parseInt(h, 16)))

/** 领题并穷举 n 使 SHA-256(salt + n) = challenge（Web Crypto，异步分批，不卡页面）。 */
async function solvePow(): Promise<{ solution: { challenge: string; salt: string; number: number; signature: string }; fetchedAt: number }> {
  const fetchedAt = Date.now()
  const c = await fetch('/api/auth/challenge', { cache: 'no-store' }).then(r => r.json()) as Challenge
  const target = hexBytes(c.challenge)
  const enc = new TextEncoder()
  for (let n = 0; n <= c.maxnumber; n++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(c.salt + n)))
    let same = true
    for (let i = 0; i < 32 && same; i++) same = digest[i] === target[i]
    if (same) return { solution: { challenge: c.challenge, salt: c.salt, number: n, signature: c.signature }, fetchedAt }
  }
  throw new Error('人机校验失败，请刷新页面')
}

// —— 登录 / 注册 ——

export async function showAuthScreen(): Promise<void> {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ has_users: true, dev_mode: false })) as { has_users: boolean; dev_mode: boolean }
  const screen = $('authScreen')
  screen.hidden = false
  let mode: 'login' | 'register' | 'reset' = cfg.has_users ? 'login' : 'register'
  const render = () => {
    screen.querySelector('.auth-title')!.textContent = !cfg.has_users ? '创建管理员账户' : mode === 'login' ? '登录' : mode === 'reset' ? '找回密码' : '注册'
    screen.querySelector('.auth-sub')!.textContent = !cfg.has_users
      ? '这是第一个账户，将成为管理员，可以管理其他用户。'
      : mode === 'login' ? '登录后继续你的文档与幻灯片。'
        : mode === 'reset' ? '向你绑定的邮箱发送验证码。没有绑定邮箱的账户请联系管理员重置。'
          : '注册后即可开始写作；文档、资料只有你自己能看到。'
    $('authForm').hidden = mode === 'reset'
    $('resetForm').hidden = mode !== 'reset'
    $('authDisplayRow').hidden = mode === 'login'
    $('authSubmit').textContent = mode === 'login' ? '登录' : '创建账户'
    $('authSwitch').innerHTML = !cfg.has_users ? '' : mode === 'login'
      ? '<a href="#" data-mode="reset">忘记密码？</a> · 还没有账户？<a href="#" data-mode="register">注册</a>'
      : mode === 'reset' ? '想起来了？<a href="#" data-mode="login">登录</a>'
        : '已有账户？<a href="#" data-mode="login">登录</a>'
    $('authHint').hidden = mode === 'login'
    $('authError').textContent = ''
    $<HTMLInputElement>('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password'
  }
  render()
  $('authDev').hidden = !cfg.dev_mode
  $('authSwitch').onclick = e => {
    const a = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null
    if (!a) return
    e.preventDefault()
    mode = a.dataset.mode as typeof mode
    render()
  }
  $('authDev').onclick = e => {
    e.preventDefault()
    saveToken('dev')
    location.reload()
  }
  // 打开页面就在后台解题：用户填表期间算完，提交时通常无需等待；每题只能用一次，用后再领
  let pow = solvePow()
  pow.catch(() => {})
  $<HTMLFormElement>('authForm').onsubmit = async e => {
    e.preventDefault()
    const btn = $<HTMLButtonElement>('authSubmit')
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = '正在进行人机校验…'
    $('authError').textContent = ''
    try {
      const body = {
        username: $<HTMLInputElement>('authUsername').value,
        password: $<HTMLInputElement>('authPassword').value,
        display_name: $<HTMLInputElement>('authDisplay').value,
        website: $<HTMLInputElement>('authWebsite').value,
      }
      const { solution, fetchedAt } = await pow
      // 服务端要求领题后至少 1.5 秒才提交（拦脚本）：不足时在这里补足（按本机领题时刻计，不受时钟偏差影响）
      const wait = fetchedAt + 1700 - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      btn.textContent = label
      const r = await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { ...body, pow: solution })
      saveToken(r.token)
      location.reload()
    } catch (err) {
      $('authError').textContent = (err as Error).message
      btn.textContent = label
      btn.disabled = false
      pow = solvePow()
      pow.catch(() => {})
    }
  }
  // 找回密码：发码（需人机校验）→ 验证码 + 新密码
  let resetPow = solvePow()
  resetPow.catch(() => {})
  let cooldown = 0
  $('resetSend').onclick = async () => {
    const btn = $<HTMLButtonElement>('resetSend')
    if (cooldown > Date.now()) return
    $('resetError').textContent = ''
    btn.disabled = true
    btn.textContent = '发送中…'
    try {
      const { solution, fetchedAt } = await resetPow
      const wait = fetchedAt + 1700 - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      await post('/api/auth/password-code', { email: $<HTMLInputElement>('resetEmail').value, pow: solution, website: $<HTMLInputElement>('authWebsite').value })
      $('resetNote').textContent = '如果这个邮箱绑定了账户，验证码已发出（10 分钟内有效）。没收到请检查垃圾邮件。'
      $<HTMLInputElement>('resetCode').focus()
      cooldown = Date.now() + 60_000
      const tick = () => {
        const left = Math.ceil((cooldown - Date.now()) / 1000)
        if (left > 0) { btn.textContent = `${left} 秒后可重发`; setTimeout(tick, 1000) } else { btn.textContent = '重新发送'; btn.disabled = false }
      }
      tick()
    } catch (err) {
      $('resetError').textContent = (err as Error).message
      btn.textContent = '发送验证码'
      btn.disabled = false
    }
    resetPow = solvePow()
    resetPow.catch(() => {})
  }
  $<HTMLFormElement>('resetForm').onsubmit = async e => {
    e.preventDefault()
    $('resetError').textContent = ''
    try {
      const r = await post('/api/auth/reset-password', {
        email: $<HTMLInputElement>('resetEmail').value,
        code: $<HTMLInputElement>('resetCode').value,
        new_password: $<HTMLInputElement>('resetPassword').value,
      })
      saveToken(r.token)
      location.reload()
    } catch (err) {
      $('resetError').textContent = (err as Error).message
    }
  }
  $<HTMLInputElement>('authUsername').focus()
}

// —— 用户菜单 ——

const nudgeKey = (id: string) => `heurion.emailNudge.${id}`
const dismissed = (id: string) => { try { return localStorage.getItem(nudgeKey(id)) === '1' } catch { return false } }
const dismiss = (id: string) => { try { localStorage.setItem(nudgeKey(id), '1') } catch { /* 忽略 */ } }

export function initUserMenu(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): void {
  const initial = (me.display_name || me.username).trim().slice(0, 1).toUpperCase()
  $('userAvatar').textContent = initial
  $('userName').textContent = me.display_name
  $('userRole').textContent = me.dev ? '开发用户' : me.role === 'admin' ? '管理员' : me.username
  $('userMenuAdmin').hidden = me.role !== 'admin'
  $('userMenuClaim').hidden = !(me.dev_mode && me.role === 'admin')
  // 读视图是模型看到的文档表示，只在开发模式下作为排查工具提供
  $('userMenuReadView').hidden = !me.dev_mode
  $('userMenuSettings').hidden = !!me.dev
  $('userMenuEverywhere').hidden = !!me.dev
  const menu = $('userMenu')
  $('userButton').onclick = e => {
    e.stopPropagation()
    menu.hidden = !menu.hidden
  }
  document.addEventListener('click', e => { if (!menu.contains(e.target as Node)) menu.hidden = true })
  // 没绑邮箱：提醒一次（可关掉），忘记密码时才能自助找回
  if (!me.dev && !me.email && !dismissed(me.id)) {
    const bar = $('emailNudge')
    bar.hidden = false
    bar.onclick = e => {
      const t = (e.target as HTMLElement).closest('[data-nudge]') as HTMLElement | null
      if (!t) return
      bar.hidden = true
      if (t.dataset.nudge === 'bind') openSettings(me, api, notify)
      else dismiss(me.id)
    }
  }
  menu.onclick = async e => {
    const item = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
    if (!item) return
    menu.hidden = true
    switch (item.dataset.action) {
      case 'settings': openSettings(me, api, notify); break
      case 'admin': void openAdmin(me, api, notify); break
      case 'claim': {
        const r = await api('/api/me/claim-dev-data', { method: 'POST' }).catch(err => { notify((err as Error).message, true); return null })
        if (r) { notify(`已把开发期的 ${r.docs} 份文档、${r.assets} 个资产转到你的账户`); setTimeout(() => location.reload(), 900) }
        break
      }
      case 'everywhere':
        await api('/api/auth/logout-everywhere', { method: 'POST' }).catch(() => {})
        signOut()
        break
      case 'readview': document.dispatchEvent(new CustomEvent('heurion:readview')); break
      case 'logout': signOut(); break
    }
  }
}

function openDialog(title: string, body: string): HTMLElement {
  const dlg = $('dialog')
  dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dialog-head"><h2>${esc(title)}</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
    <div class="dialog-body">${body}</div></div>`
  dlg.hidden = false
  const close = () => { dlg.hidden = true; dlg.innerHTML = ''; document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close() }
  return dlg
}

function openSettings(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): void {
  const dlg = openDialog('个人设置', `
    <form id="profileForm" class="form">
      <label>用户名<input type="text" value="${esc(me.username)}" disabled></label>
      <label>显示名<input type="text" name="display_name" value="${esc(me.display_name)}" maxlength="40" required></label>
      <div class="row end"><button class="primary">保存</button></div>
    </form>
    <form id="emailForm" class="form">
      <h3>找回密码邮箱</h3>
      <div class="muted">${me.email ? `已绑定 <b>${esc(me.email)}</b>。忘记密码时可以用它自助找回；要换绑，在下面填新邮箱。` : '还没有绑定邮箱：绑定后忘记密码可以自助找回，否则只能找管理员重置。'}</div>
      <label>${me.email ? '新邮箱' : '邮箱'}<span class="field-row"><input type="text" name="email" inputmode="email" autocomplete="email" required><button type="button" id="emailSend">发送验证码</button></span></label>
      <label>验证码<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <div class="form-error" id="emailError"></div>
      <div class="row end"><button class="primary">绑定</button></div>
    </form>
    <form id="passwordForm" class="form">
      <h3>修改密码</h3>
      <label>当前密码<input type="password" name="current_password" autocomplete="current-password" required></label>
      <label>新密码<input type="password" name="new_password" autocomplete="new-password" required minlength="8"></label>
      <div class="muted">至少 8 位，同时包含字母和数字。修改后其他设备上的登录会失效。</div>
      <div class="form-error" id="passwordError"></div>
      <div class="row end"><button class="primary">修改密码</button></div>
    </form>`)
  dlg.querySelector<HTMLFormElement>('#profileForm')!.onsubmit = async e => {
    e.preventDefault()
    const name = new FormData(e.target as HTMLFormElement).get('display_name') as string
    try {
      await api('/api/me', { method: 'PATCH', body: JSON.stringify({ display_name: name }) })
      $('userName').textContent = name
      notify('已保存')
    } catch (err) { notify((err as Error).message, true) }
  }
  const emailForm = dlg.querySelector<HTMLFormElement>('#emailForm')!
  dlg.querySelector<HTMLButtonElement>('#emailSend')!.onclick = async () => {
    const btn = dlg.querySelector<HTMLButtonElement>('#emailSend')!
    try {
      await api('/api/me/email-code', { method: 'POST', body: JSON.stringify({ email: (emailForm.elements.namedItem('email') as HTMLInputElement).value }) })
      btn.disabled = true
      btn.textContent = '已发送'
      notify('验证码已发送，10 分钟内有效')
      setTimeout(() => { btn.disabled = false; btn.textContent = '重新发送' }, 60_000)
    } catch (err) { dlg.querySelector('#emailError')!.textContent = (err as Error).message }
  }
  emailForm.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(emailForm)
    try {
      const u = await api('/api/me/email', { method: 'POST', body: JSON.stringify({ email: f.get('email'), code: f.get('code') }) })
      me.email = u.email
      notify('邮箱已绑定')
      openSettings(me, api, notify)
    } catch (err) { dlg.querySelector('#emailError')!.textContent = (err as Error).message }
  }
  dlg.querySelector<HTMLFormElement>('#passwordForm')!.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(e.target as HTMLFormElement)
    try {
      const r = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ current_password: f.get('current_password'), new_password: f.get('new_password') }) })
      if (r.token) saveToken(r.token)
      notify('密码已修改')
      setTimeout(() => location.reload(), 700)
    } catch (err) { dlg.querySelector('#passwordError')!.textContent = (err as Error).message }
  }
}

async function openAdmin(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): Promise<void> {
  const dlg = openDialog('用户管理', '<div id="adminUsers" class="muted">加载中…</div>')
  const render = async () => {
    const users: any[] = await api('/api/admin/users')
    dlg.querySelector('#adminUsers')!.outerHTML = `<table class="users" id="adminUsers">
      <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>文档</th><th>最近登录</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr data-uid="${esc(u.id)}" class="${u.status === 'disabled' ? 'disabled' : ''}">
        <td><b>${esc(u.display_name)}</b><div class="muted">${esc(u.username)}${u.imported ? ' · 从 1.0 导入' : ''}${u.id === me.id ? ' · 我' : ''}</div></td>
        <td><select data-field="role"><option value="user"${u.role === 'user' ? ' selected' : ''}>普通用户</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>管理员</option></select></td>
        <td>${u.status === 'active' ? '<span class="pill ok">正常</span>' : '<span class="pill off">已停用</span>'}</td>
        <td>${u.doc_count}</td>
        <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
        <td class="actions"><div class="actions-row">
          <button data-act="${u.status === 'active' ? 'disable' : 'enable'}">${u.status === 'active' ? '停用' : '启用'}</button>
          <button data-act="reset">重置密码</button>
          <button data-act="logout" title="让该用户所有设备上的登录失效">强制下线</button>
        </div></td></tr>`).join('')}</tbody></table>`
  }
  await render().catch(err => notify((err as Error).message, true))
  dlg.onchange = async e => {
    const sel = e.target as HTMLSelectElement
    const uid = (sel.closest('[data-uid]') as HTMLElement | null)?.dataset.uid
    if (!uid || sel.dataset.field !== 'role') return
    try { await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) }); notify('角色已更新') } catch (err) { notify((err as Error).message, true) }
    await render()
  }
  dlg.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    const uid = (btn?.closest('[data-uid]') as HTMLElement | null)?.dataset.uid
    if (!btn || !uid) return
    try {
      if (btn.dataset.act === 'disable' || btn.dataset.act === 'enable') {
        await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.act === 'disable' ? 'disabled' : 'active' }) })
        notify(btn.dataset.act === 'disable' ? '已停用，该用户的登录立即失效' : '已启用')
      } else if (btn.dataset.act === 'reset') {
        const row = btn.closest('tr')!
        const box = document.createElement('tr')
        box.className = 'reset-row'
        box.innerHTML = `<td colspan="6"><form class="inline-form"><input type="text" name="pw" placeholder="新密码（至少 8 位，含字母和数字）" required minlength="8"><button class="primary">设置</button></form></td>`
        row.after(box)
        box.querySelector('form')!.onsubmit = async ev => {
          ev.preventDefault()
          const pw = (box.querySelector('input') as HTMLInputElement).value
          try { await api(`/api/admin/users/${uid}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); notify('密码已重置，请告知该用户'); box.remove() } catch (err) { notify((err as Error).message, true) }
        }
        return
      } else if (btn.dataset.act === 'logout') {
        await api(`/api/admin/users/${uid}/logout`, { method: 'POST' })
        notify('已让该用户所有设备下线')
      }
    } catch (err) { notify((err as Error).message, true) }
    await render()
  })
}
