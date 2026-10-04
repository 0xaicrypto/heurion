import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { ADMIN_TOOLS } from '../src/mcp/admin-tools.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { OpService } from '../src/ops/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * 人与 AI 操作能力相同（heurion2 的原则）：每个界面接口都要有对应的 MCP 工具，
 * 或者登记「为什么不给 AI」。新加接口没登记时测试失败（docs/design/AI_PERMISSIONS.md）。
 */
const PATIENT_PARITY: Record<string, string> = {
  'GET /api/patients': 'patient_list',
  'POST /api/patients': 'patient_create',
  'GET /api/patients/:ptid': 'patient_read',
  'PATCH /api/patients/:ptid': 'patient_update',
  'POST /api/patients/:ptid/team': 'patient_team',
  'DELETE /api/patients/:ptid/team/:uid': 'patient_team',
  'GET /api/patients/:ptid/access-log': 'patient_access_log',
  'GET /api/patients/:ptid/labs': 'labs_query',
  'POST /api/patients/:ptid/labs/:lid/:action{confirm|reject}': 'lab_resolve',
  'PATCH /api/patients/:ptid/labs/:lid': 'lab_edit',
  'POST /api/patients/:ptid/files': 'report_upload',
  'GET /api/patients/:ptid/files/:pfid': 'report_read',
  'POST /api/patients/:ptid/records/:rcid/labs': 'report_lab_add',
  'POST /api/patients/:ptid/records/:rcid/:action{confirm|reject}': 'report_resolve',
  'POST /api/patients/:ptid/docs': 'patient_doc_link',
  'DELETE /api/patients/:ptid/docs/:id': 'patient_doc_link',
}
const STUDY_PARITY: Record<string, string> = {
  'GET /api/studies': 'study_list',
  'POST /api/studies': 'study_create',
  'GET /api/studies/:sid': 'study_read',
  'PATCH /api/studies/:sid': 'study_update',
  'POST /api/studies/:sid/items': 'study_link',
  'DELETE /api/studies/:sid/items/:kind/:rid': 'study_link',
  'GET /api/studies/:sid/cohort': 'study_cohort_list',
  'POST /api/studies/:sid/cohort/preview': 'study_cohort_preview',
  'POST /api/studies/:sid/cohort': 'study_enroll',
  'DELETE /api/studies/:sid/cohort/:ptid': 'study_unenroll',
  'POST /api/studies/:sid/cohort/dataset': 'study_cohort_dataset',
  // 研究团队成员（研究团队协作）
  'GET /api/studies/:sid/members': 'study_members',
  'GET /api/studies/:sid/candidates': 'study_members',
  'POST /api/studies/:sid/members': 'study_members',
  'PATCH /api/studies/:sid/members/:uid': 'study_members',
  'DELETE /api/studies/:sid/members/:uid': 'study_members',
  'POST /api/studies/:sid/transfer': 'study_members',
}
/** 图库：界面「图片 ▾ → 从 Unsplash 搜索」与 AI 同一个服务。 */
const IMAGE_PARITY: Record<string, string> = {
  'GET /api/images/search': 'image_search',
  'POST /api/docs/:id/slides/:slide/photo': 'slide_add_photo',
}

/**
 * 其余全部接口（文档、资料库、数据集、记忆、机构、平台运营、账户……）→ MCP 工具（「工具.action」= 管理类工具的某个动作）。
 * AI 的权限 = 用户本人的权限（docs/design/AI_PERMISSIONS.md）：用户能做的，AI 都有对应工具。
 */
