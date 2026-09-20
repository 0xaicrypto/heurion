import { describe, test, expect, afterEach } from 'vitest'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import {
  resolveImage,
  downloadRemoteImage,
  setRemoteImageLookupForTest,
  setRemoteImageTransportForTest,
} from '../src/handlers/remote-image.js'

/**
 * #1072-4 — defaultTransport 生产路径真实 socket e2e。
 *
 * 此前生产钉定传输（node:http(s) + 钉定 lookup）在单测里完全没被跑到
 * （全部经由 setRemoteImageTransportForTest 注入 mock）— 安全核心缺 e2e。
 * 本文件起真实本地回环 http server，不经任何测试注入钩子（两钩子恒 null），
 * 直达生产传输：
 *  - 正向链路借道生产受信 origin 机制（SERVER_ORIGIN = 回环地址 — 正是
 *    worker↔server 内网直连部署的生产形态）：校验跳过回环 IP 黑名单，
 *    连接走真实 socket → defaultTransport；
 *  - rebinding 时序（打补丁 DNS + 真实攻击者 server）见 remote-image.test.ts
 *    #1057 用例1b（同样是钩子 null + 真实 socket 的生产路径）；
 *  - Content-Encoding：真实 server 回 gzip 响应体 → 解压后再 magic bytes
 *    判定（#1072-4 后半段）。
 */

// 16 字节最小 PNG 头（同 remote-image.test.ts 口径）。
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

afterEach(() => {
  // 生产路径 e2e：两钩子恒还原为 null（defaultTransport 直达）。
  setRemoteImageLookupForTest(null)
  setRemoteImageTransportForTest(null)
})

interface Server {
  origin: string
  close: () => Promise<void>
}

/** 真实回环 http server（node:http，无 mock）— handler 返回 body + headers。 */
async function startRealServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('#1072-4 defaultTransport 生产路径（真实 socket，无注入钩子）', () => {
  test('正向链路：真实回环 http server → 生产传输下载 → 图片字节原样返回', async () => {
    const s = await startRealServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
    })
    try {
      const url = `${s.origin}/api/v1/files/download/x.png`
      // 受信 origin = 操作员配置的回环 server（内网直连部署的生产形态）—
      // 校验跳过回环 IP 黑名单，连接走真实 socket（默认传输，无钉定）。
      const buf = await downloadRemoteImage(url, { trustedOrigins: [s.origin] })
      expect(buf.equals(PNG)).toBe(true)
    } finally {
      await s.close()
    }
  })

  test('集成链路：SERVER_ORIGIN 指向真实回环 server + 相对路径 ref → resolveImage 全链路', async () => {
    const s = await startRealServer((req, res) => {
      // 仅服务端签发的下载前缀形态可达（resolveRelativeFileRef 校验）
      if (req.url?.startsWith('/api/v1/files/download/')) {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG)
        return
      }
      res.writeHead(404)
      res.end()
    })
    process.env.SERVER_ORIGIN = s.origin
    try {
      const img = await resolveImage({ type: 'image', ref: '/api/v1/files/download/abc123?token=t', caption: 'Fig' })
      expect(img?.data.equals(PNG)).toBe(true)
      expect(img?.caption).toBe('Fig')
    } finally {
      delete process.env.SERVER_ORIGIN
      await s.close()
    }
  })

  test('Content-Encoding e2e：真实 server 回 gzip 响应体 → 解压后 magic bytes 判定通过', async () => {
    const gz = gzipSync(PNG)
    const s = await startRealServer((_req, res) => {
      // 裸 node:http 不会自动解压 — worker 端必须显式处理 Content-Encoding
      // （#1072-4：此前压缩响应会被 magic bytes 误判为非图片）。
      res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': String(gz.length) })
      res.end(gz)
    })
    try {
      const buf = await downloadRemoteImage(`${s.origin}/api/v1/files/download/x.png.gz`, { trustedOrigins: [s.origin] })
      expect(buf.equals(PNG)).toBe(true)
    } finally {
      await s.close()
    }
  })

  test('受信 origin 之外的回环目标仍被 SSRF 拦截（生产传输路径回归）', async () => {
    const s = await startRealServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    })
    try {
      // 不传 trustedOrigins → 回环地址必须被拒（生产传输未发起任何请求）。
      await expect(downloadRemoteImage(`${s.origin}/api/v1/files/download/x.png`)).rejects.toMatchObject({ code: 'private_address' })
    } finally {
      await s.close()
    }
  })
})
