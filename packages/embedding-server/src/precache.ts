import { pipeline } from '@huggingface/transformers'

const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
// #565: transformers.js v2 defaulted quantized=true → requested
// model_quantized.onnx, which BAAI/bge-m3 does not ship → 404 on every
// precache run. v4 removed the quantized flag in favor of dtype; keep
// parity with index.ts (EMBEDDING_QUANTIZED default false → fp32) so the
// cached model matches what the server actually loads.
const quantized = ['1', 'true', 'yes', 'on'].includes(
  (process.env.EMBEDDING_QUANTIZED || '').toLowerCase(),
)

pipeline('feature-extraction', model, {
  dtype: quantized ? 'q8' : 'fp32',
  // #565: BAAI/bge-m3 weights are external data (model.onnx_data, 2.1GB)
  // and config.json omits use_external_data_format — v4 would skip the
  // data file and fail at session creation. Must match embedding.service.ts.
  use_external_data_format: true,
})
  .then(() => {
    console.log(`Model "${model}" cached successfully (quantized=${quantized}).`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(`Failed to cache model "${model}":`, err)
    process.exit(1)
  })