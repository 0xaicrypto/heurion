#!/usr/bin/env node
/**
 * #1157 — 从 zod 契约生成 JSON Schema（Python 端据此校验，替代/兜底手写
 * pydantic 镜像的漂移）。当前覆盖 statsRequestSchema（python-stats-worker）。
 *
 * 用法: node scripts/generate-json-schema.mjs [--check]
 *  --check: 与已提交文件比对，漂移则退出码 1（CI 门禁）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { statsRequestSchema } from '../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(here, '../../python-stats-worker/stats-request.schema.json')

const jsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'StatsRequest',
  ...zodToJsonSchema(statsRequestSchema, { target: 'jsonSchema7', $refStrategy: 'none' }),
}
const serialized = JSON.stringify(jsonSchema, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : ''
  if (existing !== serialized) {
    console.error(`[json-schema] drift detected: ${path.relative(process.cwd(), outPath)} is stale.`)
    console.error('Run `pnpm --filter @heurion/contracts schema:generate` and commit the result.')
    process.exit(1)
  }
  console.log('[json-schema] stats request schema up to date')
} else {
  fs.writeFileSync(outPath, serialized)
  console.log(`[json-schema] wrote ${path.relative(process.cwd(), outPath)}`)
}
