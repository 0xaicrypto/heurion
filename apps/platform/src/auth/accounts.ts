import bcrypt from 'bcryptjs'
import type { Store, UserRow } from '../store/db.ts'
import { BotError, BotGuard, type Solution } from './bot-guard.ts'
import { devUserFor } from './dev.ts'
import { issueToken, verifyToken } from './token.ts'

/**
 * 账户（MIGRATION_PLAN.md §2.5 R1）：开放注册（第一个用户是管理员）、用户名 + 密码登录、可吊销的登录令牌。
 * 登录令牌是平台签名令牌（aud=web）带账户令牌版本 v：停用、改密码、强制下线时版本加一，旧令牌立即失效。
 * 开发模式下仍接受开发令牌（`<令牌>` / `<令牌>:<名字>`），e2e 与浏览器测试用；生产环境只认账户令牌。
 */

export class AuthError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429 = 400) {
    super(message)
  }
}

/** 对外的用户信息（不含密码哈希与令牌版本）。 */
export interface PublicUser {
  id: string
  username: string
  display_name: string
  role: UserRow['role']
  status: UserRow['status']
  created_at: string
  last_login_at: string | null
}

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id, username: u.username, display_name: u.display_name, role: u.role, status: u.status, created_at: u.created_at, last_login_at: u.last_login_at,
})

const USERNAME = /^[\p{L}\p{N}_.-]{2,32}$/u
const BCRYPT_COST = 10

export function checkPassword(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位'
  if (password.length > 72) return '密码最多 72 位'
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return '密码要同时包含字母和数字'
  return null
}

/** 固定窗口限流（进程内；多实例部署时换成共享存储，M2）。 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>()
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** 记一次并返回是否超限。 */
  hit(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs })
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k)
      return false
    }
    h.count++
    return h.count > this.limit
  }

  clear(key: string): void {
    this.hits.delete(key)
  }
}

export interface AccountOptions {
  secret: string
  /** 开发模式：接受开发令牌。 */
  devMode: boolean
  devToken: string
  devUser: string
  tokenTtlSeconds?: number
  /** 防机器人（默认按 secret 新建；测试传低难度）。 */
  botGuard?: BotGuard
}

/** 注册 / 登录请求里的防机器人字段：工作量证明的解，以及陷阱字段 website（人看不到）。 */
export interface BotFields { pow?: Solution; website?: unknown }

export class Accounts {
  private readonly registerLimit = new RateLimiter(5, 60 * 60_000)
  private readonly loginLimit = new RateLimiter(20, 5 * 60_000)
  private readonly failureLimit = new RateLimiter(5, 15 * 60_000)
  private readonly ttl: number
  readonly bots: BotGuard

  constructor(private readonly store: Store, private readonly opts: AccountOptions) {
    this.ttl = opts.tokenTtlSeconds ?? 14 * 24 * 3600
    this.bots = opts.botGuard ?? new BotGuard({ secret: opts.secret })
  }

  private checkBot(ip: string, input: BotFields): void {
    try {
      this.bots.verify(ip, input.pow, input.website)
    } catch (err) {
      if (err instanceof BotError) throw new AuthError('bot_check', '人机校验没有通过，请刷新页面后重试', 400)
      throw err
    }
  }

  register(input: { username?: string; password?: string; display_name?: string } & BotFields, ip: string): { user: PublicUser; token: string } {
    if (this.registerLimit.hit(ip)) throw new AuthError('rate_limited', '注册太频繁，请稍后再试', 429)
    this.checkBot(ip, input)
    const username = (input.username ?? '').trim().normalize('NFKC')
    const password = input.password ?? ''
    if (!USERNAME.test(username)) throw new AuthError('invalid_username', '用户名 2–32 位，可用字母、数字、中文、_ . -')
    const weak = checkPassword(password)
    if (weak) throw new AuthError('weak_password', weak)
    if (this.store.getUserByName(username)) throw new AuthError('username_taken', '这个用户名已被使用', 409)
    const displayName = (input.display_name ?? '').trim().slice(0, 40) || username
    const user = this.store.createUser({ username, display_name: displayName, password_hash: bcrypt.hashSync(password, BCRYPT_COST) })
    this.store.updateUser(user.id, { touchLogin: true })
    return { user: publicUser(this.store.getUser(user.id)!), token: this.tokenFor(user) }
  }

  login(input: { username?: string; password?: string } & BotFields, ip: string): { user: PublicUser; token: string } {
    if (this.loginLimit.hit(ip)) throw new AuthError('rate_limited', '登录太频繁，请稍后再试', 429)
    this.checkBot(ip, input)
    const username = (input.username ?? '').trim()
    const failKey = `u:${username.toLowerCase()}`
    const user = this.store.getUserByName(username)
    // 用户名不存在也做一次哈希比较，响应时间不暴露用户名是否存在
    const ok = bcrypt.compareSync(input.password ?? '', user?.password_hash ?? DUMMY_HASH)
    if (!user || !ok) {
      if (this.failureLimit.hit(failKey)) throw new AuthError('rate_limited', '密码错误次数过多，请 15 分钟后再试', 429)
      throw new AuthError('bad_credentials', '用户名或密码不对', 401)
    }
    if (user.status !== 'active') throw new AuthError('disabled', '账户已停用，请联系管理员', 403)
    this.failureLimit.clear(failKey)
    this.store.updateUser(user.id, { touchLogin: true })
    return { user: publicUser(this.store.getUser(user.id)!), token: this.tokenFor(user) }
  }

