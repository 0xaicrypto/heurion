# Heurion 2.0 设计

**Status:** v0.2 协作编辑框架（2026-09-30）
**底座:** DeepSeek Harness（dsh）TypeScript SDK `@deepseek-ai/dsh-sdk-client@0.2.0-rc.2`（npm `next` 标签，MIT）

## 1. 定位

让用户用 AI 快速编辑 Word/PPT 医学文档，并在编辑过程中检索和规范引用医学文献。

产品目标——**评论驱动的并行协作编辑框架**：

1. **用户手动编辑与 AI 修改并行**：同一份文档两个写者（人改 / AI 改），按节点合并、用户优先，互不推倒；
2. **评论是给 AI 的带锚点编辑指令**：用户在编辑面选中内容写评论，AI 经评论工具读取结构化锚点并据此修改，不靠复述原文；
3. **初稿可由 AI 全文生成**：draft 是三条写路径之一，不是特殊通道。

原则：**执行层归 dsh，管理面归 heurion**（§3）。通用智能体能力（对话循环、工具执行、LLM 调用、office 读写）全部交给 dsh；heurion 只做真相存储、版本、评论、锚点与合并治理、审计和前端。

## 2. 架构

```
apps/web（React/Vite：编辑面 + 评审面 + 评论 + 聊天）
   │  REST + SSE（/api）
   ▼
apps/server（Node, Hono）—— 管理面
   ├─ Store（node:sqlite）：docs / versions / messages / citations / comments
   ├─ DocFiles：版本库（权威文件，内嵌持久 id）↔ 工作区（dsh 执行现场）
   ├─ Projection：每版本导入生成的派生视图（节点 id / 文本 / 样式 / 几何）
   ├─ Merge：写后合并治理（用户 ops × AI 变更，按节点 id 三方合并，用户优先）
   ├─ TurnService：物化 head → dsh 回合 → 引用/锚点审计 → 合并 → 落版本
   ├─ HarnessPool：每个文档一个 dsh 子进程（SDK stdio JSON-RPC）
   └─ /mcp：医疗文献 MCP（PubMed / Crossref / insert_citation / list_citations）
             + 评论三工具（list_comments / reply_comment / resolve_comment）
          ▲
          │ streamable-http，Bearer <按文档签发的 HMAC 令牌>
   dsh 子进程（执行层：office 技能 / python-docx / python-pptx，直接编辑工作区文件）
```

## 3. 关键决策

| 决策 | 选择 | 原因 / 代价 |
|---|---|---|
| 对接方式 | TS SDK | 与前后端同一技术栈。代价：SDK 协议**没有取消**，也**没有权限回调**（详见 §9） |
| 进程粒度 | 每个文档一个 dsh 进程 | SDK 的工作区是进程级的（`initialize` 时固定 cwd）；MCP 令牌也通过进程 env 按文档注入 |
| 取消 | 关闭该文档的进程 | 下次请求用同一个 sessionId 续上会话（会话持久化在 `dsh-home`） |
| 空闲回收 | 默认 10 分钟（`HARNESS_IDLE_MS`） | 冷启动实测约 0.6–0.8s（macOS arm64，未加载 office 技能） |
| 权威文件 | heurion 的版本库，文件内嵌持久 id | 工作区是一次性的；每回合开始把 head 版本覆盖写入工作区 |
| 版本 | AI 回合快照与用户保存各落一版；回滚 = 把旧版本复制成新 head | 历史只增不改；AI 侧撤销粒度是整回合 |
| 寻址 | id 在文件里（docx 用 `w14:paraId`，pptx 用原生 shape id），模型不参与寻址 | 管理面按 id diff 自知「谁改了什么」，消灭「模型复述原文失配」这一类错误 |
| AI 编辑方式 | dsh 内 python / office 技能直接改文件 | 执行层归 dsh；heurion 不建 AI 侧 ops 执行器 |
| 守卫 | 写后合并、用户优先（§4.3） | 写者是 dsh，管理面没有写前拦截点；合并即治理 |
| 用户编辑应用 | TipTap 编辑投影视图 + 服务端 XML 手术补丁（§4.2） | 用户键入是毫秒级交互，不能走 AI 回合；理由见 §4.2 |
| 评论 | 一等输入：锚点 + MCP 三工具（§4.4） | 评论内容是结构化编辑指令，不再由前端拼自然语言 |
| 流式 | 按「步」推送 | dsh 的 `session.event` 是已提交的会话日志事件，没有逐 token 的增量 |
| 数据外发 | profile 去掉 `session-log-deepseek`，关闭 web 工具 | 该插件默认随 DeepSeek 官方请求上传会话日志；外部检索统一经 /mcp |
| 子进程 env | 显式白名单 | 不继承父进程的其他密钥 |

