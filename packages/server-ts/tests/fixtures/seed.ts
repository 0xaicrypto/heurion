/**
 * E2E Test Data Seeder
 *
 * Creates a complete test user with realistic clinical data.
 * Run: npx tsx tests/fixtures/seed.ts [base-url]
 *
 * Idempotent — safe to run repeatedly.
 */
const BASE = process.argv[2] || 'http://localhost:8002'
const DOCTOR = { username: 'e2e-doctor', password: 'test123456', displayName: 'Dr. E2E' }

async function api(path: string, opts: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${BASE}${path}`, { ...opts, headers })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

async function main() {
  console.log('[seed] Seeding E2E data on', BASE)

  // 1. Create doctor account
  let token: string
  const regRes = await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(DOCTOR),
  })
  if ((regRes as any).jwt_token) {
    token = (regRes as any).jwt_token
    console.log('[seed] Doctor created:', DOCTOR.username)
  } else {
    // Already exists, login
    const loginRes = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: DOCTOR.username, password: DOCTOR.password }),
    })
    token = (loginRes as any).jwt_token
    console.log('[seed] Doctor logged in')
  }

  // 2. Create patient: Zhang Wei (lung cancer)
  const p1Res = await api('/api/v1/dicom/patients/register-manual', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Zhang Wei',
      initials: 'ZW',
      age: 45,
      sex: 'M',
      chief_complaint:
        '[diagnosis] Non-small cell lung adenocarcinoma, Stage IIIA (T2N2M0)\n' +
        '[imaging] CT chest: 4.2cm RUL mass with mediastinal adenopathy\n' +
        '[pathology] Adenocarcinoma, EGFR exon 19 deletion\n' +
        '[medication] Osimertinib 80mg PO daily, completed 4 cycles cisplatin/pemetrexed\n' +
        '[response] Partial response per RECIST 1.1 (-38% target lesions)\n' +
        '[history] 30 pack-year smoking history, cough + hemoptysis x 3 months\n' +
        '[plan] Continue TKI, re-stage CT in 3 months',
    }),
    token,
  })
  const zhangWeiHash = (p1Res as any).patient_hash
  console.log('[seed] Patient Zhang Wei:', zhangWeiHash || 'exists')

  // 3. Create patient: Li Xia (breast cancer)
  const p2Res = await api('/api/v1/dicom/patients/register-manual', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Li Xia',
      initials: 'LX',
      age: 62,
      sex: 'F',
      chief_complaint:
        '[diagnosis] Invasive ductal carcinoma, left breast, ER+/PR+/HER2-, Stage IIB\n' +
        '[imaging] Mammogram: 3.1cm irregular mass UOQ left breast\n' +
        '[pathology] IDC grade 2, ER 90%+, PR 70%+, HER2 1+, Ki-67 15%\n' +
        '[surgery] Breast-conserving surgery + SLNB (1/3 nodes positive)\n' +
        '[medication] Letrozole 2.5mg PO daily\n' +
        '[treatment] Adjuvant RT 50 Gy/25 fractions completed\n' +
        '[plan] No evidence of recurrence at 6 months',
    }),
    token,
  })
  console.log('[seed] Patient Li Xia:', (p2Res as any).patient_hash || 'exists')

  // 4. Create a medical record for Zhang Wei
  if (zhangWeiHash) {
    const mrRes = await api('/api/v1/medical-records', {
      method: 'POST',
      body: JSON.stringify({
        patient_hash: zhangWeiHash,
        title: `Initial Consultation — ${new Date().toISOString().slice(0, 10)}`,
        sections: {
          chief_complaint: 'Persistent dry cough for 3 months with recent hemoptysis. Fatigue and unintentional weight loss of 4 kg.',
          history_of_present_illness:
            '45yo male, 30 pack-year smoking history, no prior lung disease.\n' +
            'Symptoms onset 3 months ago: initially dry cough, progressed to blood-streaked sputum 2 weeks ago.\n' +
            'Associated: dyspnea on exertion (climbing 2 flights), night sweats, fatigue.\n' +
            'No fever, no chest pain at rest.',
          past_medical_history: 'Hypertension (5 years, controlled on amlodipine 5mg).\nType 2 DM (3 years, metformin 500mg BID).\nNo prior surgeries.',
          family_history: 'Father: lung cancer at 68 (smoker), deceased.\nMother: breast cancer at 55, post-mastectomy alive.\nBrother: healthy.',
          physical_exam:
            'VS: BP 138/86, HR 92, RR 20, SpO2 94% RA, Temp 37.1\n' +
            'General: Alert, mildly cachectic, no acute distress\n' +
            'Chest: Decreased breath sounds RUL, no wheezes or crackles\n' +
            'CV: Regular rate and rhythm, no murmurs\n' +
            'Abdomen: Soft, non-tender, no organomegaly\n' +
            'LN: No palpable cervical or supraclavicular adenopathy\n' +
            'ECOG PS: 1',
          diagnosis:
            '1. Non-small cell lung adenocarcinoma, Stage IIIA (T2N2M0)\n' +
            '   - EGFR exon 19 deletion confirmed\n' +
            '   - PD-L1 TPS 5%\n' +
            '2. Hypertension, controlled\n' +
            '3. Type 2 DM\n' +
            '4. Mild anemia (likely anemia of chronic disease)',
          treatment_plan:
            '1. Osimertinib 80mg PO daily (start 2026-05-01)\n' +
            '2. Cisplatin 75mg/m² + Pemetrexed 500mg/m² q3w × 4 cycles (completed 2026-06-15)\n' +
            '3. Dexamethasone 8mg PO BID day before/day of/day after chemo\n' +
            '4. Continue amlodipine 5mg and metformin 500mg BID\n' +
            '5. Folic acid 1mg daily, vitamin B12 1000mcg IM q9w\n' +
            '6. Re-stage CT chest/abdomen with contrast in 3 months\n' +
            '7. Monitor CBC, CMP, LFTs before each clinic visit\n' +
            '8. Smoking cessation counseling provided, nicotine patch 21mg started',
          progress_notes:
            '2026-07-14: Re-staging CT shows PR (−38%), CEA 8.1→4.2. Tolerating osimertinib well — grade 1 rash, grade 1 diarrhea managed with loperamide.\n' +
            'Plan: Continue osimertinib. Next CT in 3 months. Continue smoking cessation.',
        },
      }),
      token,
    })
    console.log('[seed] Medical record created:', (mrRes as any).id || 'exists')
  }

  // 5. Create a document
  await api('/api/v1/docs', {
    method: 'POST',
    body: JSON.stringify({ title: `Treatment Summary — Zhang Wei (${new Date().toISOString().slice(0, 10)})` }),
    token,
  }).then(async (d: any) => {
    if (d.id) {
      // Save content into the document
      await api(`/api/v1/docs/${d.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          message:
            '# Zhang Wei — Oncology Treatment Summary\n\n' +
            '**MRN:** MRN-2026-0042  \n' +
            '**Diagnosis:** NSCLC adenocarcinoma, Stage IIIA, EGFR exon 19 del\n\n' +
            '## Current Status\n' +
            'Partial response to osimertinib + chemo (-38%). ECOG 1.\n\n' +
            '## Plan\n' +
            '- Continue osimertinib 80mg daily\n' +
            '- Re-stage CT in 3 months\n' +
            '- Monitor CBC, LFTs monthly\n',
        }),
        token,
      })
      // Now update the body directly using a save approach
      await api(`/api/v1/docs/${d.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          message:
            'Record clinical note: Zhang Wei, 45M, NSCLC Stage IIIA on osimertinib. ' +
            'Partial response confirmed on CT 2026-07-14. CEA trending down 8.1→4.2. ' +
            'Mild anemia noted. Continue current management.',
        }),
        token,
      })
      console.log('[seed] Document created:', d.id)
    } else {
      console.log('[seed] Document skipped:', JSON.stringify(d).slice(0, 80))
    }
  })

  // 6. Create knowledge entries via facts import
  await api('/api/v1/memory/import', {
    method: 'POST',
    body: JSON.stringify({
      facts: [
        {
          category: 'fact',
          importance: 0.9,
          content:
            'Osimertinib shows superior PFS (18.9 months) vs first-generation TKIs (10.2 months) in EGFR exon 19 deletion NSCLC.',
          count: 5,
        },
        {
          category: 'fact',
          importance: 0.85,
          content:
            'RECIST 1.1: Partial Response = ≥30% decrease in sum of target lesion diameters. Progressive Disease = ≥20% increase.',
          count: 3,
        },
        {
          category: 'fact',
          importance: 0.8,
          content:
            'Common osimertinib adverse effects: rash (45%), diarrhea (42%), paronychia (35%). Monitor QTc and LVEF.',
          count: 2,
        },
      ],
    }),
    token,
  })
  console.log('[seed] Knowledge facts imported')

  // 7. Upload test files (lab report, imaging report)
  const LAB_REPORT =
    'CLINICAL LABORATORY REPORT\n' +
    'Patient: Zhang Wei | MRN: MRN-2026-0042\n' +
    'Collected: 2026-07-15 | Reported: 2026-07-15\n\n' +
    'CBC: WBC 6.8, RBC 4.2*LOW*, HGB 12.1*LOW*, HCT 36.5%*LOW*, PLT 245\n' +
    'CMP: Glucose 108*HIGH*, Creatinine 0.9, AST 32, ALT 28\n' +
    'Tumor Markers: CEA 4.2*HIGH* (trending down from 8.1)\n\n' +
    'IMPRESSION: Mild anemia, improving CEA trend.'

  const IMAGING_REPORT =
    'RADIOLOGY REPORT — CHEST CT\n' +
    'Patient: Zhang Wei | MRN: MRN-2026-0042 | Date: 2026-07-14\n\n' +
    'FINDINGS: RUL mass now 2.6x2.1cm (was 4.2x3.8cm). Station 4R node 2.1→1.3cm.\n' +
    'No new nodules. No pleural effusion. No pericardial effusion.\n\n' +
    'IMPRESSION: Partial response per RECIST 1.1. Continued surveillance recommended.'

  for (const [filename, content] of [
    ['lab-report-zhangwei.txt', LAB_REPORT],
    ['imaging-report-chest-ct.txt', IMAGING_REPORT],
  ]) {
    try {
      const formData = new FormData()
      formData.append('file', new Blob([content], { type: 'text/plain' }), filename)
      const res = await fetch(`${BASE}/api/v1/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json()
      console.log(`[seed] File uploaded: ${filename} → ${data.file_id || 'OK'}`)
    } catch (e: any) {
      console.log(`[seed] File ${filename}: ${e.message}`)
    }
  }

  console.log('\n[seed] Done!')
  console.log(`[seed]  Doctor: ${DOCTOR.username} / ${DOCTOR.password}`)
  console.log(`[seed]  Patients: Zhang Wei (${zhangWeiHash}), Li Xia`)
}

main().catch((err) => {
  console.error('[seed] Failed:', err)
  process.exit(1)
})