const ALL_PARITY: Record<string, string> = {
  // 文档与幻灯片
  'GET /api/docs': 'doc_list', 'GET /api/search': 'docs_search', 'POST /api/docs': 'doc_create',
  'GET /api/docs/:id': 'doc_read', 'GET /api/docs/:id/read': 'doc_read', 'GET /api/docs/:id/html': 'doc_read', 'GET /api/docs/:id/deck': 'slide_read',
  'GET /api/docs/:id/diff': 'doc_diff', 'POST /api/docs/:id/edit': 'doc_edit', 'GET /api/docs/:id/slides/:index/render.png': 'slide_render',
  'PATCH /api/docs/:id': 'doc_manage.rename', 'POST /api/docs/:id/duplicate': 'doc_manage.duplicate', 'DELETE /api/docs/:id': 'doc_manage.trash',
  'GET /api/trash': 'doc_manage.trash_list', 'POST /api/docs/:id/restore': 'doc_manage.restore', 'DELETE /api/docs/:id/purge': 'doc_manage.purge',
  'POST /api/docs/:id/save': 'doc_manage.save_version', 'POST /api/docs/:id/versions/:seq/restore': 'doc_manage.restore_version',
  'POST /api/docs/:id/turns/:turnId/revert': 'doc_manage.revert_turn',
  'GET /api/docs/:id/export.docx': 'doc_manage.export', 'GET /api/docs/:id/export.pptx': 'doc_manage.export', 'GET /api/docs/:id/export.md': 'doc_manage.export',
  'POST /api/docs/:id/assets': 'asset_upload', 'GET /api/assets/:id/provenance': 'asset_provenance.read',
  'GET /api/deck-templates': 'deck_templates', 'GET /api/deck-themes': 'deck_templates',
  'GET /api/projects': 'project_manage.list', 'POST /api/projects': 'project_manage.create', 'PATCH /api/projects/:pid': 'project_manage.rename', 'DELETE /api/projects/:pid': 'project_manage.delete',
  // 评论与引用
  'POST /api/docs/:id/comments': 'comment_manage.create', 'POST /api/docs/:id/comments/:cid/replies': 'comment_reply',
  'POST /api/docs/:id/comments/:cid/:action{resolve|reopen}': 'comment_manage.resolve', 'DELETE /api/docs/:id/comments/:cid': 'comment_manage.delete',
  'POST /api/docs/:id/citations': 'insert_citation', 'POST /api/docs/:id/citations/import': 'import_references', 'POST /api/docs/:id/verify': 'verify_claims',
  // 资料库
  'GET /api/kb': 'kb_manage.list', 'GET /api/kb-status': 'kb_manage.status', 'POST /api/kb': 'kb_manage.upload', 'PATCH /api/kb/:fid': 'kb_manage.update', 'DELETE /api/kb/:fid': 'kb_manage.delete',
  'GET /api/kb-search': 'kb_search', 'GET /api/kb/:fid/text': 'kb_read', 'GET /api/kb/:fid/file': 'kb_read',
  // 数据集
  'GET /api/datasets': 'dataset_list', 'GET /api/datasets/:did': 'dataset_describe', 'GET /api/datasets/:did/preview': 'dataset_open',
  'POST /api/datasets': 'dataset_manage.upload', 'PATCH /api/datasets/:did': 'dataset_manage.rename', 'POST /api/datasets/:did/phi': 'dataset_manage.resolve_phi', 'DELETE /api/datasets/:did': 'dataset_manage.delete',
  // 记忆
  'GET /api/memory': 'memory_manage.list', 'GET /api/memory/:mid/events': 'memory_manage.events', 'PATCH /api/memory/:mid': 'memory_manage.edit',
  'POST /api/memory': 'memory_propose', 'DELETE /api/memory/:mid': 'memory_forget', 'POST /api/memory/review': 'memory_review',
  'PUT /api/memory/settings': 'memory_manage.pause', 'GET /api/memory-export': 'memory_manage.export', 'POST /api/memory-import': 'memory_manage.import', 'DELETE /api/memory': 'memory_manage.clear_all',
  // 任务队列、账户
  'GET /api/queue': 'task_queue.list', 'POST /api/queue/:jid/cancel': 'task_queue.cancel',
  'GET /api/me': 'account.view', 'PATCH /api/me': 'account.update_profile', 'POST /api/auth/logout-everywhere': 'account.logout_everywhere',
  // 机构（机构管理员）
  'GET /api/tenant': 'tenant_admin.view', 'PATCH /api/tenant': 'tenant_admin.update_settings', 'GET /api/tenant/members': 'tenant_admin.members', 'PATCH /api/tenant/members/:uid': 'tenant_admin.set_member',
  'GET /api/tenant/invites': 'tenant_admin.invites', 'POST /api/tenant/invites': 'tenant_admin.invite', 'DELETE /api/tenant/invites/:code': 'tenant_admin.revoke_invite',
  'GET /api/tenant/audit': 'tenant_admin.audit', 'GET /api/tenant/colleagues': 'tenant_admin.colleagues', 'GET /api/tenant/studies': 'tenant_admin.studies',
  'GET /api/tenant/templates': 'org_template.list', 'POST /api/tenant/templates': 'org_template.create', 'PATCH /api/tenant/templates/:otid': 'org_template.update', 'DELETE /api/tenant/templates/:otid': 'org_template.delete',
  'PUT /api/tenant/templates/:otid/logo': 'org_template.set_logo', 'DELETE /api/tenant/templates/:otid/logo': 'org_template.clear_logo',
  // 平台运营
  'GET /api/platform/tenants': 'platform_admin.tenants', 'POST /api/platform/tenants': 'platform_admin.create_tenant', 'PATCH /api/platform/tenants/:tid': 'platform_admin.set_tenant_status',
  'GET /api/admin/users': 'platform_admin.users', 'PATCH /api/admin/users/:uid': 'platform_admin.update_user', 'POST /api/admin/users/:uid/logout': 'platform_admin.logout_user',
  'GET /api/admin/settings': 'platform_admin.settings', 'PUT /api/admin/settings': 'platform_admin.update_settings', 'GET /api/admin/audit': 'platform_admin.audit',
  // 患者、研究的高权限操作
  'GET /api/patients-directory': 'patient_admin.directory', 'POST /api/patients/:ptid/break-glass': 'patient_admin.break_glass', 'DELETE /api/patients/:ptid': 'patient_admin.delete',
  'DELETE /api/studies/:sid': 'study_admin.delete', 'POST /api/studies/:sid/transfer': 'study_admin.transfer', 'POST /api/studies/:sid/handover': 'tenant_admin.handover',
  // AI 发起的待确认操作：AI 能查状态，确认 / 拒绝只能用户本人（见 NOT_FOR_AI）
  'GET /api/actions': 'action_status', 'GET /api/actions/:aid': 'action_status',
}

