# Knowledge Base Evolution — TDD Test Design

> 本文档遵循 TDD 原则：先写测试，再写实现。
> 覆盖 Query Router、显式知识库命令、Knowledge Gap 三个新模块，
> 以及保护现有行为的回归测试。

---

## 0. 测试原则

1. **单元测试优先**：每个新函数/类都有独立、快速的单元测试。
2. **回归测试覆盖**：任何改动不得破坏现有 chat、facts extraction、patient context 行为。
3. **成本可观测**：测试必须能验证"规则层命中"和"LLM fallback 次数"。
4. **行为黑盒**：测试用例描述用户行为，不绑定实现细节。
5. **可重复**：所有测试使用临时目录/in-memory DB，不依赖外部 LLM 服务。

---

## 1. Query Router 测试

### 1.1 现有测试文件

- `packages/server-ts/tests/query-router.test.ts`

### 1.2 需要扩展的类型

```typescript
export type QueryIntent =
  | 'sql'
  | 'vector'
  | 'file'
  | 'knowledge_command'
  | 'mixed'

export type KnowledgeCommandType =
  | 'kb_search'
  | 'kb_remember'
  | 'kb_summarize'
  | 'kb_gaps'
  | 'kb_resolve_gap'
  | 'unknown'
```

### 1.3 单元测试：`classifyQuery`

```typescript
describe('P3 — Query Router (cost-controlled)', () => {
  describe('rule layer — zero LLM cost', () => {
    test.each([
      ['ZL 的年龄', 'sql'],
      ['患者列表', 'sql'],
      ['#文件 CT报告', 'file'],
      ['查看上传的CT', 'file'],
      ['NSCLC 免疫治疗进展', 'vector'],
      ['EGFR 管理策略', 'vector'],
      ['搜索我的知识库关于 NSCLC', 'knowledge_command'],
      ['记住：ZQ 对 osimertinib 不耐受', 'knowledge_command'],
      ['根据知识库总结 EGFR 经验', 'knowledge_command'],
      ['查看我的未解问题', 'knowledge_command'],
    ])('classifyQuery("%s") → %s', (q, expected) => {
      expect(classifyQuery(q)).toBe(expected)
    })

    test('rule layer should handle 80%+ of common queries', () => {
      const samples = [/* 50 typical queries */]
      const ruleHits = samples.filter(q => classifyQuery(q) !== 'mixed').length
      expect(ruleHits / samples.length).toBeGreaterThanOrEqual(0.8)
    })
  })

  describe('fallback layer', () => {
    test('empty query → mixed', () => {
      expect(classifyQuery('')).toBe('mixed')
    })

    test('ambiguous query triggers LLM classifier (mocked)', async () => {
      const result = await classifyQueryLLM('那个谁最近怎么样')
      expect(['sql', 'vector', 'file', 'knowledge_command', 'mixed']).toContain(result)
    })

    test('LLM fallback returns unknown → mixed for safety', async () => {
      const result = await classifyQueryLLM('asdfghjkl')
      expect(result).toBe('mixed')
    })
  })
})
```

### 1.4 单元测试：`routeQuery` / source whitelist

```typescript
describe('routeQuery with source whitelist', () => {
  test('sql intent only opens sql source', () => {
    const routes = routeQuery('ZL 的年龄', 'sql')
    expect(routes).toEqual(['sql'])
  })

  test('vector intent only opens vector source', () => {
    const routes = routeQuery('NSCLC 免疫治疗', 'vector')
    expect(routes).toEqual(['vector'])
  })

  test('knowledge_command intent routes to command handler', () => {
    const routes = routeQuery('搜索知识库', 'knowledge_command')
    expect(routes).toEqual(['knowledge_command'])
  })

  test('mixed intent opens ordered sources', () => {
    const routes = routeQuery('总结 ZL 的情况', 'mixed')
    expect(routes).toEqual(['sql', 'vector'])
  })
})
```

### 1.5 集成测试：`router()` 完整流程

