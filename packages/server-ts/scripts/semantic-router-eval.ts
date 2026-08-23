#!/usr/bin/env tsx
/**
 * #562/#585 — semantic router offline evaluation + shadow-mode monthly report.
 *
 * Two modes:
 *   1. (default) truth-set evaluation — requires the local embedding service
 *      (default http://localhost:8003, or EMBEDDING_SERVICE_URL). Report:
 *      per-class confusion + recall/precision. Acceptance gate: generate
 *      recall >= 0.9 (falls to the LLM on doubt are allowed; mislabels are not).
 *   2. `--report` — shadow-mode disagreement report from telemetry_events
 *      (INTENT_SEMANTIC_ROUTER=shadow production runs). Gates per #585:
 *      分歧率 < 5% + generate recall >= 90% + semantic p50 < 50ms. No LLM
 *      calls, no embedding service needed.
 *
 * Usage:
 *   tsx scripts/semantic-router-eval.ts [--threshold=0.55] [--margin=0.02]
 *   tsx scripts/semantic-router-eval.ts --report [--since=2026-08-01]
 */
import { SemanticIntentRouter } from '../src/retrieval/semantic-intent-router.js'
import { SEMANTIC_GENERATE_SEEDS, SEMANTIC_VETO_SEEDS } from '../src/retrieval/semantic-seeds.js'
import { SEMANTIC_TRUTH_GENERATE, SEMANTIC_TRUTH_VETO } from '../src/retrieval/semantic-truth-set.js'
import { computeDisagreementReport, renderDisagreementReport, type ShadowRecord } from '../src/retrieval/semantic-disagreement.js'

function parseArg(name: string, dflt: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}

function parseStringArg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}

async function runShadowReport(): Promise<void> {
  // Reads sidecar telemetry rows recorded during shadow mode.
  const { default: prisma } = await import('../src/common/prisma.js')
  const since = parseStringArg('since', '')
  const where: any = { category: 'sidecar', action: 'intent' }
  if (since) where.createdAt = { gte: new Date(since) }
  const rows = await (prisma as any).telemetryEvent.findMany({ where, orderBy: { createdAt: 'asc' } })

  const records: ShadowRecord[] = []
  for (const row of rows) {
    let meta: any = {}
    try { meta = JSON.parse(row.metadata || '{}') } catch { continue }
    if (!meta.semantic) continue
    records.push({
      semantic: meta.semantic,
      llmVerdict: meta.verdict,
      semanticMs: typeof meta.semanticMs === 'number' ? meta.semanticMs : undefined,
    })
  }
  if (records.length === 0) {
    console.log('#585 shadow report: no shadow-mode telemetry rows found (INTENT_SEMANTIC_ROUTER=shadow required in production).')
    process.exit(0)
  }
  const report = computeDisagreementReport(records)
  console.log(renderDisagreementReport(report))
  const ready = report.gates.disagreementPass && report.gates.recallPass && report.gates.latencyPass
  process.exit(ready ? 0 : 1)
}

interface Row {
  trueClass: 'generate' | 'veto'
  q: string
  genSim: number
  vetoSim: number
  verdict: string
}

async function runTruthSetEval(): Promise<void> {
  const threshold = parseArg('threshold', 0.55)
  const margin = parseArg('margin', 0.02)

  const { createAiProvider } = await import('../src/common/ai/ai-provider.js')
  const provider = createAiProvider()
  const embed = (texts: string[]): Promise<number[][]> => provider.embed(texts)

  const router = new SemanticIntentRouter({
    embed,
    generateSeeds: SEMANTIC_GENERATE_SEEDS,
    vetoSeeds: SEMANTIC_VETO_SEEDS,
    threshold,
    margin,
  })

  const rows: Row[] = []
  for (const q of SEMANTIC_TRUTH_GENERATE) {
    rows.push({ trueClass: 'generate', q, genSim: 0, vetoSim: 0, verdict: await router.classify(q) })
  }
  for (const q of SEMANTIC_TRUTH_VETO) {
    rows.push({ trueClass: 'veto', q, genSim: 0, vetoSim: 0, verdict: await router.classify(q) })
  }

  let tpG = 0, fnG = 0, fpG = 0
  let tpV = 0, fnV = 0, fpV = 0
  const mislabeled: string[] = []

  for (const r of rows) {
    if (r.trueClass === 'generate') {
      if (r.verdict === 'generate') tpG++
      else if (r.verdict === 'veto') { fpV++; mislabeled.push(`[gen→veto] ${r.q}`) }
      else fnG++
    } else {
      if (r.verdict === 'veto') tpV++
      else if (r.verdict === 'generate') { fpG++; mislabeled.push(`[veto→gen] ${r.q}`) }
      else fnV++
    }
  }

  const nG = SEMANTIC_TRUTH_GENERATE.length
  const nV = SEMANTIC_TRUTH_VETO.length
  const recG = tpG / nG
  const recV = tpV / nV
  const precG = tpG / Math.max(tpG + fpG, 1)
  const precV = tpV / Math.max(tpV + fpV, 1)

  console.log(`
#562 semantic router offline evaluation
samples: generate=${nG} veto=${nV} (seeds: gen=${SEMANTIC_GENERATE_SEEDS.length} veto=${SEMANTIC_VETO_SEEDS.length})
threshold=${threshold} margin=${margin}

generate class: recall=${recG.toFixed(3)} (${tpG}/${nG}) precision=${precG.toFixed(3)}
veto class:     recall=${recV.toFixed(3)} (${tpV}/${nV}) precision=${precV.toFixed(3)}
mislabels kept silent in prod: ${mislabeled.length}`)

  for (const m of mislabeled) console.log(`  MISLABEL ${m}`)

  const gateOk = recG >= 0.9 && fpG === 0
  console.log(`\nacceptance (generate recall >= 0.9, zero veto->generate): ${gateOk ? 'PASS' : 'FAIL'}`)
  process.exit(gateOk ? 0 : 1)
}

async function main(): Promise<void> {
  if (process.argv.includes('--report')) {
    await runShadowReport()
    return
  }
  await runTruthSetEval()
}

main().catch((err) => {
  console.error('evaluation failed:', (err as Error).message)
  console.error('ensure the local embedding service is running (EMBEDDING_SERVICE_URL).')
  process.exit(1)
})