## 4. 统一编辑框架

### 4.1 身份：持久 id 在文件里

- **docx**：段落 id 用 OOXML 原生 `w14:paraId`（Word 2010+ 协同编辑的官方锚点机制）。导入时提取；缺失则服务端分配；重复（模型复制段落）则检测并重分配。python-docx 不触碰未修改段落的 XML 属性，id 天然跨 AI 编辑稳定。
- **pptx**：形状 id 原生（`p:cNvPr@id`）；寻址用复合 id `slidePart#cNvPr@id`（页内唯一、跨编辑稳定）；页 id = slide part 路径。
- **投影 schema（v1）**：`{ nodes: [{ id, kind: heading|paragraph|list|table|opaque, level?, text, runs?, geometry?(pptx), locked? }], slides? }`。投影**不是真相**，是每版本导入生成的派生视图，服务前端渲染 / TipTap 绑定 / diff / 锚点审计。schema 覆盖不到的内容（SmartArt、域代码等）落为 `opaque` 锁定块：可评论、不可编辑。

### 4.2 三条写路径

| 路径 | 执行者 | 流程 |
|---|---|---|
| ① draft 全文生成 | dsh | 模型在 dsh 里生成整个 docx/pptx → 快照 → 导入投影并分配缺失 id → v1 |
| ② 用户手动编辑 | heurion 管理面 | TipTap 编辑投影视图 → 保存 = 节点 ops → XML 补丁器把 ops 打回权威文件，只重写被触碰的节点，其余字节不动；deck 用 pptx-react-viewer 字节回写 + 版本乐观锁 |
| ③ 评论驱动修改 | dsh | 评论触发 turn → 模型 `list_comments` 拿锚点与指令 → 在 dsh 内用 python 改文件 → `reply_comment` 说明 → 快照 |

XML 补丁器由管理面自研的理由（按协作约定记录）：用户编辑是毫秒级交互，不能排队等 AI 回合；「保真 + 字级编辑」要求保存时不重排文件其余部分，而往返式编辑器（docx→HTML→docx）每次保存整文件重序列化、样式必然漂移。故只做**节点级手术补丁**（替换段落文本/样式、增删段落、表格单元格编辑），预估 1–2k 行；schema 外内容锁定不可编辑，保真不受影响。

### 4.3 守卫 = 写后合并（用户优先）

AI 直接改文件，管理面没有写前拦截点，守卫放在**写后合并**：

- **第一步（S4 交付）**：AI 回合窗口内暂停用户保存（busy 锁）；回合快照时 head 已被用户推进 → 拒绝落版、提示重试。
- **第二步（S5 交付）**：按节点 id 三方合并——base 投影 × 用户 ops × AI 变更：异节点双方保留；同节点冲突**用户赢**，AI 该节点改动丢弃并在线程里说明；合并后重跑锚点漂移审计。
- deck 的形状级细粒度并行暂缓（依赖把 deck AI 编辑收进 MCP 工具，待评测后决策）。

### 4.4 评论闭环

数据模型：

```
comments(id, doc_id, kind, anchor_json, status open|resolved, resolved_by user|ai, created_at)
  anchor_json = { para_id? , shape_id?, slide_id?, text_snippet, section_index? }
comment_replies(id, comment_id, role user|ai, text, created_at)
```

