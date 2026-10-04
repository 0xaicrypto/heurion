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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { issueToken } from '../src/auth/token.ts'

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

// 1b. 机构幻灯片模板：管理员（本人个人机构的管理员）按预设配色建「省立医院」模板（占位院徽，不是真实院徽）
//     → 新建幻灯片时在选择器最前面看到「本机构」→ 选用；别的机构（lily 的个人机构）看不到
const adminToken = await admin.evaluate(() => localStorage.getItem('heurion.token') ?? '')
const adminApi = async (p: string, o: RequestInit = {}) => (await fetch(B + p, { ...o, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', ...(o.headers as Record<string, string> ?? {}) } })).json()
await admin.click('#userButton')
await admin.click('#userMenuTenant')
await admin.waitForSelector('#orgTemplates [data-oact="new"]')
await admin.click('#orgTemplates [data-oact="new"]')
await admin.click('#orgTplForm [data-oact="preset"]')
await admin.fill('#orgTplForm input[name="label"]', '省立医院（UI 测试）')
await admin.fill('#orgTplForm input[name="footer"]', '安徽省立医院 · UI 测试')
await admin.setInputFiles('#orgTplLogo', { name: 'placeholder-logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" rx="12" fill="#004098"/><circle cx="50" cy="50" r="30" fill="#C90304"/></svg>') })
await admin.waitForTimeout(500)
ok('机构模板编辑：预设填入官网标准色，预览里有院徽与页脚文字', (await admin.inputValue('#orgTplForm [data-color="title"]')).toLowerCase() === '#004098'
  && await admin.locator('#orgPrevCover svg image').count() === 1 && (await admin.locator('#orgPrevContent svg').innerHTML()).includes('安徽省立医院 · UI 测试'))
await shot(admin, 'org-template-editor')
await admin.click('#orgTplForm button.primary')
await admin.waitForSelector('.org-tpl-item', { timeout: 8000 }).catch(() => {})
const orgTpl = (await adminApi('/api/tenant/templates')).templates.find((x: any) => x.label === '省立医院（UI 测试）')
ok('机构模板已创建并带院徽', !!orgTpl && orgTpl.has_logo && await admin.locator('.org-tpl-item').count() >= 1)
await admin.keyboard.press('Escape')
await admin.click('#newDeck')
await admin.waitForSelector('.tpl-grid')
const firstCard = admin.locator('.tpl-card').first()
ok('模板选择器：本机构模板排在最前、标「本机构」、封面有院徽', (await firstCard.getAttribute('data-tpl')) === orgTpl?.key && (await firstCard.locator('.tpl-org').count()) === 1 && (await firstCard.locator('.tpl-cover svg image').count()) === 1)
await shot(admin, 'org-template-picker')
await firstCard.click()
await admin.waitForSelector('.slide .shape')
const orgDeck = (await adminApi('/api/docs')).find((d: any) => d.kind === 'deck')
const orgModel = (await adminApi(`/api/docs/${orgDeck.id}/deck`)).doc
ok('按机构模板新建：封面带院徽装饰', orgModel.content[0].attrs.theme === orgTpl?.key && orgModel.content[0].content.some((c: any) => String(c.attrs?.name ?? '').startsWith('deco:') && c.attrs.asset_id === `ol_${orgTpl?.id}`))
await admin.waitForTimeout(800)
await shot(admin, 'org-template-deck')
await admin.keyboard.press('Escape')

// 2. 第二个用户：注册、看不到管理员的文档
const user = await newPage()
await register(user, 'lily', '李研究员', 'secret123')
ok('第二个用户是普通用户（个人空间）', (await user.locator('#userRole').innerText()) === 'lily · 个人空间')
ok('看不到别人的文档', await user.locator('#docList li:not(.nav-empty)').count() === 0 && await user.locator('#docList .nav-empty').count() === 1)
const userToken = await user.evaluate(() => localStorage.getItem('heurion.token') ?? '')
const userTpls = await (await fetch(B + '/api/deck-templates', { headers: { Authorization: `Bearer ${userToken}` } })).json() as Array<{ key: string }>
ok('别的机构看不到这个机构模板', !userTpls.some(t => t.key === orgTpl?.key))
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

let zhaoToken = '', zhaoId = ''
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
  zhaoToken = zhao.token; zhaoId = zhao.user.id
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

// 知家分享给医生（docs/design/SHARING.md）：医院（王医生的机构）管理员建科室并把赵医生分进去 → 家人（知家）建成员、录化验、分享给该科室
// → 医生在「家庭分享」里看到并查看 → 家人看到查看记录 → 纳入本院 → 家人撤销后医生看不到分享（已纳入的仍在）
// （注册每 IP 每小时限 5 个，这里只新注册家人一个账号；平台运营建医院在下面 AI 的流程里覆盖）
{
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(B + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await r.text()
    return { status: r.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() as any }
  }
  const hospital = (await call('GET', '/api/tenant', adminToken)).json as { id: string; name: string }
  // 医院管理员在「机构管理 → 科室」建心内科、把赵医生分进去
  await admin.goto(B + '/app')
  await admin.waitForSelector('#userButton', { state: 'visible' })
  await admin.click('#userButton')
  await admin.click('#userMenuTenant')
  await admin.waitForSelector('#tenantDepts #deptForm')
  await admin.fill('#deptForm input[name="name"]', '心内科')
  await admin.click('#deptForm button.primary')
  await admin.waitForSelector('#tenantDepts [data-dact="members"]')
  await admin.click('#tenantDepts [data-dact="members"]')
  await admin.check(`.dept-editor input[value="${zhaoId}"]`)
  await admin.click('.dept-editor [data-save]')
  await admin.waitForFunction(() => document.querySelector('#tenantDepts')?.textContent?.includes('赵医生'))
  ok('医院管理员建科室并分配医生', true)
  await shot(admin, 'share-departments')
  await admin.click('#dialog [data-close]')

  // 家人（知家）：建成员、录化验，在成员页「分享」里选医院 → 科室 → 分享
  const pow = solveChallenge(await (await fetch(B + '/api/auth/challenge')).json() as Challenge)
  await new Promise(r => setTimeout(r, 1700)) // 人机校验：签发后至少 1.5 秒才能提交
  const fam = await (await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'mama2026', display_name: '小王', password: 'secret123', pow }) })).json() as { token: string; user: { id: string }; error?: string }
  ok('家人注册知家账号', Boolean(fam.token), fam.error ?? '')
  const member = (await call('POST', '/api/patients', fam.token, { name: '妈妈', sex: 'F', birth_year: 1962, tags: ['高血压'] })).json
  await call('POST', `/api/patients/${member.id}/labs`, fam.token, { test_name: '空腹血糖', value: 7.4, unit: 'mmol/L', collected_on: '2026-09-20' })
  const f = await browser.newPage({ viewport: { width: 400, height: 860 } })
  f.on('pageerror', e => errors.push(e.message))
  await f.goto(B + '/phr')
  await f.evaluate(t => localStorage.setItem('heurion.token', t), fam.token)
  await f.goto(`${B}/phr#/m/${member.id}`)
  await f.reload()
  await f.waitForSelector('#mShare')
  await f.click('#mShare')
  await f.waitForSelector('dialog #sHos')
  await f.selectOption('dialog #sHos', hospital.id)
  await f.fill('dialog #sName', '王桂兰')
  await f.check('dialog #sImport')
  await shot(f, 'share-phr-dialog')
  await f.click('dialog [data-x="1"]')
  await f.waitForSelector('.tab.on[data-tab="share"]')
  await f.waitForSelector('[data-revoke]')
  ok('知家：分享给医院科室', (await f.locator('#main').innerText()).includes(`${hospital.name} · 心内科`))
  await shot(f, 'share-phr-list')

  // 医生在工作台「患者 → 家庭分享」看到并查看
  const h = await newPage()
  await h.goto(B + '/app')
  await h.evaluate(t => { localStorage.setItem('heurion.token', t); localStorage.setItem('heurion.space', 'patients') }, zhaoToken)
  await h.reload()
  await h.waitForSelector('#patientList [data-shares]')
  ok('医生的患者列表出现「家庭分享」', (await h.locator('#patientList [data-shares]').innerText()).includes('1'))
  await h.click('#patientList [data-shares]')
  await h.waitForSelector('.sh-card')
  await h.click('.sh-card')
  await h.waitForSelector('.pt-labs')
  ok('医生只读查看：化验与家人给的姓名', (await h.locator('#page').innerText()).includes('空腹血糖') && (await h.locator('#page').innerText()).includes('王桂兰'))
  await shot(h, 'share-doctor-view')

  // 家人看到查看记录
  await f.reload()
  await f.waitForSelector('.tab[data-tab="share"]')
  await f.click('.tab[data-tab="share"]')
  await f.waitForFunction(() => document.querySelector('#main')?.textContent?.includes('查看了概况'))
  ok('知家：看到医生的查看记录', true)
  await shot(f, 'share-phr-log')

  // 纳入本院 → 打开新患者
  const before = (await call('GET', '/api/patients', zhaoToken)).json.length as number
  await h.click('[data-import]')
  await h.click('#askOk')
  await h.waitForSelector('.page.patient-page:not(.share-page) .pt-code')
  const after = (await call('GET', '/api/patients', zhaoToken)).json as Array<{ id: string }>
  ok('纳入本院：复制成本院患者', after.length === before + 1)

  // 家人撤销 → 医生看不到分享，已纳入的仍在
  const shareId = (await call('GET', `/api/phr/${member.id}/shares`, fam.token)).json[0].id as string
  await f.click(`[data-revoke="${shareId}"]`)
  await f.click('dialog [data-x="1"]')
  await f.waitForFunction(() => document.querySelector('#main')?.textContent?.includes('已撤销'))
  ok('撤销后医生看不到分享、已纳入的仍在', (await call('GET', `/api/shares/${shareId}`, zhaoToken)).status === 404 && (await call('GET', `/api/patients/${after[0]!.id}`, zhaoToken)).status === 200)

  // 已有账户加入医院（双重身份，TENANCY.md）：知家用户小王（已有家人档案）→ 医院管理员按用户名邀请 → 小王在工作台接受
  // → 管理员把她分进心内科 → 她在工作台「家庭分享」收到发给心内科的分享 → 她自己的知家家人档案仍在（不新注册账号）
  await admin.goto(B + '/app')
  await admin.waitForSelector('#userButton', { state: 'visible' })
  await admin.click('#userButton')
  await admin.click('#userMenuTenant')
  await admin.waitForSelector('#inviteUserForm')
  await admin.fill('#inviteUserForm input[name="username"]', 'mama2026')
  await admin.click('#inviteUserForm button.primary')
  await admin.waitForFunction(() => document.querySelector('#inviteList')?.textContent?.includes('mama2026'))
  ok('管理员按用户名邀请已有账户', true)
  await shot(admin, 'join-invite-user')
  await admin.click('#dialog [data-close]')
  const w = await newPage()
  await w.goto(B + '/app')
  await w.evaluate(t => { localStorage.setItem('heurion.token', t); localStorage.setItem('heurion.space', 'write') }, fam.token)
  await w.reload()
  await w.waitForSelector('#inviteNudge:not([hidden])')
  ok('被邀请人登录后看到邀请提醒', (await w.locator('#inviteNudgeText').innerText()).includes(hospital.name))
  await w.click('#inviteNudge [data-join="view"]')
  await w.waitForSelector('#dialog [data-j="accept"]')
  ok('接受前说明工作台按医院、知家不受影响', (await w.locator('#dialog').innerText()).includes('知家'))
  await shot(w, 'join-accept')
  await w.click('#dialog [data-j="accept"]')
  await w.waitForFunction(n => document.querySelector('#userRole')?.textContent?.includes(n), hospital.name, { timeout: 15000 })
  ok('接受后头像菜单显示医院与个人空间', (await w.locator('#userRole').textContent() ?? '').includes('个人空间'))
  const depts = (await call('GET', '/api/tenant/departments', adminToken)).json as Array<{ id: string; name: string; members: Array<{ id: string }> }>
  const cardio = depts.find(d => d.name === '心内科')!
  await call('PUT', `/api/tenant/departments/${cardio.id}/members`, adminToken, { user_ids: [...cardio.members.map(m => m.id), fam.user.id] })
  ok('管理员把已加入的账户分进科室', ((await call('GET', '/api/tenant/departments', adminToken)).json as typeof depts).find(d => d.id === cardio.id)!.members.some(m => m.id === fam.user.id))
  // 她自己的知家：家人档案仍在（个人空间），并能再分享给心内科；工作台「家庭分享」收到
  const personal = await fetch(B + '/api/patients', { headers: { Authorization: `Bearer ${fam.token}`, 'X-Heurion-Space': 'personal' } }).then(r => r.json()) as Array<{ id: string }>
  ok('加入医院后知家家人档案仍在', personal.some(p => p.id === member.id))
  ok('工作台（医院）看不到知家的家人', !((await call('GET', '/api/patients', fam.token)).json as Array<{ id: string }>).some(p => p.id === member.id))
  const again = (await call('POST', `/api/phr/${member.id}/shares`, fam.token, { tenant_id: hospital.id, department_id: cardio.id })).json
  await w.evaluate(() => localStorage.setItem('heurion.space', 'patients'))
  await w.reload()
  await w.waitForSelector('#patientList [data-shares]')
  ok('加入后在工作台「家庭分享」收到发给心内科的分享', Boolean(again.id) && ((await call('GET', '/api/shares', fam.token)).json as Array<{ share_id: string }>).some(x => x.share_id === again.id))
  await shot(w, 'join-shares')
}

