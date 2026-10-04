/**
 * 账户流程的浏览器测试（真实 Chromium）：首个用户注册为管理员、第二个用户注册、两人看不到彼此的文档、
 * 用户菜单与个人设置、管理员停用用户后其登录立即失效、改密码、研究团队协作（同机构同事：可编辑 → 只读）。
 * 需要一个**全新**实例（会注册第一个用户成为管理员）：
 *   HEURION_DATA_DIR=$(mktemp -d) PORT=8788 HEURION_MCP_URL=http://127.0.0.1:8788/mcp pnpm start &
 *   pnpm --filter @heurion2/platform ui:accounts http://127.0.0.1:8788 [截图目录] [服务日志路径]
 * 给了服务日志路径时再测邮箱找回密码（开发模式下验证码打在日志里）。
 */
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'

const B = process.argv[2] ?? 'http://127.0.0.1:8788'
const SHOTS = process.argv[3]
const SERVER_LOG = process.argv[4]
const lastCode = () => [...readFileSync(SERVER_LOG!, 'utf8').matchAll(/验证码是：(\d{6})/g)].at(-1)?.[1] ?? ''
let failed = 0
const ok = (name: string, cond: boolean, extra = '') => { if (!cond) failed++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

const cfg = await (await fetch(`${B}/api/auth/config`)).json() as { has_users: boolean }
if (cfg.has_users) { console.error('需要全新实例（还没有任何用户）'); process.exit(2) }

const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch())
const errors: string[] = []
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('dialog', d => void d.accept()) // 新建文档的标题输入用默认值
  return page
}
const register = async (page: Page, username: string, display: string, password: string) => {
  await page.goto(B + '/app')
  await page.waitForSelector('#authScreen:not([hidden])')
  if (await page.locator('#authSwitch a[data-mode="register"]').isVisible()) await page.click('#authSwitch a[data-mode="register"]')
  await page.fill('#authUsername', username)
  await page.fill('#authDisplay', display)
  await page.fill('#authPassword', password)
  const t0 = Date.now()
  await page.click('#authSubmit')
  await page.waitForSelector('#userButton', { state: 'visible' })
  console.log(`  （提交到进入工作台 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，含人机校验）`)
  await page.waitForFunction(() => document.getElementById('userName')!.textContent !== '')
}

// 1. 第一个用户：创建管理员
const admin = await newPage()
await admin.goto(B + '/app')
await admin.waitForSelector('#authScreen:not([hidden])')
ok('全新实例显示「创建管理员账户」', (await admin.locator('.auth-title').innerText()) === '创建管理员账户')
await shot(admin, 'register-admin')
await admin.fill('#authUsername', 'x')
await admin.fill('#authPassword', 'secret123')
await admin.click('#authSubmit')
await admin.waitForFunction(() => document.getElementById('authError')!.textContent !== '')
ok('用户名不合法时提示', (await admin.locator('#authError').innerText()).includes('用户名'))
await register(admin, 'drwang', '王医生', 'secret123')
ok('注册后进入工作台，显示平台运营', (await admin.locator('#userRole').innerText()) === '平台运营' && (await admin.locator('#userName').innerText()) === '王医生')
await admin.click('#newDoc')
await admin.waitForSelector('.ProseMirror')
await shot(admin, 'workspace-admin')

// 2. 第二个用户：注册、看不到管理员的文档
const user = await newPage()
await register(user, 'lily', '李研究员', 'secret123')
ok('第二个用户是普通用户', (await user.locator('#userRole').innerText()) === 'lily')
ok('看不到别人的文档', await user.locator('#docList li:not(.nav-empty)').count() === 0 && await user.locator('#docList .nav-empty').count() === 1)
await user.click('#userButton')
ok('普通用户菜单里没有「用户管理」', await user.locator('#userMenuAdmin').isHidden())
await shot(user, 'user-menu')
await user.click('[data-action="settings"]')
await user.waitForSelector('#profileForm')
await user.fill('#profileForm input[name="display_name"]', '李老师')
await user.click('#profileForm button')
await user.waitForFunction(() => document.getElementById('userName')!.textContent === '李老师')
ok('个人设置改显示名', true)
await user.fill('#passwordForm input[name="current_password"]', 'secret123')
await user.fill('#passwordForm input[name="new_password"]', 'newpass456')
await user.click('#passwordForm button')
await user.waitForTimeout(1200)
ok('改密码后仍保持登录', await user.locator('#userButton').isVisible())