/** AI 发起后要用户在确认卡上确认才执行的动作（不可恢复的删除、权限与安全、以机构身份对外的标识）。 */
const AI_CONFIRM = [
  'account.logout_everywhere',
  'tenant_admin.update_settings', 'tenant_admin.set_member', 'tenant_admin.invite', 'tenant_admin.handover',
  'org_template.delete', 'org_template.set_logo', 'org_template.clear_logo',
  'platform_admin.create_tenant', 'platform_admin.set_tenant_status', 'platform_admin.update_user', 'platform_admin.logout_user', 'platform_admin.update_settings',
  'doc_manage.purge', 'comment_manage.delete', 'dataset_manage.delete', 'kb_manage.delete', 'memory_manage.clear_all',
  'patient_admin.break_glass', 'patient_admin.delete', 'study_admin.delete', 'study_admin.transfer',
]

/** 不给 AI 的（只是界面机制，或必须本人亲自做）；每条写清理由。 */
const NOT_FOR_AI: Record<string, string> = {
  'GET /api/images': '界面用来决定是否显示搜图入口；AI 从 image_search 返回的 unsplash_unconfigured 得知图库没配置',
  // 知家（PATIENT.md）：手动录入是家人自己填的数值，直接为已确认；AI 的化验只能来自报告提取（report_upload / report_lab_add）
  'POST /api/patients/:ptid/labs': '手动录入化验是家人本人的操作（AI 的化验来自上传报告的提取与补项）',
  'POST /api/patients/:ptid/proposals/:prid/:action{accept|reject}': '审核 AI 的提议是人的事（AI 不能采纳自己的提议）',
  'POST /api/docs/:id/suggestions/:group/:action{accept|reject}': '采纳 / 拒绝 AI 的修订是人的事（AI 不能采纳自己的修订）',
  'POST /api/memory/changes/:cid/:action{apply|dismiss}': '采纳 / 忽略 AI 的记忆整理建议是人的事',
  'POST /api/actions/:aid/:decision{confirm|reject}': '确认 / 拒绝 AI 发起的高风险操作只能由用户本人在界面上做',
  'POST /api/docs/:id/chat': '给 AI 发消息的入口（AI 本身就在这轮对话里）',
  'POST /api/docs/:id/comments/:cid/ask': '把评论交给 AI 处理的入口（AI 收到后用 comments_list / comment_reply 处理）',
  'POST /api/docs/:id/turns/:turnId/retry': '重跑一轮 AI 对话的入口（AI 不能自己重开对话）',
  'POST /api/cancel': '停止当前 AI 回合的按钮（AI 不能停自己）',
  'GET /api/docs/:id/stream': '浏览器的实时事件流（SSE）',
  'GET /api/assets/:id': '图片字节给浏览器显示；AI 用 slide_render / 工作区文件看图',
  'GET /api/auth/challenge': '登录前的人机校验（AI 不登录、不注册）', 'GET /api/auth/config': '登录页配置',
  'POST /api/auth/login': 'AI 不经手密码', 'POST /api/auth/register': 'AI 不注册账号', 'POST /api/auth/password-code': 'AI 不经手密码与验证码', 'POST /api/auth/reset-password': 'AI 不经手密码与验证码',
  'POST /api/admin/users/:uid/reset-password': 'AI 不经手密码（平台运营本人在界面上重置）',
  'POST /api/me/email': '绑定邮箱要本人收验证码', 'POST /api/me/email-code': '绑定邮箱要本人收验证码',
  'POST /api/me/claim-dev-data': '只在开发模式下给管理员本人认领开发数据',
  'GET /api/invites/:code': '邀请链接的公开预览（注册前用）',
}

