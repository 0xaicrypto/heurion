import type { Store, TenantInviteRow, TenantRow, UserRow } from '../store/db.ts'

/**
 * 租户（机构）：设计见 docs/design/TENANCY.md。
 * - 一个用户只属于一个租户；个人注册得到个人租户（本人为机构管理员），经邀请注册则加入邀请方的租户。
 * - 机构管理员：成员（角色、停用）、邀请、机构设置、本机构审计。平台运营（users.role=admin）：建机构、停用 / 恢复机构。
 * - 平台运营不经这里读任何租户的业务数据；患者数据（第二期）按租户分库，见设计稿。
 */

export interface TenantSettings {
  /** 患者模块（第二期）是否开放 */
  patient_module: boolean
  /** 患者数据能否发给外部模型（托管版默认开） */
  external_model_for_patients: boolean
  /** 患者默认可见范围：创建者 + 诊疗组 / 本机构全员 */
  patient_visibility: 'care_team' | 'tenant'
}

export const DEFAULT_SETTINGS: TenantSettings = { patient_module: true, external_model_for_patients: true, patient_visibility: 'care_team' }

export class TenantError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

export interface TenantView {
  id: string; name: string; kind: TenantRow['kind']; status: TenantRow['status']
  role: UserRow['tenant_role']; settings: TenantSettings; members: number
}

export interface MemberView {
  id: string; username: string; display_name: string; email: string | null
  tenant_role: UserRow['tenant_role']; status: UserRow['status']; created_at: string; last_login_at: string | null; doc_count: number
}

const INVITE_DAYS_MAX = 30

export class TenantService {
  constructor(private readonly store: Store, private readonly opts: { devMode: boolean }) {}

  /** 用户所在的租户。开发令牌用户（没有账户记录）在开发模式下各有一个虚拟个人租户。 */
  of(userId: string): TenantRow {
    const u = this.store.getUser(userId)
    if (u?.tenant_id) {
      const t = this.store.getTenant(u.tenant_id)
      if (t) return t
    }
    if (!u && this.opts.devMode) {
      const id = 'tdev_' + userId.replace(/[^A-Za-z0-9_-]/g, '_')
      return this.store.getTenant(id) ?? this.store.createTenant({ id, name: `${userId}（开发）`, kind: 'personal' })
    }
    throw new TenantError('no_tenant', '账户没有所属机构', 403)
  }

  /** 租户角色（开发用户是自己虚拟租户的管理员）。 */
  roleOf(userId: string): UserRow['tenant_role'] {
    const u = this.store.getUser(userId)
    return u ? u.tenant_role : 'admin'
  }

  /** 机构是否可用（停用的机构，成员不能登录、令牌失效）。 */
  active(userId: string): boolean {
    try { return this.of(userId).status === 'active' } catch { return false }
  }

  settings(t: TenantRow): TenantSettings {
    let raw: Partial<TenantSettings> = {}
    try { raw = JSON.parse(t.settings || '{}') as Partial<TenantSettings> } catch { /* 坏的设置当默认 */ }
    return { ...DEFAULT_SETTINGS, ...raw }
  }

  view(userId: string): TenantView {
    const t = this.of(userId)
    return { id: t.id, name: t.name, kind: t.kind, status: t.status, role: this.roleOf(userId), settings: this.settings(t), members: this.store.tenantMembers(t.id).length || 1 }
  }

  private requireAdmin(actor: string): TenantRow {
    const t = this.of(actor)
    if (this.roleOf(actor) !== 'admin') throw new TenantError('forbidden', '只有机构管理员能做这件事', 403)
    return t
  }

  update(actor: string, patch: { name?: unknown; settings?: Partial<Record<keyof TenantSettings, unknown>> }): TenantView {
    const t = this.requireAdmin(actor)
    const next: Parameters<Store['updateTenant']>[1] = {}
    if (typeof patch.name === 'string') {
      const name = patch.name.trim().slice(0, 60)
      if (!name) throw new TenantError('bad_name', '机构名称不能为空')
      next.name = name
    }
    if (patch.settings && typeof patch.settings === 'object') {
      const cur = this.settings(t)
      const s = patch.settings
      if (typeof s.patient_module === 'boolean') cur.patient_module = s.patient_module
      if (typeof s.external_model_for_patients === 'boolean') cur.external_model_for_patients = s.external_model_for_patients
      if (s.patient_visibility === 'care_team' || s.patient_visibility === 'tenant') cur.patient_visibility = s.patient_visibility
      next.settings = JSON.stringify(cur)
    }
    this.store.updateTenant(t.id, next)
    return this.view(actor)
  }

  // —— 成员 ——

  members(actor: string): MemberView[] {
    const t = this.requireAdmin(actor)
    return this.store.tenantMembers(t.id).map(memberView)
  }