// 3. 管理员：用户管理，停用 lily
await admin.click('#userButton')
await admin.click('[data-action="admin"]')
await admin.waitForSelector('#adminUsers tbody tr')
ok('用户管理列出两个用户', await admin.locator('#adminUsers tbody tr').count() === 2)
await shot(admin, 'admin-users')
const lilyRow = admin.locator('#adminUsers tr', { hasText: 'lily' })
await lilyRow.locator('[data-act="disable"]').click()
await admin.waitForSelector('#adminUsers tr.disabled')
ok('停用后显示「已停用」', (await admin.locator('#adminUsers tr', { hasText: 'lily' }).innerText()).includes('已停用'))

// 4. 被停用的用户：下一次请求即回到登录页，且不能再登录
await user.reload()
await user.waitForSelector('#authScreen:not([hidden])')
ok('被停用后回到登录页', true)
await user.fill('#authUsername', 'lily')
await user.fill('#authPassword', 'newpass456')
await user.click('#authSubmit')
await user.waitForFunction(() => document.getElementById('authError')!.textContent !== '')
ok('被停用的账户不能登录', (await user.locator('#authError').innerText()).includes('停用'))
await shot(user, 'login-disabled')

// 研究团队协作：王医生邀请赵医生进本机构 → 建研究加赵为「可编辑」→ 赵看到共享研究并编辑方案 → 改为「只读」→ 赵只能看
{
  const adminToken = await admin.evaluate(() => localStorage.getItem('heurion.token') ?? '')
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(B + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await r.text()
    return { status: r.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() as any }
  }
  const invite = (await call('POST', '/api/tenant/invites', adminToken, {})).json.code as string
  const pow = solveChallenge(await (await fetch(B + '/api/auth/challenge')).json() as Challenge)
  await new Promise(r => setTimeout(r, 1700)) // 人机校验：签发后至少 1.5 秒才能提交
  const zhao = await (await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'drzhao', display_name: '赵医生', password: 'secret123', invite, pow }) })).json() as { token: string; user: { id: string } }
  const study = (await call('POST', '/api/studies', adminToken, { title: 'SGLT2i 真实世界研究' })).json
  const doc = (await call('POST', '/api/docs', adminToken, { title: 'SGLT2i 真实世界研究 · 研究方案', markdown: '# 研究方案\n\n研究背景待补充。' })).json
  await call('POST', `/api/studies/${study.id}/items`, adminToken, { kind: 'doc', ref_id: doc.id, role: 'protocol' })

  await admin.goto(B + '/app')
  await admin.waitForSelector('#userButton', { state: 'visible' })
  await admin.click('#navResearch')
  await admin.click(`#studyList li[data-study="${study.id}"]`)
  await admin.waitForSelector('#rsMembers #rsAddUser')
  await admin.selectOption('#rsAddUser', zhao.user.id)
  await admin.selectOption('#rsAddRole', 'editor')
  await admin.click('[data-act="addmember"]')
  await admin.waitForSelector(`#rsMembers [data-mrole="${zhao.user.id}"]`)
  ok('负责人在研究页加本机构同事为「可编辑」', (await admin.locator('#rsMembers').innerText()).includes('赵医生'))
  await shot(admin, 'team-members')

  const z = await newPage()
  await z.goto(B + '/app')
  await z.evaluate(t => { localStorage.setItem('heurion.token', t); localStorage.setItem('heurion.space', 'research') }, zhao.token)
  await z.reload()
  await z.waitForSelector(`#studyList li[data-study="${study.id}"]`)
  ok('同事的研究列表里出现共享研究并标「共享」', (await z.locator(`#studyList li[data-study="${study.id}"]`).innerText()).includes('共享'))
  await z.click(`#studyList li[data-study="${study.id}"]`)
  await z.waitForSelector(`[data-opendoc="${doc.id}"]`)
  ok('可编辑成员看得到「新建方案」等按钮', await z.locator('[data-new="protocol"]').count() === 1)
  await z.click(`[data-opendoc="${doc.id}"]`)
  await z.waitForSelector('.ProseMirror')
  ok('顶栏显示协作者', await z.locator('#docCollab .collab-avatar').count() === 2)
  await z.click('.ProseMirror p')
  await z.keyboard.press('End')
  await z.keyboard.type('赵医生补充的内容')
  await z.waitForTimeout(2500)
  const read = await call('GET', `/api/docs/${doc.id}/read`, adminToken)
  ok('可编辑成员的修改实时进了共享文档', read.text.includes('赵医生补充的内容'))

  await admin.selectOption(`[data-mrole="${zhao.user.id}"]`, 'viewer')
  await admin.waitForTimeout(800)
  ok('负责人把同事改为「只读」', (await call('GET', `/api/studies/${study.id}/members`, adminToken)).json.members.find((m: { user_id: string }) => m.user_id === zhao.user.id)?.role === 'viewer')
  await z.reload()
  await z.waitForSelector(`#studyList li[data-study="${study.id}"]`)
  await z.click(`#studyList li[data-study="${study.id}"]`)
  await z.waitForSelector(`[data-opendoc="${doc.id}"]`)
  await z.click(`[data-opendoc="${doc.id}"]`)
  await z.waitForSelector('.ProseMirror')
  ok('只读成员打开文档：编辑器不可编辑、顶栏标「只读」', (await z.locator('.ProseMirror').getAttribute('contenteditable')) === 'false' && await z.locator('#docCollab .collab-ro').isVisible())
  ok('只读成员的接口写入被拒绝', (await call('PATCH', `/api/docs/${doc.id}`, zhao.token, { title: 'x' })).status === 403)
  await shot(z, 'team-doc-readonly')
  await z.click('#docContext')
  await z.waitForSelector('.banner.rs-readonly')
  ok('只读成员的研究页：只读提示、没有修改类按钮', await z.locator('[data-new="protocol"]').count() === 0 && await z.locator('[data-act="upload"]').count() === 0)
  await shot(z, 'team-study-readonly')
}

