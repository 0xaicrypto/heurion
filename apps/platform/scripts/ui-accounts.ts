/**
 * 账户流程的浏览器测试（真实 Chromium）：首个用户注册为管理员、第二个用户注册、两人看不到彼此的文档、
 * 用户菜单与个人设置、管理员停用用户后其登录立即失效、改密码。
 * 需要一个**全新**实例（会注册第一个用户成为管理员）：
 *   HEURION_DATA_DIR=$(mktemp -d) PORT=8788 HEURION_MCP_URL=http://127.0.0.1:8788/mcp pnpm start &
 *   pnpm --filter @heurion2/platform ui:accounts http://127.0.0.1:8788 [截图目录]
 */
import { chromium, type Page } from 'playwright'

const B = process.argv[2] ?? 'http://127.0.0.1:8788'
const SHOTS = process.argv[3]
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
  await page.goto(B + '/')
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
await admin.goto(B + '/')
await admin.waitForSelector('#authScreen:not([hidden])')
ok('全新实例显示「创建管理员账户」', (await admin.locator('.auth-title').innerText()) === '创建管理员账户')
await shot(admin, 'register-admin')
await admin.fill('#authUsername', 'x')
await admin.fill('#authPassword', 'secret123')
await admin.click('#authSubmit')
await admin.waitForFunction(() => document.getElementById('authError')!.textContent !== '')
ok('用户名不合法时提示', (await admin.locator('#authError').innerText()).includes('用户名'))
await register(admin, 'drwang', '王医生', 'secret123')
ok('注册后进入工作台，显示管理员', (await admin.locator('#userRole').innerText()) === '管理员' && (await admin.locator('#userName').innerText()) === '王医生')
await admin.click('#newDoc')
await admin.waitForSelector('.ProseMirror')
await shot(admin, 'workspace-admin')

// 2. 第二个用户：注册、看不到管理员的文档
const user = await newPage()
await register(user, 'lily', '李研究员', 'secret123')
ok('第二个用户是普通用户', (await user.locator('#userRole').innerText()) === 'lily')
ok('看不到别人的文档', await user.locator('#docList li').count() === 0)
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

ok('页面无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
process.exit(failed === 0 ? 0 : 1)