```typescript
describe('router() integration', () => {
  test('returns intent, routes, and cost metadata', () => {
    const result = router('搜索我的知识库关于 NSCLC')
    expect(result.intent).toBe('knowledge_command')
    expect(result.routes).toEqual(['knowledge_command'])
    expect(result.ruleHit).toBe(true)
    expect(result.llmFallback).toBe(false)
  })

  test('fallback query records LLM usage', async () => {
    const result = await router('帮我看看那个病人最近咋样')
    expect(result.llmFallback).toBe(true)
    expect(result.cost.llmCalls).toBe(1)
  })
})
```

### 1.6 回归测试：已有查询行为不变

```typescript
describe('regression — existing queries', () => {
  test('patient demographic queries still route to sql', () => {
    expect(classifyQuery('ZL 的年龄是多少？')).toBe('sql')
    expect(classifyQuery('What is the patient name')).toBe('sql')
  })

  test('file references still route to file', () => {
    expect(classifyQuery('#文件 CT报告')).toBe('file')
  })

  test('clinical questions still route to vector', () => {
    expect(classifyQuery('NSCLC 免疫治疗有什么进展')).toBe('vector')
  })

  test('summary queries still route to mixed', () => {
    expect(classifyQuery('帮我总结一下 ZL 的情况')).toBe('mixed')
  })
})
```

---

## 2. Knowledge Command Handler 测试

### 2.1 测试文件

- 新建：`packages/server-ts/tests/knowledge-command-handler.test.ts`

### 2.2 需要实现的模块

```typescript
// src/modules/knowledge/knowledge-command-handler.ts
export function parseKnowledgeCommand(query: string): {
  command: KnowledgeCommandType
  payload: string
}

export async function handleKnowledgeCommand(
  ctx: CommandContext,
  cmd: KnowledgeCommandType,
  payload: string,
): Promise<CommandResult>
```

### 2.3 单元测试：`parseKnowledgeCommand`

```typescript
describe('parseKnowledgeCommand', () => {
  test.each([
    ['搜索我的知识库关于 NSCLC', 'kb_search', 'NSCLC'],
    ['搜索知识库 NSCLC', 'kb_search', 'NSCLC'],
    ['kb search NSCLC', 'kb_search', 'NSCLC'],
    ['记住：ZQ 对 osimertinib 不耐受', 'kb_remember', 'ZQ 对 osimertinib 不耐受'],
    ['记住 ZQ 对 osimertinib 不耐受', 'kb_remember', 'ZQ 对 osimertinib 不耐受'],
    ['根据我的知识库总结 EGFR 治疗经验', 'kb_summarize', 'EGFR 治疗经验'],
    ['查看我的未解问题', 'kb_gaps', ''],
    ['kb gaps', 'kb_gaps', ''],
  ])('"%s" → command=%s, payload=%j', (q, cmd, payload) => {
    const result = parseKnowledgeCommand(q)
    expect(result.command).toBe(cmd)
    expect(result.payload).toBe(payload)
  })

  test('non-command query → unknown', () => {
    const result = parseKnowledgeCommand('ZL 的 CT 结果怎么样')
    expect(result.command).toBe('unknown')
  })
})
```

### 2.4 单元测试：`handleKnowledgeCommand — kb_search`

```typescript
describe('handleKnowledgeCommand — kb_search', () => {
  test('returns search results from memory projection', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_search', 'NSCLC 免疫治疗')
    expect(result.type).toBe('kb_search_result')
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]).toHaveProperty('source')
    expect(result.items[0]).toHaveProperty('content')
  })

  test('empty payload returns helpful hint', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_search', '')
    expect(result.type).toBe('error')
    expect(result.message).toContain('请告诉我你想搜索什么')
  })

  test('no results returns empty but not error', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_search', '不存在的主题 xyz123')
    expect(result.type).toBe('kb_search_result')
    expect(result.items).toEqual([])
    expect(result.summary).toContain('没有找到')
  })
})
```

### 2.5 单元测试：`handleKnowledgeCommand — kb_remember`

