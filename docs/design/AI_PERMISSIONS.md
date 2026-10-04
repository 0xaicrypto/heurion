# AI 的权限 = 用户的权限

AI 以当前用户的身份、按用户的角色行事：用户在界面上能做的事，AI 都能通过 MCP 做；用户不能做的，AI 也不能做。机构管理员的 AI 能管理机构，平台运营的 AI 能做平台运营。高风险操作由 AI 发起，用户确认后才执行。

## 实现：同一套接口

- 管理类 MCP 工具（`src/mcp/admin-tools.ts`）不另写权限逻辑。每个动作映射到一个 HTTP 接口，由进程内调用（`src/http/invoke.ts`）以用户身份交给同一个 Hono 应用处理。所以鉴权、机构 / 研究 / 患者权限、审计规则和界面完全一致。
- 进程内调用带一个只在本进程内存里的随机密钥（每次启动重新生成）。网络上的请求伪造这个头时一律当作未登录。
- 审计新增两个字段：`via`（`ai` 表示 AI 直接执行；`ai-confirmed` 表示 AI 发起、用户确认后执行）和 `confirmed_by`。AI 的每一次写操作都写审计。
- 患者操作的来源：AI 直接调用时按 AI 算，仍受「AI 写入需确认」（ai_patient_writes）审核门约束；AI 发起并经用户确认的，按用户本人算。

## 工具

| 工具 | 直接做 | 需用户确认 |
|---|---|---|
| account | view、update_profile | logout_everywhere |
| tenant_admin | view、members、invites、revoke_invite、audit、colleagues、studies | update_settings、set_member、invite、handover |
| org_template | list、create、update | delete、set_logo、clear_logo |
| platform_admin | tenants、users、settings、audit | create_tenant、set_tenant_status、update_user、logout_user、update_settings |
| doc_manage | import、rename、move_project、duplicate、trash（进回收站，可恢复）、trash_list、restore、save_version、restore_version、revert_turn、export | purge |
| project_manage | list、create、rename、delete（文档回到未分组） | — |
| comment_manage | create、resolve、reopen | delete |
| dataset_manage | upload、rename、resolve_phi | delete |
| kb_manage | list、status、upload、update | delete |
| memory_manage | list、events、edit、pause、resume、export、import | clear_all |
| patient_admin | directory | break_glass（用户可在确认卡上改理由）、delete |
| study_admin | — | delete、transfer |
| task_queue | list、cancel | — |
| asset_provenance | read | — |
| action_status | 查待确认操作的状态 | — |

`study_members` 去掉了 transfer，改由 `study_admin.transfer` 处理（需确认）。

需要确认的类别：
- 不可恢复的删除；
- 权限与安全（机构设置、成员角色、邀请、紧急访问、交接与转交、平台运营的全部写操作）；
- 以机构身份对外的标识（院徽）。

## 待确认操作

- 存在 `pending_actions` 表里，保存工具、动作、HTTP 方法、路径、请求体、给用户看的说明、AI 的理由、可编辑字段和状态。状态有 pending、running、done、failed、rejected、expired。
- AI 调用时只生成记录，返回 `pending_confirmation` 和 `action_id`，并在当前对话里推送一张确认卡。
- 如果用户本身没有这个权限（例如非管理员调用机构管理），直接报 forbidden，不生成确认卡。删除前会先探测资源是否存在，不存在的不生成。
- 确认 / 拒绝接口 `POST /api/actions/:aid/confirm|reject` 只接受用户本人的登录会话：AI 的进程内调用返回 403，伪造的头返回 401，别人返回 404。确认后以用户身份执行同一个接口；同一条不能确认两次。
- 24 小时过期。
- 全局入口：头像上的红点，以及菜单里的「待确认操作」。

## 不给 AI 的

见 `tests/parity.test.ts` 的 NOT_FOR_AI，每一项都写了理由：
- 采纳 AI 自己的提议、修订、记忆整理建议，以及确认 AI 自己发起的操作，都是人的事；
- 密码、验证码、注册、邮箱绑定这类凭证操作 AI 不经手；
- 开始 / 停止 / 重跑 AI 对话的入口；
- 只用于界面显示的接口：SSE 事件流、图片字节、登录页配置。

## 测试

- `tests/parity.test.ts`：枚举全部 `/api` 路由，每条要么映射到工具（或「工具.动作」，并核对这个动作调用的正是该接口），要么在 NOT_FOR_AI 里写明理由。AI_CONFIRM 表与工具定义里的 confirm 标记必须一致。
- `tests/ai-permissions.test.ts`：
  - 非管理员的 AI 被拒；管理员的 AI 直接操作时审计 via=ai；
  - 高风险操作只生成卡片，AI 和别人都不能确认，伪造的头被拒；
  - 用户确认后执行，审计记为 ai-confirmed；
  - 拒绝、过期；平台运营；院徽文件只能来自工作区。
- `tests/isolation.test.ts`：登记了新工具的 id 参数和 `/api/actions` 路由。MCP 越权测试接上了进程内调用，管理类工具真正走权限判定。
- `scripts/ui-accounts.ts`：平台运营的 AI 发起「新建机构」→ 头像红点 → 用户在「待确认操作」里确认 → 生效，审计记为 ai-confirmed。
