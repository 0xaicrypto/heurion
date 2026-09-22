import { pipeline } from '@huggingface/transformers'

const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
// #565: transformers.js v2 defaulted quantized=true → requested
// model_quantized.onnx, which BAAI/bge-m3 does not ship → 404 on every
// precache run. v4 removed the quantized flag in favor of dtype.
// 低优先: 与 index.ts 的 loadConfig 完全同口径 — EMBEDDING_DTYPE 优先
// （显式 dtype 决定缓存哪份权重），未设置时才回落 EMBEDDING_QUANTIZED；
// 此前 precache 只认 QUANTIZED，运维只配 DTYPE 时会预缓存错权重。
const quantized = ['1', 'true', 'yes', 'on'].includes(
  (process.env.EMBEDDING_QUANTIZED || '').toLowerCase(),
)
const dtype: 'fp32' | 'fp16' | 'q8' | 'int8' =
  (process.env.EMBEDDING_DTYPE as 'fp32' | 'fp16' | 'q8' | 'int8' | undefined)
  || (quantized ? 'q8' : 'fp32')

pipeline('feature-extraction', model, {
  dtype,
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