describe('人机对等：每个接口（AI 的权限 = 用户的权限）', () => {
  it('每个接口都有对应的 MCP 工具（或登记了不给 AI 的理由）', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, {} as HarnessPool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'par-'))), accounts: new Accounts(store, { secret: 's', devMode: false, devToken: 'd', devUser: 'd' }), devMode: false, devUser: 'd',
    })
    const routes = [...new Set(app.routes.filter(r => r.path.startsWith('/api/') && r.method !== 'ALL').map(r => `${r.method} ${r.path}`))]
    const MAP: Record<string, string> = { ...PATIENT_PARITY, ...STUDY_PARITY, ...IMAGE_PARITY, ...ALL_PARITY }
    expect(routes.filter(r => !MAP[r] && !NOT_FOR_AI[r]), '新接口要登记对应的 MCP 工具（AI 的权限 = 用户的权限），或在 NOT_FOR_AI 里写明理由').toEqual([])
    expect(Object.keys(MAP).filter(r => NOT_FOR_AI[r]), '同一个接口不能既给 AI 又不给').toEqual([])
    expect(Object.keys({ ...MAP, ...NOT_FOR_AI }).filter(r => !routes.includes(r)), '登记的接口要真的存在').toEqual([])

    const claims = verifyToken('s', issueToken('s', { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs, ops: new OpService(docs), turns: new TurnRegistry(), secret: 's', claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'par2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => tmpdir(), isLiveSession: () => true,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'par', version: '0' })
    await client.connect(b)
    const tools = new Set((await client.listTools()).tools.map(t => t.name))
    const used = [...new Set([...Object.values(PATIENT_PARITY), ...Object.values(STUDY_PARITY), ...Object.values(IMAGE_PARITY), ...Object.values(ALL_PARITY)])]
    expect(used.map(t => t.split('.')[0]!).filter(t => !tools.has(t)), '登记的工具要真的存在').toEqual([])
    // 「工具.action」：管理类工具里真有这个动作，且它调用的正是登记的那个接口
    const toRe = (route: string) => { const [m, p] = route.split(' ') as [string, string]; return { m, re: new RegExp(`^${p.replace(/:[a-zA-Z]+\{([^}]+)\}/g, '($1)').replace(/:[a-zA-Z]+/g, '[^/?]+')}(\\?.*)?$`) } }
    const wrong: string[] = []
    for (const [route, target] of Object.entries(ALL_PARITY)) {
      const [tool, action] = target.split('.')
      if (!action) continue
      const op = ADMIN_TOOLS.find(t => t.name === tool)?.actions[action]
      if (!op) { wrong.push(`${route} → ${target}：没有这个动作`); continue }
      const sample = op.path(new Proxy({}, { get: (_t, k) => k === 'format' ? route.match(/export\.(\w+)/)?.[1] ?? 'docx' : k === 'seq' ? 1 : 'x1' }))
      const { m, re } = toRe(route)
      const same = (op.method === m && re.test(sample)) || Object.values(ADMIN_TOOLS.find(t => t.name === tool)!.actions).some(o => o.method === m && re.test(o.path(new Proxy({}, { get: () => 'x1' }))))
      if (!same) wrong.push(`${route} → ${target}（${op.method} ${sample}）`)
    }
    expect(wrong, '登记的动作要调用对应的接口').toEqual([])
    // 需要用户确认的动作（AI_CONFIRM）与工具定义一致
    const confirmed = ADMIN_TOOLS.flatMap(t => Object.entries(t.actions).filter(([, o]) => o.confirm).map(([a]) => `${t.name}.${a}`)).sort()
    expect(confirmed).toEqual([...AI_CONFIRM].sort())
  })
})