// 5. 邮箱：管理员绑定邮箱 → 另一个浏览器里忘记密码 → 验证码重置并登录 → 原登录失效
if (SERVER_LOG) {
  ok('没绑邮箱时提醒绑定', await admin.locator('#emailNudge').isVisible())
  await admin.keyboard.press('Escape')
  await admin.click('#emailNudge [data-nudge="bind"]')
  await admin.waitForSelector('#emailForm')
  await admin.fill('#emailForm input[name="email"]', 'wang@hosp.example')
  await admin.click('#emailSend')
  await admin.waitForTimeout(800)
  await admin.fill('#emailForm input[name="code"]', lastCode())
  await admin.click('#emailForm button.primary')
  await admin.waitForFunction(() => document.querySelector('#emailForm')?.textContent?.includes('已绑定'))
  ok('个人设置里绑定邮箱', true)
  await shot(admin, 'settings-email')

  const other = await newPage()
  await other.goto(B + '/app')
  await other.waitForSelector('#authScreen:not([hidden])')
  await other.click('#authSwitch a[data-mode="reset"]')
  await other.fill('#resetEmail', 'WANG@hosp.example')
  await other.click('#resetSend')
  await other.waitForFunction(() => document.getElementById('resetNote')!.textContent !== '')
  await other.fill('#resetCode', lastCode())
  await other.fill('#resetPassword', 'reset98765')
  await shot(other, 'reset-password')
  await other.click('#resetSubmit')
  await other.waitForSelector('#userButton', { state: 'visible' })
  ok('忘记密码：邮箱验证码重置后直接登录', (await other.locator('#userName').innerText()) === '王医生')
  await admin.reload()
  await admin.waitForSelector('#authScreen:not([hidden])')
  ok('重置密码后其他设备上的登录失效', true)
}

ok('页面无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
process.exit(failed === 0 ? 0 : 1)
