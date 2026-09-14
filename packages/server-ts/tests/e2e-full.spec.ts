/**
 * Heurion E2E Tests
 *
 * Data is pre-seeded via api (tests/fixtures/seed.ts):
 *   Doctor: e2e-doctor / test123456
 *   Patients: Zhang Wei (lung cancer), Li Xia (breast cancer)
 *
 * Run: npx playwright test --config=playwright.config.ts
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8002'
const DOCTOR = { username: 'hz', password: 'hz123456' }

async function login(page: any) {
  await page.goto(`${BASE}/login`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  await page.locator('input[type="text"], input:not([type="password"])').first().fill(DOCTOR.username)
  await page.locator('input[type="password"]').fill(DOCTOR.password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL('**/app/today', { timeout: 10000 })
}

// ── 1. Auth ────────────────────────────────────────────

test.describe('1. Auth', () => {
  test('1.1 Login redirects to today', async ({ page }) => {
    await login(page)
    await expect(page).toHaveURL(/\/app\/today/)
  })

  test('1.2 No auth → redirect to login', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`)
    await page.waitForURL('**/login', { timeout: 8000 })
    await expect(page).toHaveURL(/\/login/)
  })
})

// ── 2. Navigation ──────────────────────────────────────

test.describe('2. Navigation', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  for (const name of ['Today', 'Chat', 'Patients', 'Research', 'Writing', 'Skills', 'Knowledge', 'Files']) {
    const slug = name.toLowerCase()
    test(`2.x ${name}`, async ({ page }) => {
      await page.goto(`${BASE}/app/${slug}`, { timeout: 10000, waitUntil: 'domcontentloaded' })
      await expect(page.locator('body')).toBeVisible()
    })
  }
})

// ── 3. Patients ────────────────────────────────────────

test.describe('3. Patients', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('3.1 Patient list loads', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText('Zhang Wei')
  })

  test('3.2 Patient detail', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText('Zhang Wei').first().click({ timeout: 8000 })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText(/Diagnosis|Treatment Plan|adenocarcinoma/i)
  })

  test('3.3 Patient detail shows diagnosis', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText('Zhang Wei').first().click({ timeout: 8000 })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText(/Diagnosis|Treatment Plan|adenocarcinoma/i)
  })
})

// ── 4. Medical Records ─────────────────────────────────

test.describe('4. Medical Records', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('4.1 Navigate to Records tab', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText('Zhang Wei').first().click({ timeout: 8000 })
    await page.waitForTimeout(500)
    const tab = page.locator('[role="tab"]:has-text("Records"), button:has-text("Records")').first()
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click()
      await page.waitForTimeout(1000)
    }
    await expect(page.locator('body')).toContainText(/Initial Consultation/i)
  })

  test('4.2 Open record and verify sections', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText('Zhang Wei').first().click({ timeout: 8000 })
    const tab = page.locator('[role="tab"]:has-text("Records"), button:has-text("Records")').first()
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click()
      await page.waitForTimeout(500)
    }
    await page.locator('text=Initial Consultation').first().click({ timeout: 5000 })
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toContainText(/cough|persistent|hemoptysis/i)
  })
})

// ── 5. Chat ────────────────────────────────────────────

test.describe('5. Chat', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('5.1 Chat page loads', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('textarea, [contenteditable="true"], input[type="text"]').first()).toBeVisible({ timeout: 8000 })
  })

  test('5.2 SSE streaming', async ({ page }) => {
    // #1035-fix: staging 可能没有 open 会话（textarea disabled）— 先建一个。
    await createSession(page, `E2E chat ${Date.now().toString(36)}`)
    const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').first()
    await input.fill('Hello, what is EGFR TKI therapy?')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
    const text = await page.locator('body').innerText()
    expect(text.length).toBeGreaterThan(100)
  })
})

// ── 6. Research + Writing + Knowledge + Settings + Admin

test.describe('6. Other pages', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('6.1 Research loads', async ({ page }) => {
    await page.goto(`${BASE}/app/research`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })

  test('6.2 Writing loads', async ({ page }) => {
    await page.goto(`${BASE}/app/writing`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })

  test('6.3 Knowledge loads', async ({ page }) => {
    await page.goto(`${BASE}/app/knowledge`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })

  test('6.4 Settings loads', async ({ page }) => {
    await page.goto(`${BASE}/app/settings`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })

  test('6.5 Admin users', async ({ page }) => {
    await page.goto(`${BASE}/app/admin/users`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/hz|e2e-doctor/i)
  })
})

// ── 7. Full clinical workflow ──────────────────────────

test.describe('7. Full workflow', () => {
  test('7.1 Login → Patient → Chat → Knowledge → Admin', async ({ page }) => {
    await login(page)

    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText('Zhang Wei')

    await page.getByText('Zhang Wei').first().click({ timeout: 8000 })
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toContainText(/Diagnosis|Treatment Plan/i)

    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()

    await page.goto(`${BASE}/app/knowledge`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()

    await page.goto(`${BASE}/app/admin/users`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/hz|e2e-doctor/i)
  })
})

// ── 8. References & suggestions user flow (#1035) ──────
// 纯 UI + 数据库链路（不依赖 LLM，不产生模型费用）：
// 8.1 固定引用 → 生效条 → 刷新仍生效；8.2 开局建议 → 采纳转正式引用。

async function createSession(page: any, title: string) {
  await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  // #1035-fix: 用页头按钮（永远可用）——footer 的同名按钮在部分状态下 disabled。
  const newBtn = page.locator('header').getByRole('button', { name: /新建会话|New Session/i }).first()
  await expect(newBtn).toBeEnabled({ timeout: 10000 })
  await newBtn.click()
  const titleInput = page.getByPlaceholder(/会话名称|session name/i)
  await titleInput.fill(title)
  await page.getByRole('button', { name: /^(创建|新建|create)$/i }).click()
  const refBtn = page.getByTitle(/管理本会话引用材料|Manage this session/)
  await expect(refBtn).toBeEnabled({ timeout: 10000 })
  return refBtn
}

async function addPastedReference(page: any, label: string, content: string) {
  await page.getByTitle(/管理本会话引用材料|Manage this session/).click()
  await page.getByRole('button', { name: /粘贴文本|Paste text/ }).click()
  await page.getByPlaceholder(/WHO Guideline/).fill(label)
  await page.getByPlaceholder(/Paste or type reference content/).fill(content)
  await page.getByRole('button', { name: /^Add$/ }).click()
}

test.describe('8. References & suggestions', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('8.1 固定引用 → 生效条可见且刷新后仍生效', async ({ page }) => {
    const uniq = Date.now().toString(36)
    const label = `E2E材料_${uniq}`
    await createSession(page, `E2E引用_${uniq}`)
    await addPastedReference(page, label, `正文材料 ${label}`)

    await expect(page.getByText(label).first()).toBeVisible({ timeout: 10000 })

    // 刷新后按会话恢复 → 引用持续生效（不依赖重新附加）。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(label).first()).toBeVisible({ timeout: 12000 })
  })

  test('8.2 开局建议横幅 → 采纳转正式引用', async ({ page }) => {
    const uniq = Date.now().toString(36)
    const keyword = `ZZE${uniq}`
    // 会话 A：登记一条含关键词的引用材料（用户资产，跨会话复用）。
    await createSession(page, `材料会话_${uniq}`)
    await addPastedReference(page, `${keyword} 材料`, `${keyword} 治疗相关正文`)

    // 会话 B：标题含关键词 → 开局扫描命中 → 建议横幅。
    await createSession(page, `${keyword} 目标`)
    const banner = page.getByTestId('suggested-reference-banner')
    await expect(banner).toBeVisible({ timeout: 12000 })
    await expect(banner).toContainText(keyword)

    await banner.getByRole('button', { name: /^引用$|^Use$/ }).click()
    await expect(banner).toBeHidden({ timeout: 8000 })
    // 采纳后立即出现在正式引用（生效条）。
    await expect(page.getByText(`${keyword} 材料`).first()).toBeVisible({ timeout: 8000 })
  })
})
