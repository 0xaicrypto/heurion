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
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
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