```typescript
describe('handleKnowledgeCommand — kb_remember', () => {
  test('extracts fact and saves to FactsStore', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_remember', 'ZQ 对 osimertinib 不耐受')
    expect(result.type).toBe('kb_remembered')
    expect(result.factId).toBeTruthy()

    const fact = ctx.factsStore.get(result.factId)
    expect(fact.content).toContain('ZQ')
    expect(fact.content).toContain('osimertinib')
  })

  test('low confidence fact goes to confirmation queue', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_remember', '可能也许 ZQ 有点副作用')
    expect(result.type).toBe('kb_pending_confirmation')
    expect(result.confidence).toBeLessThan(0.85)
  })

  test('empty payload returns error', async () => {
    const result = await handleKnowledgeCommand(ctx, 'kb_remember', '')
    expect(result.type).toBe('error')
  })
})
```

### 2.6 单元测试：`handleKnowledgeCommand — kb_summarize`

```typescript
describe('handleKnowledgeCommand — kb_summarize', () => {
  test('retrieves relevant facts and returns summary', async () => {
    ctx.factsStore.add({ category: 'fact', importance: 5, content: 'EGFR T790M 突变使用 osimertinib' })
    ctx.factsStore.add({ category: 'fact', importance: 4, content: 'EGFR 19del 一线使用 osimertinib' })

    const result = await handleKnowledgeCommand(ctx, 'kb_summarize', 'EGFR 治疗')
    expect(result.type).toBe('kb_summary')
    expect(result.summary).toContain('osimertinib')
  })
})
```

### 2.7 单元测试：`handleKnowledgeCommand — kb_gaps`

```typescript
describe('handleKnowledgeCommand — kb_gaps', () => {
  test('lists open knowledge gaps', async () => {
    ctx.gapService.create({ content: 'ZQ 的实际 PFS 是多少？' })

    const result = await handleKnowledgeCommand(ctx, 'kb_gaps', '')
    expect(result.type).toBe('kb_gaps')
    expect(result.gaps.length).toBe(1)
    expect(result.gaps[0].content).toContain('PFS')
  })
})
```

---

## 3. Knowledge Gap 服务测试

### 3.1 测试文件

- 新建：`packages/server-ts/tests/knowledge-gap-service.test.ts`
- 回归集成：扩展 `scripts/regression-test.sh`

### 3.2 需要实现的模块

```typescript
// src/modules/knowledge/knowledge-gap.service.ts
export class KnowledgeGapService {
  create(gap: CreateGapInput): KnowledgeGap
  list(filter: GapFilter): KnowledgeGap[]
  resolve(gapId: string, answer: string): KnowledgeGap
  ignore(gapId: string): KnowledgeGap
}
```

### 3.3 单元测试：CRUD

```typescript
describe('KnowledgeGapService', () => {
  test('create gap with required fields', () => {
    const gap = service.create({
      workspaceId: 'ws_1',
      content: 'ZQ 对 osimertinib 的实际耐受性？',
      source: 'chat',
      sourceId: 'chat_123',
    })
    expect(gap.id).toBeTruthy()
    expect(gap.status).toBe('open')
    expect(gap.content).toBe('ZQ 对 osimertinib 的实际耐受性？')
  })

  test('list open gaps only', () => {
    const openGap = service.create({ content: 'Q1', workspaceId: 'ws_1', source: 'user' })
    const answeredGap = service.create({ content: 'Q2', workspaceId: 'ws_1', source: 'user' })
    service.resolve(answeredGap.id, 'A2')

    const open = service.list({ workspaceId: 'ws_1', status: 'open' })
    expect(open.length).toBe(1)
    expect(open[0].id).toBe(openGap.id)
  })

  test('resolve gap converts answer to fact', () => {
    const gap = service.create({ content: 'Q1', workspaceId: 'ws_1', source: 'user' })
    const resolved = service.resolve(gap.id, '中位 PFS 14.2 个月')

    expect(resolved.status).toBe('answered')
    expect(resolved.answerId).toBeTruthy()

    const fact = factsStore.get(resolved.answerId)
    expect(fact.content).toBe('中位 PFS 14.2 个月')
    expect(fact.sourceType).toBe('knowledge_gap')
  })

  test('ignore gap changes status', () => {
    const gap = service.create({ content: 'Q1', workspaceId: 'ws_1', source: 'user' })
    const ignored = service.ignore(gap.id)
    expect(ignored.status).toBe('ignored')
  })
})
```

### 3.4 单元测试：与 `detectGap` 集成

