import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 幻灯片渲染（PLATFORM.md §7.3 P2 过渡方案）：LibreOffice 把 pptx 转成 PDF，pdftoppm 转成每页 PNG。
 * 本机有 soffice + pdftoppm 时直接用（容器部署）；否则用 heurion2:dev 镜像跑（本地开发）。
 * 结果按（文档, rev）缓存。
 */
export class SlideRenderer {
  private mode: 'local' | 'container' | 'none' | null = null
  private readonly inflight = new Map<string, Promise<string[]>>()

  constructor(private readonly cacheDir: string, private readonly image = 'heurion2:dev') {}

  /** 上次探测到「不可用」的时间：渲染环境可能晚于服务就绪（如之后才启动 podman），过一会儿重新探测。 */
  private noneAt = 0

  private async detect(): Promise<'local' | 'container' | 'none'> {
    if (this.mode && (this.mode !== 'none' || Date.now() - this.noneAt < 30_000)) return this.mode
    try {
      await run('soffice', ['--version'], { timeout: 20_000 })
      await run('pdftoppm', ['-v'], { timeout: 5_000 })
      this.mode = 'local'
    } catch {
      this.mode = 'none'
      for (const engine of ['podman', 'docker']) {
        try {
          await run(engine, ['image', 'exists', this.image], { timeout: 10_000 })
          this.engine = engine
          this.mode = 'container'
          break
        } catch { /* 下一个 */ }
      }
      if (this.mode === 'none') this.noneAt = Date.now()
    }
    return this.mode
  }

  private engine = 'podman'

  async available(): Promise<boolean> {
    return (await this.detect()) !== 'none'
  }

  /** 渲染整份 deck，返回每页 PNG 的路径（按页序）。 */
  render(key: string, pptx: () => Uint8Array): Promise<string[]> {
    const dir = join(this.cacheDir, key)
    const cached = existsSync(dir) ? readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0])) : []
    if (cached.length > 0) return Promise.resolve(cached.map(f => join(dir, f)))
    let job = this.inflight.get(key)
    if (!job) {
      job = this.renderNow(dir, pptx()).finally(() => this.inflight.delete(key))
      this.inflight.set(key, job)
    }
    return job
  }

  private async renderNow(dir: string, bytes: Uint8Array): Promise<string[]> {
    const mode = await this.detect()
    if (mode === 'none') throw new Error('幻灯片渲染不可用：需要 LibreOffice（soffice）与 pdftoppm，或本机有 heurion2:dev 镜像')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deck.pptx'), bytes)
    const script = 'export HOME=/tmp && soffice --headless --convert-to pdf --outdir "$D" "$D/deck.pptx" >/dev/null 2>&1 && pdftoppm -png -r 72 "$D/deck.pdf" "$D/slide"'
    if (mode === 'local') {
      await run('bash', ['-c', script], { env: { ...process.env, D: dir }, timeout: 180_000 })
    } else {
      await run(this.engine, ['run', '--rm', '-v', `${dir}:/x:Z`, '--user', 'root', '-e', 'D=/x', '--entrypoint', 'bash', this.image, '-c', script], { timeout: 300_000 })
    }
    // pdftoppm 输出 slide-1.png / slide-01.png，统一成 slide-N.png
    const outs = readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f))
    if (outs.length === 0) throw new Error('渲染失败：LibreOffice 没有生成页面')
    return outs
      .map(f => ({ f, n: Number(/\d+/.exec(f)![0]) }))
      .sort((a, b) => a.n - b.n)
      .map(({ f, n }) => {
        const target = join(dir, `slide-${n}.png`)
        if (f !== `slide-${n}.png`) writeFileSync(target, readFileSync(join(dir, f)))
        return target
      })
  }
}
