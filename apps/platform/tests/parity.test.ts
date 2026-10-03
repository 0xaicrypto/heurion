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
import { TurnRegistry } from '../src/mcp/turns.ts'
import { OpService } from '../src/ops/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * 人与 AI 操作能力相同（heurion2 的原则）：患者相关的每个界面接口都要有对应的 MCP 工具，
 * 或者登记「为什么不给 AI」。新加接口没登记时测试失败。
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
}
/** 图库：界面「图片 ▾ → 从 Unsplash 搜索」与 AI 同一个服务。 */
const IMAGE_PARITY: Record<string, string> = {
  'GET /api/images/search': 'image_search',
  'POST /api/docs/:id/slides/:slide/photo': 'slide_add_photo',
}

const NOT_FOR_AI: Record<string, string> = {
  'GET /api/images': '界面用来决定是否显示搜图入口；AI 从 image_search 返回的 unsplash_unconfigured 得知图库没配置',
  'DELETE /api/patients/:ptid': '删除患者不可恢复（与文档一致，AI 没有删除工具）',
  'POST /api/patients/:ptid/break-glass': '紧急访问由机构管理员以个人名义承担，理由须本人填写',
  'GET /api/patients-directory': '只用于紧急访问时选代号',
  'POST /api/patients/:ptid/proposals/:prid/:action{accept|reject}': '审核 AI 的提议是人的事（AI 不能采纳自己的提议）',
  'DELETE /api/studies/:sid': '删除研究项目由用户在界面上做（与删除文档、患者一致）',
}

describe('人机对等：患者与临床研究', () => {
  it('每个患者接口都有对应的 MCP 工具（或登记了不给 AI 的理由）', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, {} as HarnessPool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'par-'))), accounts: new Accounts(store, { secret: 's', devMode: false, devToken: 'd', devUser: 'd' }), devMode: false, devUser: 'd',
    })
    const routes = [...new Set(app.routes.filter(r => (/^\/api\/(patients|studies|images)/.test(r.path) || /\/photo$/.test(r.path)) && r.method !== 'ALL').map(r => `${r.method} ${r.path}`))]
    const MAP = { ...PATIENT_PARITY, ...STUDY_PARITY, ...IMAGE_PARITY }
    expect(routes.filter(r => !MAP[r] && !NOT_FOR_AI[r]), '新的患者 / 研究接口要登记对应的 MCP 工具，或在 NOT_FOR_AI 里写明理由').toEqual([])

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
    expect([...new Set([...Object.values(PATIENT_PARITY), ...Object.values(STUDY_PARITY), ...Object.values(IMAGE_PARITY)])].filter(t => !tools.has(t)), '登记的工具要真的存在').toEqual([])
  })
})
