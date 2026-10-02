/** 预下载模型（不启动服务）：pnpm --filter @heurion2/embedder precache */
import { DTYPE, MODEL, loadModel, embed } from './model.ts'

let last = ''
const t0 = Date.now()
await loadModel(p => {
  if (p.status === 'progress' && p.file && p.progress !== undefined) {
    const line = `${p.file} ${p.progress.toFixed(0)}%`
    if (line !== last && Math.round(p.progress) % 10 === 0) { last = line; console.log(line) }
  } else if (p.status === 'done' && p.file) console.log(`完成 ${p.file}`)
})
const [v] = await embed(['心力衰竭是常见的临床综合征'])
console.log(`模型 ${MODEL}（${DTYPE}）就绪，维度 ${v!.length}，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`)
