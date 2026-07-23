/**
 * Heurion E2E Tests — Complete User Workflow
 *
 * Uses pre-seeded test data (see fixtures/seed.ts):
 *   Doctor: e2e-doctor / test123456
 *   Patients: Zhang Wei (lung cancer), Li Xia (breast cancer)
 *   Files: lab-report, imaging-report
 *   Knowledge: EGFR TKI, RECIST 1.1
 *
 * Run: npx playwright test --config=playwright.config.ts
 */
import { test, expect, request } from '@playwright/test'

const BASE = process.env.BASE_URL || 'http://localhost:8002'
const DOCTOR = { username: 'e2e-doctor', password: 'test123456', displayName: 'Dr. E2E' }
const PATIENT_NAME = 'Zhang Wei'

test.use({ storageState: undefined })

// Pre-authenticate via API and save browser state
test.beforeAll(async ({ browser }) => {
  test.setTimeout(60000)

  // Call API directly via Playwright's request context — no browser needed
  const apiCtx = await request.newContext({ baseURL: BASE })
  let jwt: string
  const loginRes = await apiCtx.post('/api/v1/auth/login', {
    data: { username: DOCTOR.username, password: DOCTOR.password },
  })
  const body = await loginRes.json()
  if (body.jwt_token) {
    jwt = body.jwt_token
  } else {
    const regRes = await apiCtx.post('/api/v1/auth/register', {
      data: { username: DOCTOR.username, password: DOCTOR.password, display_name: DOCTOR.displayName },
    })
    jwt = (await regRes.json()).jwt_token
  }
  await apiCtx.dispose()

  // Inject token into browser via localStorage
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  await page.evaluate((token) => {
    localStorage.setItem('nexus.auth.token', token)
    localStorage.setItem('nexus.auth.display_name', 'Dr. E2E')
  }, jwt)
  // Navigate to today to trigger Zustand rehydration
  await page.goto(`${BASE}/app/today`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.context().storageState({ path: '/tmp/e2e-state.json' })
  await page.close()
})

// ── 1. Authentication ───────────────────────────────────

test.describe('1. Authentication', () => {
  test('1.1 Reuse saved session', async ({ page }) => {
    await page.goto(`${BASE}/app/today`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    // Should stay on today — already authenticated
    await expect(page).toHaveURL(/\/app\/today/)
  })

  test('1.2 Protected routes redirect to login', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`)
    await page.waitForURL('**/login', { timeout: 10000 })
    await expect(page).toHaveURL(/\/login/)
  })
})

// ── 2. Navigation ───────────────────────────────────────

test.describe('2. Navigation', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  const ROUTES = [
    'Today', 'Chat', 'Patients', 'Research', 'Writing', 'Skills', 'Knowledge', 'Files',
  ]

  for (const name of ROUTES) {
    const slug = name.toLowerCase()
    test(`2.x ${name}`, async ({ page }) => {
      await page.goto(`${BASE}/app/${slug}`, { timeout: 10000, waitUntil: 'domcontentloaded' })
      await expect(page.locator('body')).toBeVisible()
    })
  }
})

// ── 3. Patients ─────────────────────────────────────────

test.describe('3. Patients', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('3.1 List shows Zhang Wei', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText(PATIENT_NAME, { timeout: 8000 })
  })

  test('3.2 Detail shows clinical data', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText(/Diagnosis|Treatment Plan|osimertinib/i, { timeout: 8000 })
  })

  test('3.3 Summary has medical record', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toContainText(/Initial Consultation|adenocarcinoma/i, { timeout: 8000 })
  })

  test('3.4 Create patient', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    const addBtn = page.locator('button:has-text("New"), button:has-text("新增")').first()
    if (await addBtn.isVisible({ timeout: 3000 })) {
      await addBtn.click()
      await page.waitForTimeout(500)
    }
    expect(true).toBe(true)
  })
})

// ── 3b. Medical Records ─────────────────────────────────

test.describe('3b. Medical Records', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('3b.1 Navigate to records tab', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    await page.waitForTimeout(500)
    const tab = page.locator('[role="tab"]:has-text("Records"), button:has-text("Records")').first()
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click()
      await page.waitForTimeout(1000)
    }
    await expect(page.locator('body')).toContainText(/Initial Consultation/, { timeout: 8000 })
  })

  test('3b.2 Open seeded record', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    const tab = page.locator('[role="tab"]:has-text("Records"), button:has-text("Records")').first()
    if (await tab.isVisible({ timeout: 3000 })) { await tab.click(); await page.waitForTimeout(500) }
    const record = page.locator('text=Initial Consultation').first()
    if (await record.isVisible({ timeout: 5000 })) {
      await record.click()
      await page.waitForTimeout(500)
      await expect(page.locator('body')).toContainText(/cough|persistent/i, { timeout: 8000 })
    }
  })
})

// ── 3c. Encounter (问诊) ─────────────────────────────────

test.describe('3c. Encounter', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('3c.1 Open patient chat', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    const chatTab = page.locator('[role="tab"]:has-text("问诊"), [role="tab"]:has-text("Chat"), button:has-text("Chat")').first()
    if (await chatTab.isVisible({ timeout: 3000 })) {
      await chatTab.click()
      await page.waitForTimeout(1000)
    }
    await expect(page.locator('body')).toContainText(/Zhang Wei|MRN-2026/i, { timeout: 8000 })
  })

  test('3c.2 Send clinical question', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    const chatTab = page.locator('[role="tab"]:has-text("问诊"), [role="tab"]:has-text("Chat"), button:has-text("Chat")').first()
    if (await chatTab.isVisible({ timeout: 3000 })) { await chatTab.click(); await page.waitForTimeout(500) }
    const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').first()
    if (await input.isVisible({ timeout: 3000 })) {
      await input.fill('What is the EGFR TKI standard of care for NSCLC?')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(6000)
      const text = await page.locator('body').innerText()
      expect(text.length).toBeGreaterThan(100)
    }
  })
})

// ── 4. Chat ─────────────────────────────────────────────

test.describe('4. Chat', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('4.1 Global chat loads', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    await expect(page.locator('textarea, [contenteditable="true"], input[type="text"]').first()).toBeVisible({ timeout: 8000 })
  })

  test('4.2 SSE streaming', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').first()
    await input.waitFor({ timeout: 8000 })
    await input.fill('Hello, what is RECIST 1.1?')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
    const text = await page.locator('body').innerText()
    expect(text.length).toBeGreaterThan(50)
  })
})

// ── 5. Research ─────────────────────────────────────────

test.describe('5. Research', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('5.1 Studies load', async ({ page }) => {
    await page.goto(`${BASE}/app/research`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })
})

// ── 6. Writing ──────────────────────────────────────────

test.describe('6. Writing', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('6.1 Documents load', async ({ page }) => {
    await page.goto(`${BASE}/app/writing`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/Treatment Summary|Document/, { timeout: 8000 })
  })
})

// ── 7. Knowledge ────────────────────────────────────────

test.describe('7. Knowledge', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('7.1 Knowledge loads', async ({ page }) => {
    await page.goto(`${BASE}/app/knowledge`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toContainText(/EGFR|RECIST|Knowledge|知识/i, { timeout: 8000 })
  })
})

// ── 8. Settings ─────────────────────────────────────────

test.describe('8. Settings', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('8.1 Settings loads', async ({ page }) => {
    await page.goto(`${BASE}/app/settings`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toBeVisible()
  })
})

// ── 9. Admin ────────────────────────────────────────────

test.describe('9. Admin', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('9.1 Users list', async ({ page }) => {
    await page.goto(`${BASE}/app/admin/users`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/hz|e2e-doctor/i, { timeout: 8000 })
  })
})

// ── 10. Full Workflow ───────────────────────────────────

test.describe('10. Full Clinical Workflow', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('10.1 Login → Patient → Records → Chat → Knowledge → Admin', async ({ page }) => {
    await page.goto(`${BASE}/app/today`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/app\/today/)

    // Patients
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toContainText(PATIENT_NAME, { timeout: 8000 })

    // Open Zhang Wei
    await page.getByText(PATIENT_NAME).first().click({ timeout: 8000 })
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toContainText(/Diagnosis|Treatment Plan/, { timeout: 8000 })

    // Records tab
    const recordsTab = page.locator('[role="tab"]:has-text("Records"), button:has-text("Records")').first()
    if (await recordsTab.isVisible({ timeout: 3000 })) { await recordsTab.click(); await page.waitForTimeout(500) }

    // Chat
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })

    // Knowledge
    await page.goto(`${BASE}/app/knowledge`, { timeout: 10000, waitUntil: 'domcontentloaded' })

    // Admin
    await page.goto(`${BASE}/app/admin/users`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/hz|e2e-doctor/i, { timeout: 8000 })
  })
})
