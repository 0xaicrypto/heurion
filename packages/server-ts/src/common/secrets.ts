/**
 * Rule 4 — 密钥/配置 fail-closed 解析（#GRAFANA_ADMIN_PASSWORD 事故模式）。
 *
 * 此前 server-ts 的 SERVER_SECRET 与 CHART_TOKEN_SECRET 缺配时静默回退到
 * 公开的 'dev-secret-key'，且生产启动不做检查 — 漏配即可被人用默认值签发
 * 管理员 JWT / 伪造图表直链。现在：
 *  - 非生产：保留 dev 回退（本地/测试零配置可跑）；
 *  - 生产（NODE_ENV/APP_ENV=production，与 main.ts #989 判定一致）：
 *    缺失或仍是 dev 默认值 → 抛错（启动即失败，绝不带默认密钥服务）。
 */
export const DEV_SECRET_FALLBACK = 'dev-secret-key'

/** #989: 生产判定走显式 APP_ENV/NODE_ENV — 与 main.ts schema sync 一致。 */
export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production'
}

/** SERVER_SECRET 单一解析点 — config/JWT/插件加密/chart-token 全走这里。 */
export function resolveServerSecret(): string {
  const raw = (process.env.SERVER_SECRET || '').trim()
  if (raw) {
    if (isProductionEnv() && raw === DEV_SECRET_FALLBACK) {
      throw new Error('SERVER_SECRET 仍是开发默认值(dev-secret-key) — 生产环境必须替换为随机密钥(openssl rand -hex 32)')
    }
    return raw
  }
  if (isProductionEnv()) {
    throw new Error('SERVER_SECRET 未配置 — 生产环境拒绝使用共享开发默认密钥启动(fail-closed, Rule 4)')
  }
  return DEV_SECRET_FALLBACK
}

/** chart/文件直链 token 签名密钥 — CHART_TOKEN_SECRET 优先，回落 SERVER_SECRET。 */
export function resolveChartTokenSecret(): string {
  const raw = (process.env.CHART_TOKEN_SECRET || '').trim()
  if (raw) return raw
  return resolveServerSecret()
}

/** 生产启动断言 — 在 main() 最早阶段调用，缺配置直接崩，不带病服务。 */
export function assertProductionSecrets(): void {
  if (!isProductionEnv()) return
  resolveServerSecret()
  resolveChartTokenSecret()
}