// 5. 邮箱：管理员绑定邮箱 → 另一个浏览器里忘记密码 → 验证码重置并登录 → 原登录失效
// —— AI 的权限 = 用户的权限：平台运营的 AI 发起「新建机构」→ 只生成待确认操作 → 用户在「待确认操作」里确认 → 生效，审计记 via=ai-confirmed ——
{
  const meAdmin = await adminApi('/api/me') as { id: string }
  // 以 AI 的身份（MCP 令牌，签名密钥与本地实例相同：HEURION_SECRET 或开发默认值）调用 platform_admin
  const mcpToken = issueToken(process.env.HEURION_SECRET ?? 'dev-secret-not-for-production-use!', { u: meAdmin.id, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 300 })
  const mcp = new Client({ name: 'ui-accounts', version: '0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(B + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }))
  const r = await mcp.callTool({ name: 'platform_admin', arguments: { action: 'create_tenant', name: 'AI 建的医院', reason: '新签约的合作医院' } }) as { content: Array<{ text?: string }> }
  const pending = JSON.parse(r.content.map(c => c.text ?? '').join('')) as { status: string; action_id: string }
  ok('AI 发起的高风险操作只生成待确认', pending.status === 'pending_confirmation')
  ok('确认前没有执行', !((await adminApi('/api/platform/tenants')) as Array<{ name: string }>).some(t => t.name === 'AI 建的医院'))
  const selfConfirm = await mcp.callTool({ name: 'action_status', arguments: { action_id: pending.action_id } }) as { content: Array<{ text?: string }> }
  ok('AI 只能查状态', JSON.parse(selfConfirm.content.map(c => c.text ?? '').join('')).status === 'pending')
  await mcp.close()
  await admin.reload()
  await admin.waitForSelector('#userButton.has-pending', { timeout: 10_000 })
  ok('头像上有待确认红点', true)
  await admin.click('#userButton')
  await admin.click('#userMenuActions')
  await admin.waitForSelector(`.action-card[data-action="${pending.action_id}"]`)
  await shot(admin, 'ai-action-confirm')
  await admin.click(`.action-card[data-action="${pending.action_id}"] [data-act="confirm"]`)
  await admin.waitForSelector(`.action-card[data-action="${pending.action_id}"] .action-status.done`)
  ok('用户确认后执行', ((await adminApi('/api/platform/tenants')) as Array<{ name: string }>).some(t => t.name === 'AI 建的医院'))
  const audit = await adminApi('/api/admin/audit?action=platform.tenant_create') as Array<{ via: string | null; confirmed_by: string | null; actor: string | null }>
  ok('审计记为 AI 发起、用户确认', audit.some(a => a.via === 'ai-confirmed' && a.confirmed_by === meAdmin.id && a.actor === meAdmin.id), JSON.stringify(audit.slice(0, 2)))
  await admin.click('#dialog [data-close]')
}

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
