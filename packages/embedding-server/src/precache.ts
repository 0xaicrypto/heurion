import { pipeline } from '@xenova/transformers'

const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
// #565: transformers.js pipeline defaults to quantized=true and requests
// model_quantized.onnx, which BAAI/bge-m3 does not ship → 404 on every
// precache run. Keep parity with index.ts (EMBEDDING_QUANTIZED default
// false) so the cached model matches what the server actually loads.
const quantized = ['1', 'true', 'yes', 'on'].includes(
  (process.env.EMBEDDING_QUANTIZED || '').toLowerCase(),
)

pipeline('feature-extraction', model, { quantized })
  .then(() => {
    console.log(`Model "${model}" cached successfully (quantized=${quantized}).`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(`Failed to cache model "${model}":`, err)
    process.exit(1)
  })