MCP 工具（docId 从按文档令牌派生，评论按 id + docId 双重过滤，防跨文档枚举）：

- `list_comments({status?, comment_id?})` — open 线程附锚点诊断：`located` 布尔 + 漂移时给最近候选文本（模型一次修正，不盲猜）；
- `reply_comment({comment_id, text})` — role 服务端固定 `'ai'`，模型不可自封用户；
- `resolve_comment({comment_id})` — 前置：线程最后一条回复是 AI（仅用于「无需改动、已说明」的收口）；用户可随时 reopen。

流程：评论创建 → 触发 turn（复用 `POST /api/docs/:id/chat`，prompt 由服务端组装，含 commentId 上下文）→ 模型读锚点 → dsh 改文件 → `reply_comment` → 快照合并 → `comment_updates` 事件 → 前端刷新线程与高亮。

### 4.5 锚点保护：软门 + 审计

- **软门**：系统人设纪律——删除/整替内容前先 `list_comments` 核对该范围 open 评论的锚点；会清空锚点时先 `reply_comment` 说明，或缩小改法保留锚点原文。
- **硬检测**：每次版本落库后重跑锚点漂移审计（与引用审计同一位置）——open 评论的锚点在新版投影中定位失败 → 线程标「漂移」徽标。
- **兜底**：整轮回滚（版本恢复）。

## 5. 前端形态

三栏：文档列表 ｜ 编辑/评审面 ｜ 聊天 + 评论 + 版本。

| 区 | doc | deck |
|---|---|---|
| 编辑面 | TipTap 绑投影（标题/段落/列表/表格/引用标记；`opaque` 锁定块只读），选中文本写评论 | pptx-react-viewer `canEdit`：字节回写、乐观锁、dirty 守卫、冲突横幅；点选形状写评论 |
| 评审面 | 段落级 diff（新增/删除/改动，对照上一版投影） | Konva 只读画布：形状三态 diff（added/removed/modified）+ 评论锚点两态 overlay，点击联动评论线程 |
| 评论面板 | 线程列表（open/resolved、AI 回复、漂移徽标、「AI 处理中」状态） | 同左 |

样式沿用 CSS 变量极简风 + 语义 token：三态 diff 色（added 绿 / removed 红 / modified accent）、锚点两态（常态 accent / 漂移 warning）、AI 单强调色、暗色跟随。新增依赖：`@tiptap/react` 系、`pptx-react-viewer`、`react-konva`。

## 6. 事件契约增量

| 事件 | 说明 |
|---|---|
| `comment_updates` | 回合结束时推送：本回合被回复/关闭/漂移的线程列表 |
| `tool_result.code` | MCP 工具显式失败码（如 validation_error / unit_not_found），前端展示具体原因而非模糊失败 |
| `merge_result`（S5） | 合并治理结果：AI 改动被用户改动覆盖的节点清单 |

## 7. 引用规范

1. 模型只能通过 `insert_citation(doi)` 登记引用：DOI 必须在 Crossref 查得到，否则拒绝登记；同一文档同一 DOI 只登记一次，按登记顺序编号。
2. 回合结束后抽取正文文本（`word/document.xml` 和 `ppt/slides/*.xml`），文中出现未登记的 DOI 即判为违规。
3. 违规时让模型自修一次（登记或删除，再按 `list_citations` 重建参考文献表）；仍违规就丢弃本回合的文件改动。
4. 已知不足：只能识别**带 DOI** 的引用。没有 DOI 的手写参考文献条目还识别不了，后续需要解析参考文献段落。

## 8. Office 运行时（未解决，M1 的首要任务）

dsh 的 office 技能（python-docx / python-pptx / openpyxl + LibreOffice 渲染）要求 `DSH_PRIMARY_RUNTIME` 指向一个 `primary-runtime/` 目录（CPython + 锁定版本的 office Python 库 + 独立 Node），其同级还要有 `office-skills/`。

