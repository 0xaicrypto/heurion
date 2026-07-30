import { generateDocx } from './handlers/docx.js'
import { generatePptx } from './handlers/pptx.js'
import { convertToPdf } from './handlers/pdf.js'
import { renderPlot } from './handlers/plot.js'
import { renderTable } from './handlers/table.js'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis = require('ioredis') as new (url: string) => any

const QUEUE_KEY = 'heurion:jobs'

const HANDLERS: Record<string, (payload: any, tenant?: any) => Promise<any>> = {
  'sidecar.generate_docx': (p) => generateDocx(p, p.tenant),
  'sidecar.generate_pptx': (p) => generatePptx(p),
  'sidecar.render_table': (p) => renderTable(p),
  'sidecar.render_plot': (p) => renderPlot(p),
  'sidecar.convert_to_pdf': (p) => convertToPdf(p),
  'sidecar.heurion/docx.generate_docx': (p) => generateDocx(p, p.tenant),
  'sidecar.heurion/pptx.generate_pptx': (p) => generatePptx(p),
  'sidecar.heurion/table.render_table': (p) => renderTable(p),
  'sidecar.heurion/plot.render_plot': (p) => renderPlot(p),
  'sidecar.heurion/pdf.convert_to_pdf': (p) => convertToPdf(p),
}

async function main() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0'
  const redis = new Redis(redisUrl)

  console.log(`Worker consumer listening on ${redisUrl} (queue: ${QUEUE_KEY})`)

  while (true) {
    try {
      const result = await redis.brpop(QUEUE_KEY, 0)
      if (!result) continue

      const [, raw] = result
      let job: any
      try {
        job = JSON.parse(raw)
      } catch {
        console.error('Invalid job JSON:', raw)
        continue
      }

      const { type, payload, tenant, id } = job
      if (!type || !id) {
        console.error('Invalid job:', { id, type })
        continue
      }

      console.log(`Processing job ${id}: ${type}`)

      const handler = HANDLERS[type]
      if (!handler) {
        console.error(`Unknown job type: ${type} for job ${id}`)
        continue
      }

      try {
        const result = await handler(payload || {}, tenant)
        console.log(`Job ${id} completed:`, result)
      } catch (err: any) {
        console.error(`Job ${id} failed:`, err.message)
      }
    } catch (err: any) {
      console.error('Consumer error:', err.message)
    }
  }
}

main().catch((err) => {
  console.error('Fatal consumer error:', err)
  process.exit(1)
})