  /** 请求令牌 → 用户 id（账户令牌，或开发模式下的开发令牌）；无效返回 null。 */
  userFor(token: string | null | undefined): string | null {
    if (!token) return null
    if (token.startsWith('h1.')) {
      const claims = verifyToken(this.opts.secret, token, 'web')
      if (!claims) return null
      const user = this.store.getUser(claims.u)
      if (!user || user.status !== 'active' || user.token_version !== (claims.v ?? -1)) return null
      return user.id
    }
    return this.opts.devMode ? devUserFor(token, this.opts.devToken, this.opts.devUser) : null
  }

  /** 当前用户信息；开发用户没有账户记录。 */
  me(userId: string): PublicUser | { id: string; username: string; display_name: string; role: 'user'; dev: true } {
    const user = this.store.getUser(userId)
    if (user) return publicUser(user)
    return { id: userId, username: userId, display_name: userId, role: 'user', dev: true }
  }

  updateProfile(userId: string, input: { display_name?: string; current_password?: string; new_password?: string }): { user: PublicUser; token?: string } {
    const user = this.store.getUser(userId)
    if (!user) throw new AuthError('no_account', '开发用户没有账户资料', 400)
    let token: string | undefined
    if (input.new_password !== undefined) {
      if (!bcrypt.compareSync(input.current_password ?? '', user.password_hash)) throw new AuthError('bad_credentials', '当前密码不对', 401)
      const weak = checkPassword(input.new_password)
      if (weak) throw new AuthError('weak_password', weak)
      // 改密码让其他设备上的登录失效；当前设备拿新令牌
      const updated = this.store.updateUser(userId, { password_hash: bcrypt.hashSync(input.new_password, BCRYPT_COST), bumpTokenVersion: true })!
      token = this.tokenFor(updated)
    }
    if (input.display_name !== undefined) {
      const name = input.display_name.trim().slice(0, 40)
      if (!name) throw new AuthError('invalid_display_name', '显示名不能为空')
      this.store.updateUser(userId, { display_name: name })
    }
    return { user: publicUser(this.store.getUser(userId)!), ...(token ? { token } : {}) }
  }

  /** 退出所有设备：令牌版本加一。 */
  logoutEverywhere(userId: string): void {
    this.store.updateUser(userId, { bumpTokenVersion: true })
  }

  // —— 管理员 ——

  isAdmin(userId: string): boolean {
    return this.store.getUser(userId)?.role === 'admin'
  }

  listUsers(): Array<PublicUser & { doc_count: number; imported: boolean }> {
    return this.store.listUsers().map(u => ({ ...publicUser(u), doc_count: u.doc_count, imported: !!u.imported_from }))
  }

  adminUpdate(actorId: string, userId: string, patch: { role?: UserRow['role']; status?: UserRow['status'] }): PublicUser {
    const user = this.store.getUser(userId)
    if (!user) throw new AuthError('not_found', '用户不存在', 404)
    if (patch.role !== undefined && !['user', 'admin'].includes(patch.role)) throw new AuthError('invalid_role', '角色只能是 user 或 admin')
    if (patch.status !== undefined && !['active', 'disabled'].includes(patch.status)) throw new AuthError('invalid_status', '状态只能是 active 或 disabled')
    // 不能把最后一个管理员降级或停用（包括自己），否则没人能管理
    const losesAdmin = user.role === 'admin' && (patch.role === 'user' || patch.status === 'disabled')
    if (losesAdmin && this.store.listUsers().filter(u => u.role === 'admin' && u.status === 'active').length <= 1) {
      throw new AuthError('last_admin', '至少要保留一个可用的管理员', 409)
    }
    if (actorId === userId && patch.status === 'disabled') throw new AuthError('self_disable', '不能停用自己', 409)
    return publicUser(this.store.updateUser(userId, { ...patch, bumpTokenVersion: patch.status === 'disabled' })!)
  }

  adminResetPassword(userId: string, password: string): void {
    if (!this.store.getUser(userId)) throw new AuthError('not_found', '用户不存在', 404)
    const weak = checkPassword(password)
    if (weak) throw new AuthError('weak_password', weak)
    this.store.updateUser(userId, { password_hash: bcrypt.hashSync(password, BCRYPT_COST), bumpTokenVersion: true })
  }

  adminLogout(userId: string): void {
    if (!this.store.getUser(userId)) throw new AuthError('not_found', '用户不存在', 404)
    this.store.updateUser(userId, { bumpTokenVersion: true })
  }

  private tokenFor(user: UserRow): string {
    return issueToken(this.opts.secret, { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: this.ttl, v: user.token_version })
  }
}

/** 用户名不存在时比较用的哈希（任意固定值的 bcrypt 哈希）。 */
const DUMMY_HASH = bcrypt.hashSync('heurion-dummy-password-1', BCRYPT_COST)