```typescript
describe('detectGap → KnowledgeGap', () => {
  test('detected gap is persisted', () => {
    const gap = detectGap('我不知道 ZQ 的 PFS 是多少')
    expect(gap).toBeTruthy()

    const stored = service.list({ status: 'open' })
    expect(stored.some(g => g.content.includes('PFS'))).toBe(true)
  })

  test('auto-resolved gap is not persisted', () => {
    // If LLM provides an answer in the same turn, gap may be auto-resolved
    const gap = detectGap('ZQ 的 PFS 是 14.2 个月', { withAnswer: true })
    expect(gap).toBeNull()
  })
})
```

### 3.5 API 测试

```typescript
describe('Knowledge Gap API', () => {
  test('GET /api/v1/knowledge/gaps returns list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/knowledge/gaps',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).gaps).toBeDefined()
  })

  test('POST /api/v1/knowledge/gaps/:id/answer resolves gap', async () => {
    const gap = await createTestGap()
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/knowledge/gaps/${gap.id}/answer`,
      headers: { ...await authHeader(), 'content-type': 'application/json' },
      payload: { answer: '中位 PFS 14.2 个月' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).status).toBe('answered')
  })
})
```

---

## 4. Chat Orchestrator 回归测试

### 4.1 目标

确保 Router 和 Command Handler 接入 chat pipeline 后，不破坏：
- 普通患者查询
- 文件/图片分析
- Facts 被动提取（每 5 轮）
- Profile 更新
- SSE 流格式

### 4.2 单元测试：`chat.orchestrator.ts`

```typescript
describe('chat orchestrator — knowledge evolution integration', () => {
  test('normal patient query does not trigger LLM classifier', async () => {
    const spy = vi.spyOn(llmClassifier, 'classify')
    await sendChat('ZL 的年龄')
    expect(spy).not.toHaveBeenCalled()
  })

  test('knowledge command is routed to handler, not chat LLM', async () => {
    const spy = vi.spyOn(knowledgeCommandHandler, 'handle')
    await sendChat('搜索我的知识库关于 NSCLC')
    expect(spy).toHaveBeenCalled()
  })

  test('mixed query uses both sql and vector routes', async () => {
    const result = await sendChat('总结 ZL 的 NSCLC 治疗')
    expect(result.usedRoutes).toContain('sql')
    expect(result.usedRoutes).toContain('vector')
  })

  test('facts extraction still runs every 5 turns', async () => {
    const spy = vi.spyOn(factExtractor, 'extract')
    for (let i = 0; i < 6; i++) {
      await sendChat(`turn ${i}`)
    }
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
```

### 4.3 回归测试脚本扩展

在 `scripts/regression-test.sh` 末尾新增以下测试：

```bash
# ═══ 17. Query Router & Knowledge Commands ═══
# 17.1 普通患者查询仍然正常
CHAT_QR=$(curl -sf -N -X POST "$BASE/api/v1/agent/chat" -H "$H" -H "Content-Type: application/json" -d "{\"text\":\"ZQ今年几岁？\"}" 2>/dev/null)
check "17.1 Normal patient query still works" "$(echo "$CHAT_QR" | grep -q 'turn_complete' && echo ok || echo 'FAIL')"

# 17.2 显式知识库命令被识别并处理
CHAT_KB=$(curl -sf -N -X POST "$BASE/api/v1/agent/chat" -H "$H" -H "Content-Type: application/json" -d "{\"text\":\"记住：ZQ对osimertinib不耐受\"}" 2>/dev/null)
check "17.2 kb_remember command handled" "$(echo "$CHAT_KB" | grep -q 'kb_remembered\|已记录' && echo ok || echo 'FAIL')"

# 17.3 搜索知识库
CHAT_SEARCH=$(curl -sf -N -X POST "$BASE/api/v1/agent/chat" -H "$H" -H "Content-Type: application/json" -d "{\"text\":\"搜索我的知识库关于osimertinib\"}" 2>/dev/null)
check "17.3 kb_search command handled" "$(echo "$CHAT_SEARCH" | grep -q 'kb_search_result\|找到' && echo ok || echo 'FAIL')"

# ═══ 18. Knowledge Gap ═══
# 18.1 列出 gaps
check "18.1 List knowledge gaps" "$(curl -sf "$BASE/api/v1/knowledge/gaps" -H "$H" | python3 -c "import sys,json; print('ok' if 'gaps' in json.load(sys.stdin) else 'FAIL')" 2>/dev/null)"

# 18.2 回答一个 gap（先创建再回答）
GAP_CREATE=$(curl -sf -X POST "$BASE/api/v1/knowledge/gaps" -H "$H" -H "Content-Type: application/json" -d '{"content":"测试未解问题"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$GAP_CREATE" ]; then
  GAP_ANSWER=$(curl -sf -X POST "$BASE/api/v1/knowledge/gaps/$GAP_CREATE/answer" -H "$H" -H "Content-Type: application/json" -d '{"answer":"测试答案"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  check "18.2 Resolve knowledge gap" "$([ "$GAP_ANSWER" = "answered" ] && echo ok || echo 'FAIL')"
else
  check "18.2 Resolve knowledge gap" "FAIL: gap not created"
fi
```

---

## 5. 成本可观测性测试

### 5.1 目标

确保 Router 真的能降低成本，且 LLM fallback 可被监控。

### 5.2 单元测试

```typescript
describe('cost observability', () => {
  test('rule hit does not consume LLM budget', () => {
    const result = router('ZL 的年龄')
    expect(result.llmFallback).toBe(false)
    expect(result.cost.llmCalls).toBe(0)
  })

  test('LLM fallback is recorded', async () => {
    const result = await router('那个患者最近咋样')
    expect(result.llmFallback).toBe(true)
    expect(result.cost.llmCalls).toBe(1)
  })

  test('knowledge command only charges when user triggers', async () => {
    // Normal chat should not call KB search
    const normal = await sendChat('你好')
    expect(normal.kbCommands).toEqual([])

    // Explicit command should call KB handler
    const cmd = await sendChat('搜索知识库 NSCLC')
    expect(cmd.kbCommands).toEqual(['kb_search'])
  })
})
```

---

## 6. 测试数据与 Stub

### 6.1 不依赖外部 LLM

- `classifyQueryLLM` 必须可注入 mock provider。
- `factExtractor` 使用固定返回的 mock：
  - 输入包含"耐受" → 返回 `{ content: '...不耐受', confidence: 0.92 }`
  - 输入包含"可能也许" → 返回 `{ content: '...', confidence: 0.65 }`
- `memoryProjection.search` 使用 in-memory 向量 stub：
  - 查询包含"NSCLC" → 返回 2 条硬编码结果
  - 查询包含"xyz123" → 返回空

### 6.2 测试 Context

```typescript
interface TestCommandContext {
  workspaceId: string
  userId: string
  factsStore: FactsStore
  gapService: KnowledgeGapService
  memoryProjection: MemoryProjectionStub
  llmClassifier: LLMClassifierStub
  factExtractor: FactExtractorStub
}
```

---

## 7. 实施顺序（TDD）

```
Step 1: 写 Query Router 扩展测试
        → 实现 classifyQuery 规则层 + LLM fallback 接口

Step 2: 写 Knowledge Command Handler 测试
        → 实现 parse + handle 函数

Step 3: 写 Knowledge Gap Service 测试
        → 实现 Gap model / service / API

Step 4: 写 Chat Orchestrator 集成测试
        → 把 Router + Handler 接入 chat pipeline

Step 5: 写回归测试扩展
        → 运行完整 regression-test.sh 通过

Step 6: 写成本可观测性测试
        → 确认 baseline 成本不增加
```

---

## 8. 验收标准

- [ ] `query-router.test.ts` 新增测试全部通过
- [ ] `knowledge-command-handler.test.ts` 新建并全部通过
- [ ] `knowledge-gap-service.test.ts` 新建并全部通过
- [ ] `chat-context.test.ts` 或新增 `chat-orchestrator.test.ts` 通过
- [ ] `scripts/regression-test.sh` 全部通过（含新增 17.x / 18.x）
- [ ] 规则层命中率 ≥ 80%（通过测试中的 sample 集验证）
- [ ] 普通聊天不触发 LLM classifier（mock 验证）
- [ ] 显式命令不破坏 SSE 流格式