  /** 改成员的机构角色或停用 / 启用（只能管本机构的人；不能让机构失去最后一位管理员）。 */
  setMember(actor: string, userId: string, patch: { tenant_role?: unknown; status?: unknown }): MemberView {
    const t = this.requireAdmin(actor)
    const u = this.store.getUser(userId)
    if (!u || u.tenant_id !== t.id) throw new TenantError('not_found', '成员不存在', 404)
    const role = patch.tenant_role === 'admin' || patch.tenant_role === 'member' ? patch.tenant_role : undefined
    const status = patch.status === 'active' || patch.status === 'disabled' ? patch.status : undefined
    const losesAdmin = u.tenant_role === 'admin' && (role === 'member' || status === 'disabled')
    if (losesAdmin && this.store.tenantMembers(t.id).filter(m => m.tenant_role === 'admin' && m.status === 'active').length <= 1) {
      throw new TenantError('last_admin', '机构至少要有一位管理员', 409)
    }
    if (role) this.store.setTenantRole(u.id, role)
    if (status) this.store.updateUser(u.id, { status, bumpTokenVersion: status === 'disabled' })
    return memberView({ ...this.store.getUser(u.id)!, doc_count: 0 })
  }

  // —— 邀请 ——

  invite(actor: string, input: { role?: unknown; email?: unknown; days?: unknown }): TenantInviteRow {
    const t = this.requireAdmin(actor)
    const role = input.role === 'admin' ? 'admin' : 'member'
    const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim().toLowerCase().slice(0, 120) : null
    const days = Math.min(INVITE_DAYS_MAX, Math.max(1, Number(input.days) || 7))
    // 个人租户开始邀请别人：变成机构
    if (t.kind === 'personal') this.store.updateTenant(t.id, { kind: 'org' })
    return this.store.addInvite({ tenant_id: t.id, role, email, created_by: actor, days })
  }

  invites(actor: string): TenantInviteRow[] {
    return this.store.listInvites(this.requireAdmin(actor).id)
  }

  revokeInvite(actor: string, code: string): void {
    const t = this.requireAdmin(actor)
    const inv = this.store.getInvite(code)
    if (!inv || inv.tenant_id !== t.id) throw new TenantError('not_found', '邀请不存在', 404)
    this.store.revokeInvite(code)
  }

  /** 邀请是否可用（注册页显示「加入 XX」；不需要登录）。 */
  checkInvite(code: string): { tenant: string; role: TenantInviteRow['role']; email: string | null } {
    const inv = this.usableInvite(code)
    return { tenant: this.store.getTenant(inv.tenant_id)!.name, role: inv.role, email: inv.email }
  }

  usableInvite(code: string): TenantInviteRow {
    const inv = typeof code === 'string' ? this.store.getInvite(code) : undefined
    if (!inv || inv.revoked_at) throw new TenantError('invite_invalid', '邀请链接无效', 404)
    if (inv.used_at) throw new TenantError('invite_used', '这个邀请链接已经用过了', 409)
    if (Date.parse(inv.expires_at) < Date.now()) throw new TenantError('invite_expired', '邀请链接已过期，请让管理员重新发一个')
    const t = this.store.getTenant(inv.tenant_id)
    if (!t || t.status !== 'active') throw new TenantError('tenant_suspended', '这个机构已停用', 403)
    return inv
  }

  // —— 平台运营 ——

  private requireOperator(actor: string): void {
    if (this.store.getUser(actor)?.role !== 'admin') throw new TenantError('forbidden', '只有平台运营能做这件事', 403)
  }

  listAll(actor: string) {
    this.requireOperator(actor)
    return this.store.listTenants().map(t => ({ id: t.id, name: t.name, kind: t.kind, status: t.status, created_at: t.created_at, members: t.members, admins: t.admins, docs: t.docs }))
  }

  /** 新建机构：返回给首位管理员的邀请（平台运营不成为该机构的成员）。 */
  createOrg(actor: string, input: { name?: unknown; admin_email?: unknown }): { tenant: TenantRow; invite: TenantInviteRow } {
    this.requireOperator(actor)
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : ''
    if (!name) throw new TenantError('bad_name', '机构名称不能为空')
    const tenant = this.store.createTenant({ name, kind: 'org', created_by: actor })
    const email = typeof input.admin_email === 'string' && input.admin_email.trim() ? input.admin_email.trim().toLowerCase() : null
    const invite = this.store.addInvite({ tenant_id: tenant.id, role: 'admin', email, created_by: actor, days: INVITE_DAYS_MAX })
    return { tenant, invite }
  }

  setStatus(actor: string, tenantId: string, status: unknown): void {
    this.requireOperator(actor)
    const t = this.store.getTenant(tenantId)
    if (!t) throw new TenantError('not_found', '机构不存在', 404)
    if (status !== 'active' && status !== 'suspended') throw new TenantError('bad_status', '状态只能是 active 或 suspended')
    if (status === 'suspended' && this.store.getUser(actor)?.tenant_id === tenantId) throw new TenantError('self', '不能停用自己所在的机构', 409)
    this.store.updateTenant(t.id, { status })
  }
}

const memberView = (u: UserRow & { doc_count: number }): MemberView => ({
  id: u.id, username: u.username, display_name: u.display_name, email: u.email ?? null, tenant_role: u.tenant_role, status: u.status,
  created_at: u.created_at, last_login_at: u.last_login_at, doc_count: u.doc_count,
})
