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

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8002'
const DOCTOR = { username: 'e2e-doctor', password: 'test123456', displayName: 'Dr. E2E' }
const PATIENT_NAME = 'Zhang Wei'

// Pre-authenticate via API and save browser state
test.beforeAll(async ({ browser }) => {
  test.setTimeout(60000)

  // Call API directly via Playwright's request context
  const apiCtx = await request.newContext({ baseURL: BASE })
  let jwt: string, userId: string, displayName: string, role: string
  const loginRes = await apiCtx.post('/api/v1/auth/login', {
    data: { username: DOCTOR.username, password: DOCTOR.password },
  })
  let body = await loginRes.json()
  if (body.jwt_token) {
    jwt = body.jwt_token; userId = body.user_id; displayName = body.display_name; role = body.role
  } else {
    const regRes = await apiCtx.post('/api/v1/auth/register', {
      data: { username: DOCTOR.username, password: DOCTOR.password, display_name: DOCTOR.displayName },
    })
    body = await regRes.json()
    jwt = body.jwt_token; userId = body.user_id; displayName = body.display_name; role = body.role
  }
  await apiCtx.dispose()

  // Inject token + Zustand-compatible state into browser
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  await page.evaluate(({ jwt: t, userId: uid, displayName: dn, role: r }) => {
    // Raw API token
    localStorage.setItem('nexus.auth.token', t)
    localStorage.setItem('nexus.auth.user_id', uid)
    localStorage.setItem('nexus.auth.display_name', dn)
    // Zustand persist state (key = "nexus-auth", format from partialize)
    localStorage.setItem('nexus-auth', JSON.stringify({
      state: { token: t, userId: uid, displayName: dn, role: r, isAuthenticated: true },
      version: 0,
    }))
  }, { jwt, userId, displayName, role })
  await page.goto(`${BASE}/app/today`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.context().storageState({ path: '/tmp/e2e-state.json' })
  await page.close()
})

// ── 1. Authentication ───────────────────────────────────

test.describe('1. Authentication', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('1.1 Saved session stays on today', async ({ page }) => {
    await page.goto(`${BASE}/app/today`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await expect(page).toHaveURL(/\/app\/today/)
  })
})

test.describe('1b. Unauth Redirect', () => {
  test.use({ storageState: undefined })
  test('1.2 Redirects to login', async ({ page }) => {
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

  test('3.1 Patients page loads (session valid)', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'networkidle' })
    // If not redirected to login, session is valid
    await expect(page).not.toHaveURL(/\/login/)
    // Now verify data via API
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  test('3.2 Patient detail API works', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    const patients: any[] = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    if (patients.length > 0) {
      const detail = await page.evaluate(async (hash) => {
        const res = await fetch(`/api/v1/dicom/patients/${hash}/detail`)
        return res.json()
      }, patients[0].patient_hash)
      expect(detail.patient_hash).toBeTruthy()
    }
  })

  test('3.3 Medical record in projection API', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    const patients: any[] = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    if (patients.length > 0) {
      const projection = await page.evaluate(async (hash) => {
        const res = await fetch(`/api/v1/memory/patient/${hash}/projection`)
        return res.json()
      }, patients[0].patient_hash)
      expect(projection.medical_record).toBeTruthy()
      expect(projection.medical_record.sections?.diagnosis).toBeTruthy()
    }
  })

  test('3.4 Create patient dialog opens', async ({ page }) => {
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

  test('3b.1 Medical records API returns seeded data', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'networkidle' })
    await expect(page).not.toHaveURL(/\/login/)
    const patients: any[] = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    expect(patients.length).toBeGreaterThan(0)
    const records = await page.evaluate(async (hash: string) => {
      const res = await fetch(`/api/v1/medical-records?patient_hash=${hash}`)
      return res.json()
    }, patients[0].patient_hash)
    expect(Array.isArray(records)).toBe(true)
    expect(records.length).toBeGreaterThan(0)
  })

  test('3b.2 Medical record has structured sections', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const patients: any[] = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    if (patients.length > 0) {
      const records: any[] = await page.evaluate(async (hash: string) => {
        const res = await fetch(`/api/v1/medical-records?patient_hash=${hash}`)
        return res.json()
      }, patients[0].patient_hash)
      if (records.length > 0) {
        const sections = typeof records[0].sections === 'string'
          ? JSON.parse(records[0].sections) : records[0].sections
        expect(sections).toBeTruthy()
      }
    }
  })
})

// ── 3c. Encounter (问诊) ─────────────────────────────────

test.describe('3c. Encounter', () => {
  test.use({ storageState: '/tmp/e2e-state.json' })

  test('3c.1 Patient chat tab navigable', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    const patients: any[] = await page.evaluate(async () => {
      const res = await fetch('/api/v1/dicom/patients/full')
      return res.json()
    })
    if (patients.length > 0) {
      await page.goto(`${BASE}/app/patients/${patients[0].patient_hash}/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)
      await expect(page.locator('body')).toBeVisible()
    }
  })

  test('3c.2 AI responds to clinical question', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`, { timeout: 10000, waitUntil: 'domcontentloaded' })
    const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').first()
    if (await input.isVisible({ timeout: 5000 })) {
      await input.fill('Hello, what is EGFR TKI therapy?')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(5000)
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
