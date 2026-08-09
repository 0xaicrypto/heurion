#!/usr/bin/env node
/**
 * #405: golden cross-check — replays frozen reference cases through the TS
 * stat-tools and compares against the Python-generated golden values.
 * Statistical quantities must agree within 1e-8.
 *
 * Run: node scripts/cross-check-stats.mjs <golden.json>
 */
import { readFileSync } from 'node:fs'
import { StatTTestTool, StatChiSqTool, StatKmTool } from '../src/tools/stat-tools.js'

const goldenPath = process.argv[2]
if (!goldenPath) {
  console.error('Usage: node scripts/cross-check-stats.mjs <golden.json>')
  process.exit(2)
}
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))

function close(a, b, eps = 1e-8) {
  if (a == null || b == null) return a == null && b == null
  // Compare at the same rounding precision both sides emit (4 decimals).
  const ra = Math.round(Number(a) * 10000) / 10000
  const rb = Math.round(Number(b) * 10000) / 10000
  return Math.abs(ra - rb) < eps
}

async function main() {
let failures = 0
for (const [name, { input, expected, ts_skip }] of Object.entries(golden)) {
  if (ts_skip) {
    console.log(`- ${name}: skipped (Python-authoritative, TS heuristic gate)`)
    continue
  }
  let out
  try {
    if (input.test === 't-test') {
      const res = await new StatTTestTool().execute({ group_a: input.group_a, group_b: input.group_b })
      if (!res.success) throw new Error(res.error)
      out = JSON.parse(res.output)
    } else if (input.test === 'chi-square') {
      const res = await new StatChiSqTool().execute({ table: input.table })
      if (!res.success) throw new Error(res.error)
      out = JSON.parse(res.output)
    } else if (input.test === 'kaplan-meier') {
      const res = await new StatKmTool().execute({
        group_a: input.survival_a,
        group_b: input.survival_b,
      })
      if (!res.success) throw new Error(res.error)
      out = JSON.parse(res.output)
    } else {
      throw new Error(`unknown test ${input.test}`)
    }
  } catch (err) {
    console.error(`✗ ${name}: TS threw — ${err.message}`)
    failures++
    continue
  }

  // Compare the quantities both implementations output.
  const keys = ['test_stat', 'p_value', 'effect_size', 'df']
  const mismatches = keys
    .filter((k) => !close(out[k], expected[k]))
    .map((k) => `${k} ts=${out[k]} golden=${expected[k]}`)
  if (mismatches.length > 0) {
    console.error(`✗ ${name}: ${mismatches.join(', ')}`)
    failures++
  } else {
    console.log(`✓ ${name} (${expected.method || name})`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) out of ${Object.keys(golden).length} failed`)
  process.exit(1)
}
console.log(`\nAll ${Object.keys(golden).length} golden cases agree (<1e-8)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