- 这套运行时目前**只随 Python wheel 发布**（`deepseek-harness-runtime-bin`），而 PyPI 上最新是 **0.1.5rc1**，和 npm 上的 0.2.0-rc.2 **版本对不上**。
- TS SDK 不负责解析这套运行时（`packages/sdk/client/README.md` Known Limitations）。
- 候选方案：
  - (a) 从 dsh 源码按 `scripts/primary-runtime/` 构建同版本运行时，放进 Docker 镜像；
  - (b) 等 PyPI 发布 0.2.x 后，从 wheel 里取出运行时目录；
  - (c) 用自己的 Python venv 并关掉 skill-office，自写一份 office 技能（维护成本最高）。
- 当前状态：`DSH_PRIMARY_RUNTIME` 为空时，office 技能不加载，模型只能用 shell 和 Python 自行处理文件。**AI 编辑 docx/pptx 的质量要等运行时就位后才能评测。**
- 与协作框架的关系：office 运行时阻塞 **AI 编辑质量**评测，不阻塞 S1–S5（投影/评论/编辑面/合并均可先行开发）。

## 9. 已知限制与后续

| 限制 | 影响 | 计划 |
|---|---|---|
| 没有多用户鉴权（单一开发令牌） | 只能本地使用 | M2：账户、按用户划分数据，每用户一个容器 |
| 进程没有隔离（dsh 以 danger-full-access 运行） | 模型能访问 dsh 进程可见的所有路径 | M2：每用户一个容器，只挂载该用户的工作区，网络出口只放行 LLM 端点和 /mcp |
| SDK 没有权限回调 | 无法逐次审批工具调用 | 靠容器隔离兜底；若需要逐次审批，改用 ACP（多会话、取消、权限回调都支持） |
| 取消 = 关闭进程 | 取消后下次请求要冷启动（亚秒级） | 可接受 |
| 锚点保护是软门 | AI 可能清空评论锚点后才被发现 | 漂移审计显式标注 + 整轮回滚兜底；评测触规率后决定是否升级硬闸（MCP commit_edit） |
| AI 回合窗口内用户保存被暂停（S4 阶段） | 伪并行 | S5 三方合并落地后解除 |
| 编辑器是结构级保真视图（字体/页面观感有损） | 编辑面不等于排版定稿 | 高保真查看（LibreOffice 渲染 PNG/PDF）后置为叠加查看模式 |
| 投影 schema 外内容不可编辑 | SmartArt、域代码等锁定 | 可评论不可编辑；schema 按需扩展 |
| pptx-react-viewer 许可未核查 | S4 前的 go/no-go 项 | 核查商用条款；不通过则降级为 Konva 只读 + 简化编辑 |
| dsh 0.x 会有不兼容变更 | 升级可能出问题 | 锁定精确版本（`0.2.0-rc.2`）；升级单独提交，并跑冒烟和评测 |

## 10. 里程碑

- **M0（已完成）**：SDK 接入、文献 MCP、引用校验、版本和回滚、精简前端。✅ 类型检查、单元测试、SDK 握手冒烟、MCP 实测（PubMed 和 Crossref 真实请求）全部通过。
- **S1 id 底座**：docx 导入（`w14:paraId` 提取/补号/去重）→ 投影；pptx 投影（shapeId）；版本快照接投影。
- **S2 评论底座**：评论表 + REST + MCP 三工具 + 评论面板（选中即评）+ 锚点漂移审计。
- **S3 AI 闭环**：评论触发 turn（服务端组装 prompt）+ 人设纪律（锚点核对 + 引用规范）+ draft 路径 + `comment_updates` / `tool_result.code` 事件。
- **S4 用户编辑面**：TipTap + XML 补丁器（段落/列表 → 表格分步）+ busy 锁；deck viewer 接入（乐观锁保存）。
- **S5 并行合并 + 评审**：三方合并 + 冲突 UI + Konva 审查画布 + 形状三态 diff + 线程归因。
- **M1 可用**（与 S 线并行）：office 运行时就位（§8）、真实文档评测（编辑延迟 p50/p95、格式保真、任务完成率、引用正确率、锚点触规率）。
- **M2 上线前**：多用户、容器隔离、网络出口白名单、审计日志、PHI 扫描。
